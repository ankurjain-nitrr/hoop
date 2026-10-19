import { spawn } from "node:child_process";
import { request } from "node:http";
import type { Server } from "node:net";
import { audit } from "./audit.js";
import { Hoop, PORT } from "./hoop.js";
import { liveSessions, startCommand, storeKey } from "./sessions.js";
import { startWeb } from "./web.js";

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
    const finish = (p: Probe) => { if (!done) { done = true; resolve(p); } };
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
function startPages() {
  const [command, ...args] = startCommand();
  const child = spawn(command!, [...args, "serve"], {
    detached: true, stdio: "ignore", env: { ...process.env, HOOP_PAGES: "background" },
  });
  child.on("error", () => {});
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

/**
 * The background pages process: it binds the usual address, retrying for a few seconds, and exits
 * after the idle time with no live session and no request from a page.
 */
export async function runPages(hoop = new Hoop(), port = PORT): Promise<void> {
  let lastUse = Date.now();
  const opts = { onRequest: () => { lastUse = Date.now(); } };
  let server: Server | undefined;
  for (let i = 0; i < BIND_TRIES && !server; i++) {
    server = await startWeb(hoop, port, opts);
    if (!server) await new Promise((r) => setTimeout(r, BIND_DELAY_MS));
  }
  if (!server) {
    audit("pages_stop", { actor: "hoop", reason: "address taken" });
    return;
  }
  audit("pages_start", { actor: "hoop", port });
  const idle = idleMs();
  const tick = setInterval(() => {
    if (Date.now() - lastUse < idle || liveSessions(hoop.store.home).length) return;
    clearInterval(tick);
    audit("pages_stop", { actor: "hoop", reason: "idle" });
    server!.close();
    process.exit(0);
  }, Math.min(5000, Math.max(100, idle / 4)));
}
