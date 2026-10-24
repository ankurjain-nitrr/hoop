import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { cli, mcpClient, pagesFor, sessionless, tempHome, tsx } from "./helpers.js";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const NPX = ["npx", "-y", "@ankurjain-nitrr/hoop"];

/** The code block that follows `**<tool>**` in the README's "Other agents" section. */
function snippet(tool: string): string {
  const section = README.slice(README.indexOf("## Other agents"), README.indexOf("## For agents"));
  const m = section.slice(section.indexOf(`**${tool}**`)).match(/```\w+\n([\s\S]*?)```/);
  assert.ok(m, `no config for ${tool} in the README`);
  return m[1]!;
}

/** The snippet written to a file named as the tool names it, and read back. */
function configFile(name: string, text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "hoop-agent-")), name);
  writeFileSync(path, text);
  return readFileSync(path, "utf8");
}

type Toml = Record<string, Record<string, unknown>>;
/** The TOML the Codex snippet uses: `[table]` headers and `key = "string" | number | ["strings"]`. */
function parseToml(text: string): Toml {
  const out: Toml = {};
  let table: Record<string, unknown> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (header) {
      table = out[header[1]!] = {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    assert.ok(kv && table, `not TOML this parser reads: ${line}`);
    table[kv[1]!] = JSON.parse(kv[2]!); // strings, numbers and string arrays read the same in JSON
  }
  return out;
}

/** The command a config names, with the published package swapped for this checkout's CLI. */
function local(command: string[]): string[] {
  assert.deepEqual(command.slice(0, 3), NPX, "the config runs hoop from GitHub with npx");
  return [process.execPath, tsx, cli, ...command.slice(3)];
}

/** Starts the configured command as `client`, submits a document, and reads back a person's review. */
async function smoke(client: string, command: string[], env: Record<string, string> = {}) {
  assert.deepEqual(command.slice(3), ["mcp"]);
  const home = tempHome();
  const [bin, ...args] = local(command);
  const mcp = await mcpClient(sessionless({ ...(await pagesFor(home)), ...env }), { client, command: bin, args, replaceEnv: true });
  try {
    const sub = await mcp.call("hoop_submit", { markdown: "# Ship the export\n\nShip it on Monday.\n" });
    assert.equal(sub.isError, false, JSON.stringify(sub.value));
    assert.match(sub.value.owner, new RegExp(`^${client} \\([0-9a-f]{8}\\)$`));
    new Hoop(new Store(home), null).review(sub.value.review_id, {
      verdict: "changes_requested",
      reviewer: "ana",
      comments: [{ item: "DOC", line: 2, body: "Tuesday?" }],
    });
    const fb = await mcp.call("hoop_feedback", { review_id: sub.value.review_id });
    assert.equal(fb.value.status, "reviewed");
    const [latest] = fb.value.feedback;
    assert.deepEqual([latest.verdict, latest.comments[0].body], ["changes_requested", "Tuesday?"]);
    const reply = await mcp.call("hoop_reply", { thread: latest.comments[0].thread, body: "Monday stands." });
    assert.equal(reply.isError, false, JSON.stringify(reply.value));
  } finally {
    await mcp.close();
  }
}

test("Codex CLI: the README's config.toml starts hoop as an MCP server", async () => {
  const toml = parseToml(configFile("config.toml", snippet("Codex CLI")));
  const hoop = toml["mcp_servers.hoop"]!;
  assert.equal(typeof hoop.startup_timeout_sec, "number");
  await smoke("codex-mcp-client", [hoop.command as string, ...(hoop.args as string[])]);
});

test("Cursor: the README's mcp.json starts hoop as an MCP server", async () => {
  const hoop = JSON.parse(configFile("mcp.json", snippet("Cursor"))).mcpServers.hoop;
  assert.equal(hoop.type, "stdio");
  await smoke("cursor", [hoop.command, ...hoop.args]);
});

test("OpenCode: the README's opencode.json starts hoop as an MCP server", async () => {
  const config = JSON.parse(configFile("opencode.json", snippet("OpenCode")));
  assert.equal(config.$schema, "https://opencode.ai/config.json");
  const hoop = config.mcp.hoop;
  assert.deepEqual([hoop.type, hoop.enabled], ["local", true]);
  await smoke("opencode", hoop.command, hoop.environment);
});

test("Gemini CLI: the README's settings.json starts hoop as an MCP server", async () => {
  const hoop = JSON.parse(configFile("settings.json", snippet("Gemini CLI"))).mcpServers.hoop;
  await smoke("gemini-cli-mcp-client", [hoop.command, ...hoop.args], hoop.env);
});
