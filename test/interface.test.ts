import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cli, mcpClient, tempHome, tsx } from "./helpers.js";

// The agent tools, their schemas and the terminal commands, as recorded, for a project without
// devloop and one with it. A refactor must leave them unchanged; a deliberate change updates this
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
  const plain = tempHome();
  const devloop = tempHome();
  writeFileSync(join(devloop, "hoop.config.json"), JSON.stringify({ devloop: true }));
  mkdirSync(join(devloop, "docs"));
  const now = { tools: await toolsIn(plain, home), devloop_tools: await toolsIn(devloop, home), help: "" };
  const help = spawnSync(process.execPath, [tsx, cli, "help"], { encoding: "utf8", env: { ...process.env, HOOP_HOME: home } });
  assert.equal(help.status, 0);
  now.help = help.stdout;
  if (process.env.HOOP_UPDATE_FIXTURE === "1") writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
  for (const key of ["tools", "devloop_tools"] as const) {
    assert.deepEqual(
      now[key].map((t) => t.name),
      before[key].map((t: { name: string }) => t.name),
      `${key} are listed in the same order`,
    );
    assert.deepEqual(now[key], before[key]);
  }
  assert.equal(now.help, before.help);
});
