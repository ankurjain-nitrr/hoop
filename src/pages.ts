import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { request } from "node:http";
import type { Server } from "node:http";
import { Hoop, PORT } from "./hoop.js";
import { liveSessions, type Session, startCommand, storeKey } from "./sessions.js";
import { hoopHome } from "./util.js";
import { codeId, isNewer, ownInstall, release } from "./version.js";
import { type PagesOptions, startWeb } from "./web.js";

/** What answers on the usual address: hoop's pages (with their info), an older hoop, nothing, or something else. */
export type Probe = { kind: "pages"; info: PagesInfo } | { kind: "old" } | { kind: "none" } | { kind: "other" };
export type PagesInfo = { hoop: "pages"; store: string; release?: string; code?: string; pid: number; stale: boolean };

/** How a session stands with the pages: served for its store, just started, or not available to it. */
export type PagesStatus = "serving" | "started" | "old" | "unavailable" | "failed" | "off";
/** What a result with a link carries when its pages can't be served. */
export type PagesNotice = { status: "old" | "unavailable" | "failed"; message: string };

const PROBE_TIMEOUT_MS = 1000;

/**
 * Appends a pages process event to ~/.hoop/pages.jsonl. The process runs detached with no output,
 * so this is where its starts, restarts and stops show. Never throws.
 */
function logPages(event: string, data: Record<string, unknown> = {}): void {
  try {
    mkdirSync(hoopHome(), { recursive: true });
    appendFileSync(join(hoopHome(), "pages.jsonl"), JSON.stringify({ at: new Date().toISOString(), event, ...data }) + "\n");
  } catch {
    /* best effort */
  }
}

/** What the address is, from its answer to `/api/info`. */
function probeAnswer(status: number | undefined, body: string): Probe {
  let info: any;
  try {
    info = JSON.parse(body);
  } catch {
    return { kind: "other" };
  }
  if (status !== 200 || !info || typeof info !== "object" || Array.isArray(info)) return { kind: "other" };
  if (info.hoop === "pages" && typeof info.store === "string" && Number.isInteger(info.pid)) return { kind: "pages", info };
  // A hoop from before the pages process answers this route with its repository only.
  return Object.keys(info).every((k) => k === "repo") ? { kind: "old" } : { kind: "other" };
}

/** Asks the address what it is, waiting at most `timeoutMs`. */
export function probe(port = PORT, timeoutMs = PROBE_TIMEOUT_MS): Promise<Probe> {
  return new Promise((resolve) => {
    let done = false;
    // The request's own timeout only covers idle time, so a holder that trickles bytes needs this deadline.
    const deadline = setTimeout(() => {
      req.destroy();
      finish({ kind: "other" });
    }, timeoutMs);
    const finish = (p: Probe) => {
      if (!done) {
        done = true;
        clearTimeout(deadline);
        resolve(p);
      }
    };
    const req = request({ host: "127.0.0.1", port, path: "/api/info", headers: { host: `localhost:${port}` }, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        body += d;
        if (body.length > 100_000) req.destroy();
      });
      res.on("end", () => finish(probeAnswer(res.statusCode, body)));
      res.on("error", () => finish({ kind: "other" }));
    });
    req.on("timeout", () => {
      req.destroy();
      finish({ kind: "other" });
    });
    req.on("error", (err: NodeJS.ErrnoException) => finish(err.code === "ECONNREFUSED" ? { kind: "none" } : { kind: "other" }));
    req.end();
  });
}

/** Starts this install's pages process in the background, detached from the caller. */
export function startPages(command = startCommand()): ChildProcess {
  const [bin, ...args] = command;
  const child = spawn(bin!, [...args, "serve"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HOOP_PAGES: "background" },
  });
  child.on("error", (err) => logPages("pages_start_failed", { ok: false, error: err.message }));
  child.unref();
  return child;
}

/**
 * True when something listens on the IPv6 loopback address at `port`. The pages listen on
 * 127.0.0.1 only, but a browser may try `localhost` over IPv6 first and reach that program instead.
 */
export function ipv6Held(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "::1", port, timeout: 300 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

const START_WAIT_MS = 6000,
  START_POLL_MS = 200;
/**
 * The pages this process started, by port: when, and how the start ended if it failed. Every
 * call waiting on that start reads it, so a crash reaches each of them with its error.
 */
type Start = { at: number; ended?: string; logged?: boolean };
const starts = new Map<number, Start>();

/**
 * Makes sure the usual address serves this store's pages before a link is given. It reuses a pages
 * process for the same store, and starts one when nothing answers. With `wait`, it waits for the
 * new process to answer, so a start that fails is reported. Anything else on the address, on
 * either loopback address, is left alone, and the pages aren't started. `HOOP_PAGES=off` skips it.
 */
export async function ensurePages(
  home: string,
  port = PORT,
  opts: { wait?: boolean; start?: () => ChildProcess | undefined; waitMs?: number } = {},
): Promise<{ status: PagesStatus; notice?: PagesNotice }> {
  if (process.env.HOOP_PAGES === "off") return { status: "off" };
  const [p, v6] = await Promise.all([probe(port), ipv6Held(port)]);
  const store = storeKey(home);
  if (v6) return notice("unavailable", port, "another program");
  if (p.kind === "pages" && p.info.store === store) return { status: "serving" };
  if (p.kind !== "none") return heldNotice(p, port);
  // A start this process made a moment ago may still be binding, so it isn't started twice.
  const st = startOnce(port, opts.start ?? startPages);
  if (!opts.wait) return { status: "started" };
  return awaitStart(port, store, st, opts.waitMs ?? START_WAIT_MS);
}

/** Waits up to `waitMs` for a pages process just started to answer for `store`, or says why it didn't. */
async function awaitStart(port: number, store: string, st: Start, waitMs: number): Promise<{ status: PagesStatus; notice?: PagesNotice }> {
  for (const end = Date.now() + waitMs; Date.now() < end; await new Promise((r) => setTimeout(r, START_POLL_MS))) {
    const q = await probe(port);
    if (q.kind === "pages" && q.info.store === store) return { status: "started" };
    if (q.kind !== "none") return heldNotice(q, port);
    if (st.ended) break;
  }
  // A start that is only slow is told apart from one that failed. Each failure is recorded once.
  const why = st.ended ?? `didn't answer within ${waitMs / 1000} seconds`;
  if (!st.logged) logPages("pages_start_failed", { ok: false, error: why });
  st.logged = true;
  return notice("failed", port, why, Boolean(st.ended));
}

/** The notice for an address something other than this store's pages holds: an older hoop, another store's pages, or another program. */
function heldNotice(p: Probe, port: number) {
  if (p.kind === "old") return notice("old", port, "another program");
  return notice("unavailable", port, p.kind === "pages" ? "another hoop store" : "another program");
}

/** Starts the pages process, unless this process started one a moment ago; the start, which records how it ended. */
function startOnce(port: number, launch: () => ChildProcess | undefined): Start {
  const st = starts.get(port);
  if (st && Date.now() - st.at <= START_WAIT_MS) return st;
  const start: Start = { at: Date.now() };
  starts.set(port, start);
  const child = launch();
  // A start that failed can be tried again by the next call; calls already waiting keep its error.
  const end = (why: string, logged = false) => {
    if (start.ended) return;
    Object.assign(start, { ended: why, logged });
    if (starts.get(port) === start) starts.delete(port);
  };
  child?.once("error", (err) => end(err.message, true));
  child?.once("exit", (code, signal) => end(`the pages process exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
  return start;
}

function notice(status: PagesNotice["status"], port: number, who: string, crashed = true): { status: PagesStatus; notice: PagesNotice } {
  const message =
    status === "old"
      ? `The review pages aren't served for this session: an older hoop that can't restart itself is using port ${port}. Restart the session or the hoop serve that runs it.`
      : status === "failed"
        ? crashed
          ? `The review pages couldn't start on port ${port}: ${who}. Run hoop serve to see the error.`
          : `The review pages didn't answer on port ${port} within ${who.match(/[\d.]+/)![0]} seconds. If they don't open soon, run hoop serve to see the error.`
        : `The review pages aren't served for this session: ${who} is using port ${port}. Set HOOP_PORT to use another port.`;
  return { status, notice: { status, message } };
}

/** How many times the address is tried, a quarter second apart, before giving up: injectable for tests. */
const bindTries = () => Number(process.env.HOOP_PAGES_BIND_TRIES) || 20,
  BIND_DELAY_MS = 250;
const idleMs = () => Number(process.env.HOOP_PAGES_IDLE_MS) || 3_600_000;

/** How often the code is checked, and how long a successor has to answer: injectable for tests. */
const checkMs = () => Number(process.env.HOOP_PAGES_CHECK_MS) || 2000,
  handoverMs = () => Number(process.env.HOOP_PAGES_HANDOVER_MS) || 5000;

/** What a restart runs: a release, its install's code, and the command that starts that install. */
type Target = { release: string; code: string; start: string[] };
type Own = { install: string; release: string; code?: string };

/** A command the pages process can run: a non-empty program name, with no NUL byte anywhere. */
const runnable = (start: string[]) => Boolean(start[0]) && start.every((a) => !a.includes("\0"));

/**
 * What the pages process should run instead of its own code, "gone" when its install is removed and
 * no session is live, or undefined when it is current. It is out of date when the newest release a
 * live session's install holds differs from its own, or when its own files changed. A release is
 * read from the install on disk, because an update in place leaves the session's entry behind.
 */
export function restartTarget(own: Own, sessions: Session[]): Target | "gone" | undefined {
  let newest: { release: string; s: Session } | undefined;
  for (const s of sessions) {
    const r = release(s.install);
    if (r && runnable(s.start) && (!newest || isNewer(r, newest.release))) newest = { release: r, s };
  }
  if (newest && newest.release !== own.release) {
    const code = codeId(newest.s.install);
    return code ? { release: newest.release, code, start: newest.s.start } : undefined;
  }
  const code = codeId(own.install);
  if (!code) return sessions.length ? undefined : "gone";
  return code === own.code ? undefined : { release: release(own.install) ?? own.release, code, start: startCommand() };
}

/**
 * Whether a foreground server's code is out of date, checked on the same timer as the pages
 * process. A foreground server only warns; it never restarts itself.
 */
export function watchStale(hoop: Hoop): () => boolean {
  const install = ownInstall();
  const own: Own = { install, release: release(install) ?? "0", code: codeId(install) };
  let stale = false;
  setInterval(() => {
    try {
      const t = restartTarget(own, liveSessions(hoop.store.home));
      stale = t !== undefined && t !== "gone";
    } catch {
      /* keep the last answer */
    }
  }, checkMs()).unref();
  return () => stale;
}

/** Binds the usual address, retrying for a few seconds, or resolves undefined. */
async function bind(hoop: Hoop, port: number, opts: PagesOptions): Promise<Server | undefined> {
  for (let i = 0, tries = bindTries(); i < tries; i++) {
    const server = await startWeb(hoop, port, opts);
    if (server) return server;
    await new Promise((r) => setTimeout(r, BIND_DELAY_MS));
  }
  return undefined;
}

function stop(reason: string, extra: Record<string, unknown> = {}): never {
  logPages("pages_stop", { reason, ...extra });
  process.exit(0);
}

/**
 * Lets go of the address and starts the target in its place. The old process exits once the target
 * answers for this store. Otherwise it stops the target, binds again, and returns the new server.
 */
async function handOver(t: Target, server: Server, hoop: Hoop, port: number, opts: PagesOptions): Promise<Server> {
  logPages("pages_restart", { release: t.release, code: t.code });
  await new Promise((r) => {
    server.close(r);
    server.closeAllConnections();
  });
  const [bin, ...args] = t.start;
  const child = spawn(bin!, [...args, "serve"], { detached: true, stdio: "ignore", env: { ...process.env, HOOP_PAGES: "background" } });
  child.on("error", () => {});
  child.unref();
  const store = storeKey(hoop.store.home);
  for (const end = Date.now() + handoverMs(); Date.now() < end; await new Promise((r) => setTimeout(r, BIND_DELAY_MS))) {
    const p = await probe(port);
    if (p.kind === "pages" && p.info.store === store && p.info.release === t.release && p.info.code === t.code) stop("restarted", { release: t.release });
  }
  // A successor that answers just after the deadline still takes over.
  const last = await probe(port);
  if (last.kind === "pages" && last.info.store === store && last.info.release === t.release && last.info.code === t.code)
    stop("restarted", { release: t.release });
  // The successor runs in its own process group, so this also stops anything it started. A child
  // that already exited is skipped, because its process ID may belong to another process by now.
  if (child.pid && child.exitCode === null && child.signalCode === null)
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  const again = await bind(hoop, port, opts);
  if (!again) {
    const p = await probe(port);
    stop(p.kind === "pages" && p.info.store === store ? "replaced" : "address taken");
  }
  logPages("pages_fallback", { release: t.release, code: t.code });
  return again;
}

/** After a failed handover: binds the address again when it was let go, or stops when another process took it. */
async function serveAgain(hoop: Hoop, port: number, opts: PagesOptions, server: Server): Promise<Server | undefined> {
  if (server.listening) return server;
  const again = await bind(hoop, port, opts).catch(() => undefined);
  if (!again) {
    const p = await probe(port);
    stop(p.kind === "pages" && p.info.store === storeKey(hoop.store.home) ? "replaced" : "address taken");
  }
  return again;
}

/**
 * The background pages process: it binds the usual address, retrying for a few seconds. It exits
 * after the idle time with no live session and no request from a page. Its own timer restarts it
 * into current code, once for each change, and no request can.
 */
export async function runPages(hoop = new Hoop(), port = PORT): Promise<void> {
  let lastUse = Date.now(),
    stale = false,
    busy = false,
    checks = 0;
  const opts: PagesOptions = {
    onRequest: () => {
      lastUse = Date.now();
    },
    stale: () => stale,
    checks: () => checks,
  };
  let server = await bind(hoop, port, opts);
  if (!server) {
    logPages("pages_not_started", { reason: "address taken" });
    return;
  }
  logPages("pages_start", { port });
  const install = ownInstall();
  const own: Own = { install, release: release(install) ?? "0", code: codeId(install) };
  const tried = new Set<string>();
  let gone = 0;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const t = restartTarget(own, liveSessions(hoop.store.home));
      // An update can remove the install for a moment, so it must be gone on two checks in a row.
      gone = t === "gone" ? gone + 1 : 0;
      if (gone >= 2) stop("install removed");
      stale = t !== undefined && t !== "gone";
      checks++;
      if (!t || t === "gone" || tried.has(`${t.release}@${t.code}`)) return;
      tried.add(`${t.release}@${t.code}`);
      server = await handOver(t, server!, hoop, port, opts);
    } catch (err) {
      // Nothing may end the pages process with the address let go, so it serves again.
      logPages("pages_fallback", { ok: false, error: (err as Error).message });
      server = await serveAgain(hoop, port, opts, server!);
    } finally {
      busy = false;
    }
  }, checkMs());
  const idle = idleMs();
  setInterval(
    () => {
      if (busy || Date.now() - lastUse < idle || liveSessions(hoop.store.home).length) return;
      server!.close();
      stop("idle");
    },
    Math.min(5000, Math.max(100, idle / 4)),
  );
}
