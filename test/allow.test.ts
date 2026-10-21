import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowCheck } from "../src/allow.js";
import { Hoop } from "../src/hoop.js";
import { OPS } from "../src/ops.js";
import { Store } from "../src/store.js";
import { cli, tempHome, tsx } from "./helpers.js";

function setup() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "hoop-allow-repo-"))),
    home = tempHome();
  writeFileSync(join(repo, "check.mjs"), "process.exit(0);\n");
  writeFileSync(join(repo, "hoop.config.json"), JSON.stringify({ check: [process.execPath, "check.mjs"] }));
  return { repo, home };
}

const submit = (hoop: Hoop) => OPS.find((o) => o.name === "submit")!.run(hoop, { markdown: "# Plan\n\nShip it.\n" }, { actor: "claude" }) as Promise<any>;

test("FR-70: after the person confirms, the entry is added and the next submit runs the check", async () => {
  const { repo, home } = setup();
  writeFileSync(join(home, "config.json"), JSON.stringify({ signin: false, other: 1 }));
  const asked: string[] = [];
  const out = await allowCheck(repo, home, { terminal: true, ask: async (q) => (asked.push(q), true) });
  assert.equal(out.status, "allowed");
  assert.equal(asked.length, 1);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.deepEqual(config.checks, [{ repo, command: [process.execPath, "check.mjs"] }]);
  assert.deepEqual([config.signin, config.other], [false, 1], "every other setting stays");
  process.env.HOOP_REPO_DIR = repo;
  const res = await submit(new Hoop(new Store(home)));
  assert.equal(res.checks.ran, true);
  assert.equal(res.warnings, undefined);
  assert.equal((await allowCheck(repo, home, { terminal: true, ask: async () => assert.fail("asked twice") })).status, "already");
});

test("FR-140: declining changes nothing, and without a terminal the command refuses", async () => {
  const { repo, home } = setup();
  const declined = await allowCheck(repo, home, { terminal: true, ask: async () => false });
  assert.equal(declined.status, "declined");
  const before = readFileSync(join(home, "config.json"), "utf8");
  assert.equal(JSON.parse(before).checks, undefined, "nothing is allowed");
  // An agent's call has no terminal, so it is refused.
  const r = spawnSync(process.execPath, [tsx, cli, "allow-check"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, HOOP_HOME: home, HOOP_REPO_DIR: repo },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /run it yourself in a terminal/);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), before, "the settings are unchanged");
});

test("review fix: settings that don't parse are never overwritten", async () => {
  const { repo, home } = setup();
  writeFileSync(join(home, "config.json"), '{ "signin": false, "github_client_id": "Iv1.mine", }');
  await assert.rejects(allowCheck(repo, home, { terminal: true, ask: async () => true }), /config\.json.*isn't valid JSON/);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), '{ "signin": false, "github_client_id": "Iv1.mine", }');
});
