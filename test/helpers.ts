import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright-core";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Reviews record the repository they come from (HOOP_REPO_DIR, default: the cwd); tests use a temporary one.
process.env.HOOP_REPO_DIR ??= mkdtempSync(join(tmpdir(), "hoop-repo-"));
// Tests never start a background pages process unless they ask for one; mcpClient passes this on.
process.env.HOOP_PAGES ??= "off";
/** The Claude Code session tests act in; the owner tests use others. It replaces the session that runs the tests. */
export const TEST_SESSION = "test-session-0000";
process.env.CLAUDE_CODE_SESSION_ID = TEST_SESSION;
// Session titles come from a temporary Claude Code folder, never the real one.
process.env.HOOP_CLAUDE_DIR = mkdtempSync(join(tmpdir(), "hoop-claude-"));

export const example = () => JSON.parse(readFileSync(new URL("../examples/order-export.json", import.meta.url), "utf8"));
/**
 * A temporary hoop folder. Its settings turn the GitHub sign-in off, so the pages accept an approval
 * without one; the sign-in tests turn it back on.
 */
export const tempHome = () => {
  const home = mkdtempSync(join(tmpdir(), "hoop-test-"));
  writeFileSync(join(home, "config.json"), `${JSON.stringify({ signin: false })}\n`);
  return home;
};
export const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname;
export const cli = new URL("../src/cli.ts", import.meta.url).pathname;

/** An MCP client connected to `hoop mcp` running as a child process. */
export async function mcpClient(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsx, cli, "mcp"],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "hoop-test", version: "0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: Boolean(res.isError), value: JSON.parse(res.content[0]!.text) };
  };
  return { client, call, close: () => client.close() };
}

const CHROME = process.env.HOOP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** Why browser tests can't run here, or false. Playwright needs Node 20+; hoop itself runs on 18. */
export const BROWSER_SKIP =
  Number(process.versions.node.split(".")[0]) < 20 ? "browser test needs Node 20+" : !existsSync(CHROME) ? "Chrome not found (set HOOP_CHROME)" : false;
// HOOP_REQUIRE_BROWSER=1 turns a skipped browser into a failure, so a full run can't pass without one.
if (BROWSER_SKIP && process.env.HOOP_REQUIRE_BROWSER === "1") throw new Error(`HOOP_REQUIRE_BROWSER is set, but ${BROWSER_SKIP}`);

/**
 * Runs `fn` against a hoop web server on a free port and a headless Chrome page, then closes both.
 * Pass `hoop` to use a prepared instance; the default has a fresh store.
 */
export async function withBrowser(
  fn: (ctx: { hoop: Hoop; base: string; page: Page; browser: Browser }) => Promise<void>,
  hoop = new Hoop(new Store(tempHome())),
) {
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    await fn({ hoop, base, page: await browser.newPage(), browser });
  } finally {
    await browser.close();
    server.close();
  }
}
