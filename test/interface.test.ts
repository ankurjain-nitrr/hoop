import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cli, mcpClient, tempHome, tsx } from "./helpers.js";

// The agent tools, their schemas and the terminal commands, as recorded. A refactor must leave them unchanged; a deliberate change updates this
// fixture in the same PR (HOOP_UPDATE_FIXTURE=1 rewrites it).
const FIXTURE = new URL("./fixtures/interface.json", import.meta.url);
const before = JSON.parse(readFileSync(FIXTURE, "utf8"));

async function toolsIn(repo: string, home: string) {
  const mcp = await mcpClient({ HOOP_HOME: home, HOOP_PORT: "4796", HOOP_REPO_DIR: repo });
  try {
    return (await mcp.client.listTools()).tools;
  } finally {
    await mcp.close();
  }
}

test("the agent tools, their schemas and the commands match the recorded interface", async () => {
  const home = tempHome();
  const now = { tools: await toolsIn(tempHome(), home), help: "" };
  const help = spawnSync(process.execPath, [tsx, cli, "help"], { encoding: "utf8", env: { ...process.env, HOOP_HOME: home } });
  assert.equal(help.status, 0);
  now.help = help.stdout;
  if (process.env.HOOP_UPDATE_FIXTURE === "1") writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
  assert.deepEqual(
    now.tools.map((t) => t.name),
    before.tools.map((t: { name: string }) => t.name),
    "the tools are listed in the same order",
  );
  assert.deepEqual(now.tools, before.tools);
  assert.equal(now.help, before.help);
});
