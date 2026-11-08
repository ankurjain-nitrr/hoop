import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { type ChildProcess, spawn } from "node:child_process";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { createWebServer, type PagesOptions } from "../src/web.js";
import { OPS } from "../src/ops.js";
import { storeKey } from "../src/sessions.js";
import { bootId, bootTime } from "../src/proc.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Reviews record the repository they come from (HOOP_REPO_DIR, default: the cwd); tests use a temporary one.
process.env.HOOP_REPO_DIR ??= mkdtempSync(join(tmpdir(), "hoop-repo-"));
// No test, and no process a test starts, ever reads or writes the person's own hoop folder.
process.env.HOOP_HOME = mkdtempSync(join(tmpdir(), "hoop-home-"));
// `hoop open` never opens a browser in tests.
process.env.HOOP_NO_BROWSER ??= "1";
// No test asks npm for hoop's latest version; a test of the check passes its own.
process.env.HOOP_NO_UPDATE_CHECK ??= "1";
// Tests never start a background pages process unless they ask for one; mcpClient passes this on.
process.env.HOOP_PAGES ??= "off";
/** The Claude Code session tests act in; the owner tests use others. It replaces the session that runs the tests. */
export const TEST_SESSION = "test-session-0000";
process.env.CLAUDE_CODE_SESSION_ID = TEST_SESSION;
// Session titles come from a temporary Claude Code folder, never the real one.
process.env.HOOP_CLAUDE_DIR = mkdtempSync(join(tmpdir(), "hoop-claude-"));
// `hoop init` looks for other agents' configs (~/.codex, ~/.cursor, …) in a temporary home, never the real one.
process.env.HOOP_AGENTS_HOME = mkdtempSync(join(tmpdir(), "hoop-agents-"));

/** A port nothing listens on. */
export async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** Whether `err` says another hoop store's pages process holds the port, as hoop and `pagesOn` word it. */
export const portTaken = (err: unknown) => /another hoop store/.test(err instanceof Error ? err.message : String(err));

/**
 * Runs `attempt` on a free port, and again on a fresh one when it fails because another test
 * file's pages process took the port between finding it free and binding it: up to three tries.
 * `firstPort`, tried before any free one, lets a test hand it a port that is taken; `retry`
 * decides which failures are worth another port.
 */
export async function onFreePort<T>(attempt: (port: number) => Promise<T>, opts: { firstPort?: number; retry?: (err: unknown) => boolean } = {}): Promise<T> {
  const retry = opts.retry ?? portTaken;
  for (let tries = 1; ; tries++) {
    try {
      return await attempt(tries === 1 && opts.firstPort ? opts.firstPort : await freePort());
    } catch (err) {
      if (tries === 3 || !retry(err)) throw err;
    }
  }
}

const writers = new Map<string, Promise<{ HOOP_HOME: string; HOOP_PORT: string }>>();
const writerProcesses: ChildProcess[] = [];
process.once("exit", () => {
  for (const p of writerProcesses) p.kill();
});

/**
 * A pages process for the hoop folder `home` (by default the tests' own) on a free port: the only
 * writer, which the child processes a test starts send their writes to. Pass the result in their
 * environment. It starts once per folder and stops when the test file ends (or, if that is cut
 * short, after a minute without use). A port another test file's pages process took between
 * finding it free and binding it is given up for another one. `firstPort`, tried before any free
 * one, lets a test hand it a port that is taken.
 */
export function pagesFor(home = process.env.HOOP_HOME!, firstPort?: number): Promise<{ HOOP_HOME: string; HOOP_PORT: string }> {
  let started = writers.get(home);
  if (!started) {
    started = onFreePort((port) => pagesOn(home, port), { firstPort, retry: () => true });
    writers.set(home, started);
  }
  return started;
}

/**
 * A pages process for `home` on `port`, once it answers there for that store. Refused when a pages
 * process for another store answers instead, as when another test file took the port first. `env`
 * is the environment it starts from, this process's by default.
 */
export async function pagesOn(home: string, port: number, env: NodeJS.ProcessEnv = process.env): Promise<{ HOOP_HOME: string; HOOP_PORT: string }> {
  const child = spawn(process.execPath, [...hoopArgs, "serve"], {
    env: { ...env, HOOP_HOME: home, HOOP_PORT: String(port), HOOP_PAGES: "background", HOOP_PAGES_IDLE_MS: "60000" },
    stdio: "ignore",
  });
  writerProcesses.push(child);
  // Let the test file exit as soon as its tests end; the exit handler above stops the child.
  child.unref();
  const store = storeKey(home);
  for (const end = Date.now() + 15_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const info = await fetch(`http://127.0.0.1:${port}/api/info`)
      .then((r) => r.json() as Promise<{ hoop?: string; store?: string }>)
      .catch(() => undefined);
    if (info?.hoop === "pages" && info.store === store) return { HOOP_HOME: home, HOOP_PORT: String(port) };
    if (info?.hoop === "pages") {
      child.kill();
      throw new Error(`port ${port} serves another hoop store, not ${home}`);
    }
  }
  child.kill();
  throw new Error(`no pages process for ${home} on port ${port}`);
}

/** A fake Claude Code messaging socket that collects the lines written to it. */
export async function fakeSocket() {
  const path = join(mkdtempSync(join(tmpdir(), "hs-")), "s.sock");
  const lines: string[] = [];
  const server = createNetServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, lines, close: () => server.close() };
}

/** A time as Claude Code writes `procStart`: `ps -o lstart` in UTC, such as "Fri Oct 23 17:11:53 2026". */
export function lstart(ms: number): string {
  const d = new Date(ms);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${day} ${month} ${String(d.getUTCDate()).padStart(2, " ")} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`;
}

/** The example decision document, with its question (Q-1). */
export const exampleWithQuestion = () => JSON.parse(readFileSync(new URL("../examples/order-export.json", import.meta.url), "utf8"));
/** The example without its question, so a reviewer can approve it: no revision with a question in it is approved (#165). */
export const example = () => {
  const doc = exampleWithQuestion();
  return { ...doc, items: doc.items.filter((i: { type: string }) => i.type !== "question") };
};
/** A temporary hoop folder. */
export const tempHome = () => mkdtempSync(join(tmpdir(), "hoop-test-"));
export const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname;
export const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const built = new URL("../dist/cli.js", import.meta.url).pathname;
// HOOP_TEST_BUILT=1 (set after `npm run build`, as CI does) runs hoop's processes from the built
// JavaScript, which starts in half the time; otherwise they compile the sources through tsx.
if (process.env.HOOP_TEST_BUILT === "1") {
  if (!existsSync(built)) throw new Error("HOOP_TEST_BUILT is set, but dist/cli.js is missing: run npm run build");
  // A source changed since the build would be tested as it was before the change.
  const srcDir = new URL("../src/", import.meta.url).pathname;
  const stale = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter(
    (f) => f.endsWith(".ts") && statSync(join(srcDir, f)).mtimeMs > statSync(built).mtimeMs,
  );
  if (stale.length) throw new Error(`HOOP_TEST_BUILT is set, but src/${stale[0]} is newer than dist/cli.js: run npm run build`);
}
/** The arguments after `node` that run hoop: `[...hoopArgs, "serve"]`. */
export const hoopArgs = process.env.HOOP_TEST_BUILT === "1" ? [built] : [tsx, cli];

/** The environment without any session: a process an agent other than Claude Code starts. */
export function sessionless(env: Record<string, string> = {}): Record<string, string> {
  const { CLAUDE_CODE_SESSION_ID: _c, HOOP_SESSION: _h, ...rest } = process.env as Record<string, string>;
  return { ...rest, ...env };
}

/**
 * An MCP client named `client` connected to a hoop MCP server running as a child process: `hoop mcp`
 * by default, or the command and arguments given. `env` is the child's whole environment when
 * `replaceEnv` is set, else it adds to this process's.
 */
export async function mcpClient(env: Record<string, string>, opts: { client?: string; command?: string; args?: string[]; replaceEnv?: boolean } = {}) {
  const transport = new StdioClientTransport({
    command: opts.command ?? process.execPath,
    args: opts.args ?? [...hoopArgs, "mcp"],
    env: opts.replaceEnv ? env : { ...(process.env as Record<string, string>), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: opts.client ?? "hoop-test", version: "0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: Boolean(res.isError), value: JSON.parse(res.content[0]!.text) };
  };
  return { client, call, close: () => client.close() };
}

const CHROME = process.env.HOOP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** Why browser tests can't run here, or false. */
export const BROWSER_SKIP =
  process.env.HOOP_SKIP_BROWSER === "1" ? "HOOP_SKIP_BROWSER is set" : !existsSync(CHROME) ? "Chrome not found (set HOOP_CHROME)" : false;
// HOOP_REQUIRE_BROWSER=1 turns a skipped browser into a failure, so a full run can't pass without one.
if (BROWSER_SKIP && process.env.HOOP_REQUIRE_BROWSER === "1") throw new Error(`HOOP_REQUIRE_BROWSER is set, but ${BROWSER_SKIP}`);

// The diagram library's pinned CDN address and hash, as web/diagram.js names them.
const diagramJs = readFileSync(new URL("../web/diagram.js", import.meta.url), "utf8");
export const MERMAID_URL = diagramJs.match(/MERMAID_URL = "([^"]+)"/)![1]!;
export const MERMAID_SRI = diagramJs.match(/MERMAID_SRI = "([^"]+)"/)![1]!;
/** The mermaid devDependency's file, which MERMAID_SRI must match. */
export const mermaidFile = () => readFileSync(new URL("../node_modules/mermaid/dist/mermaid.min.js", import.meta.url));

/**
 * Answers the diagram library's CDN address from the mermaid devDependency, so diagrams draw while
 * other hosts are blocked. Register it after a route that blocks other hosts: the last one runs first.
 */
export async function serveMermaid(target: Page | BrowserContext) {
  const body = mermaidFile();
  await target.route(MERMAID_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", headers: { "access-control-allow-origin": "*" }, body }),
  );
}

/** A hoop web server for `hoop` listening on a free port, and its base URL. */
async function listen(hoop: Hoop, opts: PagesOptions) {
  const server = createWebServer(hoop, [], opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/**
 * Runs `fn` against a hoop web server on a free port, then closes it. `opts` reaches the server, such
 * as stand-in sessions; pass `hoop` to use a prepared instance; the default has a fresh store.
 */
export async function withServer(opts: PagesOptions, fn: (base: string, hoop: Hoop) => Promise<void>, hoop = new Hoop(new Store(tempHome()))) {
  const { server, base } = await listen(hoop, opts);
  try {
    await fn(base, hoop);
  } finally {
    server.close();
  }
}

/** POSTs `body` as JSON to `url`, and gives the reply's status and JSON body. */
export const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

/** The operation named `name` (an agent tool and a terminal command). */
export const op = (name: string) => OPS.find((o) => o.name === name)!;

/** Runs the operation `name` with `input` as Claude would, and gives its result. */
export const runOp = (hoop: Hoop, name: string, input: Record<string, unknown>): unknown => op(name).run(hoop, input as never, { actor: "claude" });

/**
 * Runs `fn` against a hoop web server on a free port and a headless Chrome page, then closes both.
 * Pass `hoop` to use a prepared instance; the default has a fresh store. `opts` reaches the server,
 * such as a stand-in for `gh`.
 */
export async function withBrowser(
  fn: (ctx: { hoop: Hoop; base: string; page: Page; browser: Browser }) => Promise<void>,
  hoop = new Hoop(new Store(tempHome())),
  opts: PagesOptions = {},
) {
  const { server, base } = await listen(hoop, opts);
  const { chromium } = await import("playwright-core");
  // Chrome runs a sandboxed frame in its own process, whose requests routes don't see; in one
  // process, a diagram frame's request for its library is routed and blocked like any other.
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--disable-features=IsolateSandboxedIframes"] });
  try {
    await fn({ hoop, base, page: await browser.newPage(), browser });
  } finally {
    await browser.close();
    server.close();
  }
}

/**
 * Whether `locator` holds the focus, within `ms`. Pages that refresh on a timer repaint and then put
 * focus back, so a check at one instant can land mid-repaint.
 */
export async function hasFocus(locator: Locator, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await locator.evaluate((el) => el === document.activeElement).catch(() => false)) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Claude's text for a build's section, saved by the person at once: a section write arrives as a draft (#349). */
export function writeSaved(hoop: Hoop, id: string, section: string, markdown: string, used?: string[]) {
  hoop.buildWrite(id, section, markdown, used);
  return hoop.buildChange(id, { op: "save_draft", block: section });
}

/** The source with its comments blanked out, keeping their line breaks so line numbers still match. */
const uncommented = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, "")).replace(/^\s*\/\/.*$/gm, "");

/** The pages' own source files, web/*.js and web/index.html, by name ("web/app.js"), with their text. */
export function webSources(): { name: string; text: string }[] {
  const web = new URL("../web/", import.meta.url);
  return readdirSync(web)
    .filter((n) => n.endsWith(".js") || n.endsWith(".html"))
    .sort()
    .map((n) => ({ name: `web/${n}`, text: readFileSync(new URL(n, web), "utf8") }));
}

/**
 * Each line of the pages' own source (web/*.js and web/index.html), outside its comments, that
 * matches `pattern`, as "web/file.js:line: text". Comments may say anything: they are for people
 * reading the code.
 */
export function webSourceLines(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const { name, text } of webSources())
    uncommented(text)
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line)) found.push(`${name}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
  return found;
}

/**
 * A live `hoop mcp` entry in `home`, serving `session` from the Claude Code process `proc` when
 * recorded. The MCP server is this test process, or `as`, a process the test started at `started`.
 */
export function registerLive(home: string, session: string, proc?: { pid: number; start: string }, as?: { pid: number; started: number }) {
  mkdirSync(join(home, "sessions"), { recursive: true });
  const pid = as?.pid ?? process.pid;
  const entry = {
    format: 1,
    pid,
    started: as?.started ?? Date.now() - process.uptime() * 1000,
    boot: bootTime(),
    ...(bootId() ? { bootId: bootId() } : {}),
    repo: "/x",
    claude: session,
    ...(proc ? { process: proc } : {}),
    install: "/i",
    release: "0",
    start: ["node"],
  };
  writeFileSync(join(home, "sessions", `${pid}.json`), JSON.stringify(entry));
}

/**
 * Runs `fn` as a process with no HOOP_CLAUDE_DIR and the user folder `user` (so `~/.hoop` is
 * `<user>/.hoop`), then restores both, once a promise it returns settles.
 */
export function asUser<T>(user: string, fn: () => T): T {
  const saved = { HOOP_CLAUDE_DIR: process.env.HOOP_CLAUDE_DIR, HOME: process.env.HOME };
  // A variable that was unset is deleted again, never set to the string "undefined".
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  delete process.env.HOOP_CLAUDE_DIR;
  process.env.HOME = user;
  let out: T;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (out instanceof Promise) return out.finally(restore) as T;
  restore();
  return out;
}
