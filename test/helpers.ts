import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const example = () => JSON.parse(readFileSync(new URL("../examples/order-export.json", import.meta.url), "utf8"));
export const tempHome = () => mkdtempSync(join(tmpdir(), "hoop-test-"));
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
