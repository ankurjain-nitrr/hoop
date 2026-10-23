import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { createWebServer, type PagesOptions } from "../src/web.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Reviews record the repository they come from (HOOP_REPO_DIR, default: the cwd); tests use a temporary one.
process.env.HOOP_REPO_DIR ??= mkdtempSync(join(tmpdir(), "hoop-repo-"));
// No test, and no process a test starts, ever reads or writes the person's own hoop folder.
process.env.HOOP_HOME = mkdtempSync(join(tmpdir(), "hoop-home-"));
// Tests never start a background pages process unless they ask for one; mcpClient passes this on.
process.env.HOOP_PAGES ??= "off";
/** The Claude Code session tests act in; the owner tests use others. It replaces the session that runs the tests. */
export const TEST_SESSION = "test-session-0000";
process.env.CLAUDE_CODE_SESSION_ID = TEST_SESSION;
// Session titles come from a temporary Claude Code folder, never the real one.
process.env.HOOP_CLAUDE_DIR = mkdtempSync(join(tmpdir(), "hoop-claude-"));

export const example = () => JSON.parse(readFileSync(new URL("../examples/order-export.json", import.meta.url), "utf8"));
/** A temporary hoop folder. */
export const tempHome = () => mkdtempSync(join(tmpdir(), "hoop-test-"));
export const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname;
export const cli = new URL("../src/cli.ts", import.meta.url).pathname;

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
    args: opts.args ?? [tsx, cli, "mcp"],
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
export const BROWSER_SKIP = !existsSync(CHROME) ? "Chrome not found (set HOOP_CHROME)" : false;
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
  const server = createWebServer(hoop, [], opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
export async function hasFocus(locator: Locator, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await locator.evaluate((el) => el === document.activeElement).catch(() => false)) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}
