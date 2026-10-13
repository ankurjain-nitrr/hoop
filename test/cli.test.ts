import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { cli, tempHome, tsx } from "./helpers.js";

function setup() {
  const repo = tempHome(), home = tempHome();
  mkdirSync(join(repo, "docs", "changes"), { recursive: true });
  writeFileSync(join(repo, "docs", "TRACKER.md"), "# Tracker\n\n| ID | Parent | Type | Title | Status | Phase |\n|---|---|---|---|---|---|\n");
  const run = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [tsx, cli, ...args], { cwd: repo, input, encoding: "utf8", env: { ...process.env, HOOP_HOME: home, HOOP_REPO_DIR: repo, HOOP_AUDIT: "0" } });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  return { repo, home, run };
}

test("FR-11: every agent tool has a terminal command, and the usage lists them", () => {
  assert.deepEqual(OPS.map((o) => o.name), ["submit", "submit_markdown", "feedback", "propose_edits", "reply", "export",
    "cr_create", "cr_classify", "cr_step", "cr_get", "cr_link_pr", "tracker_get", "tracker_set"]);
  const { run } = setup();
  const help = run(["help"]).out;
  for (const op of OPS) assert.ok(help.includes(op.cli.usage), op.cli.usage);
});

test("FR-11: a change runs from capture through ordered reviews to build from the terminal alone", () => {
  const { repo, home, run } = setup();
  const request = "Queue my requests\nand show overlaps.\n";
  const created = run(["cr", "create", "--type", "story", "--reason", "one capability", "--json"], request);
  assert.equal(created.code, 0, created.err);
  assert.equal(created.json().id, "CR-1");
  assert.equal(readFileSync(join(repo, "docs/changes/CR-1-queue-my-requests/REQUEST.md"), "utf8"), request);
  assert.match(run(["tracker"]).out, /CR-1/);

  const reclass = run(["cr", "classify", "CR-1", "epic", "--reason", "several stories", "--why", "it spans two pages", "--json"]);
  assert.equal(reclass.json().type, "epic");
  assert.match(readFileSync(join(repo, "docs/changes/CLASSIFICATION.md"), "utf8"), /it spans two pages/);

  writeFileSync(join(repo, "PRD.md"), "# PRD\n\nThe problem.\n");
  writeFileSync(join(repo, "HLD.md"), "# HLD\n\nThe components.\n");
  const early = run(["submit", "HLD.md", "--cr", "CR-1", "--doc", "hld"]);
  assert.equal(early.code, 1);
  assert.match(early.err, /CR-1 has no PRD review; run hoop submit PRD.md --cr CR-1 --doc prd/);

  const prd = run(["submit", "PRD.md", "--cr", "CR-1", "--doc", "prd", "--json"]).json();
  assert.equal(run(["feedback", prd.review_id, "--json"]).json().status, "pending");
  new Hoop(new Store(home)).review(prd.review_id, { verdict: "approved" });
  const hld = run(["submit", "HLD.md", "--cr", "CR-1", "--doc", "hld", "--json"]);
  assert.equal(hld.code, 0, hld.err);

  const show = run(["cr", "show", "CR-1", "--json"]).json();
  assert.equal(show.step, "hld");
  assert.deepEqual(show.documents.map((d: { doc: string; status?: string }) => [d.doc, d.status ?? null]), [["prd", "approved"], ["hld", "open"], ["lld", null]]);
  assert.equal(show.ready.ok, false);
  const build = run(["cr", "step", "CR-1", "build"]);
  assert.equal(build.code, 1);
  assert.match(build.err, /the next step is lld/);

  assert.equal(run(["cr", "link-pr", "CR-1", "41", "--json"]).json().prs[0], 41);
  const set = run(["tracker", "set", "CR-1", "PR=#41", "Status=in review", "--json"]);
  assert.deepEqual([set.json().cells.PR, set.json().status], ["#41", "in review"]);
  assert.match(readFileSync(join(repo, "docs/TRACKER.md"), "utf8"), /\| CR-1 \| \| epic \| Queue my requests \| in review \| hld \| #41 \|/);

  const out = join(repo, "PRD.out.md");
  assert.equal(run(["export", prd.review_id, "--out", out]).code, 0);
  assert.equal(readFileSync(out, "utf8"), "# PRD\n\nThe problem.\n");
});

test("FR-11: comments, edits and replies from the terminal; failures exit 1 naming the field", () => {
  const { home, repo, run } = setup();
  writeFileSync(join(repo, "doc.md"), "# Plan\n\nShip on Friday.\n");
  const { review_id } = run(["submit", "doc.md", "--json"]).json();
  const fb = new Hoop(new Store(home)).review(review_id, { verdict: "comment", comments: [{ item: "S-0", line: 1, body: "Monday?" }] });
  const thread = fb.comments[0]!.thread!;
  writeFileSync(join(repo, "edits.json"), JSON.stringify([{ item: "S-0", line: 1, find: "Friday", replace: "Monday" }]));
  const prop = run(["propose", review_id, thread, "edits.json", "--note", "Moves the date", "--json"]);
  assert.equal(prop.code, 0, prop.err);
  assert.equal(prop.json().proposals[0].replace, "Monday");
  assert.equal(run(["reply", thread, "Proposed", "Monday.", "--json"]).json().body, "Proposed Monday.");

  const missing = run(["feedback"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /missing <review_id>[\s\S]*usage: hoop feedback <review_id>/);
  const badType = run(["cr", "create", "--type", "chore", "--reason", "r"], "x");
  assert.equal(badType.code, 1);
  assert.match(badType.err, /type: Invalid option: expected one of "epic"|"story"|"task"|"bug"/);
  assert.match(run(["tracker", "set", "CR-9", "oops"]).err, /expected <column>=<value>, got oops/);
});
