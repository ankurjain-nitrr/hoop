import { spawn } from "node:child_process";
import { request } from "node:http";
import type { Server } from "node:http";
import { audit } from "./audit.js";
import { Hoop, PORT } from "./hoop.js";
import { liveSessions, type Session, startCommand, storeKey } from "./sessions.js";
import { codeId, isNewer, ownInstall, release } from "./version.js";
import { type PagesOptions, startWeb } from "./web.js";

/** What answers on the usual address: hoop's pages (with their info), an older hoop, nothing, or something else. */
export type Probe = { kind: "pages"; info: PagesInfo } | { kind: "old" } | { kind: "none" } | { kind: "other" };
export type PagesInfo = { hoop: "pages"; store: string; release?: string; code?: string; pid: number; stale: boolean };

/** How a session stands with the pages: served for its store, just started, or not available to it. */
export type PagesStatus = "serving" | "started" | "old" | "unavailable" | "off";

const PROBE_TIMEOUT_MS = 1000;

/** Asks the address what it is, waiting at most `timeoutMs`. */
export function probe(port = PORT, timeoutMs = PROBE_TIMEOUT_MS): Promise<Probe> {
  return new Promise((resolve) => {
    let done = false;
    // The request's own timeout only covers idle time, so a holder that trickles bytes needs this deadline.
    const deadline = setTimeout(() => { req.destroy(); finish({ kind: "other" }); }, timeoutMs);
    const finish = (p: Probe) => { if (!done) { done = true; clearTimeout(deadline); resolve(p); } };
    const req = request({ host: "127.0.0.1", port, path: "/api/info", headers: { host: `localhost:${port}` }, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; if (body.length > 100_000) req.destroy(); });
      res.on("end", () => {
        let info: any;
        try { info = JSON.parse(body); } catch { return finish({ kind: "other" }); }
        if (res.statusCode !== 200 || !info || typeof info !== "object" || Array.isArray(info)) return finish({ kind: "other" });
        if (info.hoop === "pages" && typeof info.store === "string" && Number.isInteger(info.pid)) return finish({ kind: "pages", info });
        // A hoop from before the pages process answers this route with its repository only.
        finish(Object.keys(info).every((k) => k === "repo") ? { kind: "old" } : { kind: "other" });
      });
      res.on("error", () => finish({ kind: "other" }));
    });
    req.on("timeout", () => { req.destroy(); finish({ kind: "other" }); });
    req.on("error", (err: NodeJS.ErrnoException) => finish(err.code === "ECONNREFUSED" ? { kind: "none" } : { kind: "other" }));
    req.end();
  });
}

/** Starts this install's pages process in the background, detached from the caller. */
export function startPages(command = startCommand()) {
  const [bin, ...args] = command;
  const child = spawn(bin!, [...args, "serve"], {
    detached: true, stdio: "ignore", env: { ...process.env, HOOP_PAGES: "background" },
  });
  child.on("error", (err) => audit("pages_start_failed", { actor: "hoop", ok: false, error: err.message }));
  child.unref();
}

/**
 * Makes sure the usual address serves this store's pages before a link is given: it reuses a
 * pages process for the same store, and starts one when nothing answers. `HOOP_PAGES=off` skips it.
 */
export async function ensurePages(home: string, port = PORT): Promise<PagesStatus> {
  if (process.env.HOOP_PAGES === "off") return "off";
  const p = await probe(port);
  if (p.kind === "pages") return p.info.store === storeKey(home) ? "serving" : "unavailable";
  if (p.kind === "old") return "old";
  if (p.kind === "other") return "unavailable";
  startPages();
  return "started";
}

const BIND_TRIES = 20, BIND_DELAY_MS = 250;
const idleMs = () => Number(process.env.HOOP_PAGES_IDLE_MS) || 3_600_000;

const CHECK_MS = 2000, HANDOVER_MS = 5000;

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
    try { const t = restartTarget(own, liveSessions(hoop.store.home)); stale = t !== undefined && t !== "gone"; } catch { /* keep the last answer */ }
  }, CHECK_MS).unref();
  return () => stale;
}

/** Binds the usual address, retrying for a few seconds, or resolves undefined. */
async function bind(hoop: Hoop, port: number, opts: PagesOptions): Promise<Server | undefined> {
  for (let i = 0; i < BIND_TRIES; i++) {
    const server = await startWeb(hoop, port, opts);
    if (server) return server;
    await new Promise((r) => setTimeout(r, BIND_DELAY_MS));
  }
  return undefined;
}

function stop(reason: string, extra: Record<string, unknown> = {}): never {
  audit("pages_stop", { actor: "hoop", reason, ...extra });
  process.exit(0);
}

/**
 * Lets go of the address and starts the target in its place. The old process exits once the target
 * answers for this store. Otherwise it stops the target, binds again, and returns the new server.
 */
async function handOver(t: Target, server: Server, hoop: Hoop, port: number, opts: PagesOptions): Promise<Server> {
  audit("pages_restart", { actor: "hoop", release: t.release, code: t.code });
  await new Promise((r) => { server.close(r); server.closeAllConnections(); });
  const [bin, ...args] = t.start;
  const child = spawn(bin!, [...args, "serve"], { detached: true, stdio: "ignore", env: { ...process.env, HOOP_PAGES: "background" } });
  child.on("error", () => {});
  child.unref();
  const store = storeKey(hoop.store.home);
  for (const end = Date.now() + HANDOVER_MS; Date.now() < end; await new Promise((r) => setTimeout(r, BIND_DELAY_MS))) {
    const p = await probe(port);
    if (p.kind === "pages" && p.info.store === store && p.info.release === t.release && p.info.code === t.code) stop("restarted", { release: t.release });
  }
  // A successor that answers just after the deadline still takes over.
  const last = await probe(port);
  if (last.kind === "pages" && last.info.store === store && last.info.release === t.release && last.info.code === t.code) stop("restarted", { release: t.release });
  // The successor runs in its own process group, so this also stops anything it started. A child
  // that already exited is skipped, because its process ID may belong to another process by now.
  if (child.pid && child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  const again = await bind(hoop, port, opts);
  if (!again) {
    const p = await probe(port);
    stop(p.kind === "pages" && p.info.store === store ? "replaced" : "address taken");
  }
  audit("pages_fallback", { actor: "hoop", release: t.release, code: t.code });
  return again;
}

/**
 * The background pages process: it binds the usual address, retrying for a few seconds. It exits
 * after the idle time with no live session and no request from a page. Its own timer restarts it
 * into current code, once for each change, and no request can.
 */
export async function runPages(hoop = new Hoop(), port = PORT): Promise<void> {
  let lastUse = Date.now(), stale = false, busy = false;
  const opts: PagesOptions = { onRequest: () => { lastUse = Date.now(); }, stale: () => stale };
  let server = await bind(hoop, port, opts);
  if (!server) {
    audit("pages_not_started", { actor: "hoop", reason: "address taken" });
    return;
  }
  audit("pages_start", { actor: "hoop", port });
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
      if (!t || t === "gone" || tried.has(`${t.release}@${t.code}`)) return;
      tried.add(`${t.release}@${t.code}`);
      server = await handOver(t, server!, hoop, port, opts);
    } catch (err) {
      // Nothing may end the pages process with the address let go, so it serves again.
      audit("pages_fallback", { actor: "hoop", ok: false, error: (err as Error).message });
      if (!server!.listening) {
        const again = await bind(hoop, port, opts).catch(() => undefined);
        if (!again) {
          const p = await probe(port);
          stop(p.kind === "pages" && p.info.store === storeKey(hoop.store.home) ? "replaced" : "address taken");
        }
        server = again;
      }
    } finally {
      busy = false;
    }
  }, CHECK_MS);
  const idle = idleMs();
  setInterval(() => {
    if (busy || Date.now() - lastUse < idle || liveSessions(hoop.store.home).length) return;
    server!.close();
    stop("idle");
  }, Math.min(5000, Math.max(100, idle / 4)));
}
