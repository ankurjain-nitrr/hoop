// Shared helpers for the acceptance scripts: paths, a step printer, an MCP client and `hoop wait`.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { storeKey } from "../src/sessions.js";
import { hoopHome } from "../src/util.js";

export const root = new URL("..", import.meta.url).pathname;
export const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
export const cli = join(root, "src/cli.ts");
export const chrome = process.env.HOOP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const step = (s: string) => process.stdout.write(`• ${s}\n`);

// A run acts as one Claude Code session of its own, with session titles from a temporary Claude Code
// folder, never the real one; every process it starts inherits both.
process.env.CLAUDE_CODE_SESSION_ID = "e2e-session-0000";
process.env.HOOP_CLAUDE_DIR = mkdtempSync(join(tmpdir(), "hoop-e2e-claude-"));

/** A temporary hoop folder for a run. */
export function runHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Starts `hoop mcp` with `env`; `call` returns a tool's parsed result and throws on a tool error. */
export async function connectMcp(env: Record<string, string>, cwd?: string) {
  const client = new Client({ name: "hoop-e2e", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp"], env, ...(cwd ? { cwd } : {}) }));
  await pagesUp(Number(env.HOOP_PORT ?? 4747), env.HOOP_HOME ?? hoopHome());
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const value = JSON.parse(res.content[0]!.text);
    if (res.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
    return value;
  };
  return { client, call };
}

/**
 * Waits until the background pages process that `hoop mcp` started answers, and stops it when this
 * script exits, so a run leaves no hoop process behind.
 */
async function pagesUp(port: number, home: string) {
  for (let i = 0; i < 40; i++) {
    const info = (await fetch(`http://127.0.0.1:${port}/api/info`)
      .then((r) => r.json())
      .catch(() => undefined)) as { pid?: number; store?: string } | undefined;
    // Only this script's own pages are stopped, never pages that serve another store.
    if (info?.pid && info.store === storeKey(home)) {
      process.once("exit", () => {
        try {
          process.kill(info.pid!);
        } catch {
          /* already gone */
        }
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no hoop pages on port ${port} after 10 seconds`);
}

/** Runs `hoop wait` now and resolves with the feedback it prints, or rejects if it exits non-zero. */
export function waitFor(id: string, env: Record<string, string>, opts: { timeout: number; cwd?: string }) {
  const child = spawn(process.execPath, [tsx, cli, "wait", id, "--timeout", String(opts.timeout)], { env, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  return new Promise<any>((resolve, reject) =>
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`hoop wait exited ${code}`)))),
  );
}
