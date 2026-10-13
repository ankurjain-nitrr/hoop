import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cli, mcpClient, tempHome, tsx } from "./helpers.js";

// The agent tools, their schemas and the terminal commands, as they were before CR-8. A refactor
// must leave them unchanged; a deliberate change updates this fixture in the same PR.
const before = JSON.parse(readFileSync(new URL("./fixtures/interface.json", import.meta.url), "utf8"));

test("the agent tools, their schemas and the commands match the recorded interface", async () => {
  const home = tempHome();
  const mcp = await mcpClient({ HOOP_HOME: home, HOOP_PORT: "4796" });
  try {
    const tools = (await mcp.client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(tools, before.tools);
  } finally {
    await mcp.close();
  }
  const help = spawnSync(process.execPath, [tsx, cli, "help"], { encoding: "utf8", env: { ...process.env, HOOP_HOME: home } }).stdout;
  assert.equal(help, before.help);
});
