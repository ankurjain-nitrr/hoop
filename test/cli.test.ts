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
  const repo = tempHome(),
    home = tempHome();
  mkdirSync(join(repo, "docs", "changes"), { recursive: true });
  writeFileSync(join(repo, "docs", "TRACKER.md"), "# Tracker\n\n| ID | Parent | Type | Title | Status | Phase |\n|---|---|---|---|---|---|\n");
  const run = (args: string[], input?: string, opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) => {
    const r = spawnSync(process.execPath, [tsx, cli, ...args], {
      cwd: opts.cwd ?? repo,
      input,
      encoding: "utf8",
      env: { ...process.env, HOOP_HOME: home, HOOP_REPO_DIR: repo, HOOP_AUDIT: "0", ...opts.env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  return { repo, home, run };
}

test("FR-11, FR-60: every agent tool has a terminal command, and the usage lists them", () => {
  assert.deepEqual(
    OPS.map((o) => o.name),
    [
      "submit",
      "submit_decision",
      "feedback",
      "wait",
      "propose_edits",
      "reply",
      "export",
      "cr_create",
      "cr_classify",
      "cr_step",
      "cr_get",
      "cr_link_pr",
      "tracker_get",
      "tracker_set",
    ],
  );
  const { run } = setup();
  const help = run(["help"]).out;
  // The wait tool's command is `hoop wait`, which keeps its own options.
  assert.deepEqual(
    OPS.filter((op) => !op.cli).map((op) => op.name),
    ["wait"],
  );
  assert.match(help, /wait <review_id> \[--timeout <seconds>\]/);
  for (const op of OPS.filter((o) => o.cli)) assert.ok(help.includes(op.cli!.usage), op.cli!.usage);
  // Every flag an operation reads is one its usage line declares, so the strict parser accepts it.
  for (const op of OPS.filter((o) => o.cli)) {
    const read = [...op.cli!.parse.toString().matchAll(/flag\(a, "([a-z-]+)"\)/g)].map((m) => m[1]);
    for (const f of read) assert.ok(op.cli!.usage.includes(`--${f} <`), `${op.cli!.command} reads --${f} but its usage doesn't declare it`);
  }
});

test("FR-60: the help lists devloop's commands in their own group, and they run without the setting", () => {
  const { run, repo } = setup();
  const help = run(["help"]).out;
  const devloop = help.indexOf("devloop's change requests and tracker");
  assert.ok(devloop > 0);
  for (const op of OPS.filter((o) => o.cli)) {
    const at = help.indexOf(op.cli!.usage);
    assert.equal(at > devloop, op.layer === "devloop", `${op.name} is listed in the wrong group`);
  }
  // A repository with no devloop setting and no change folders still runs devloop's commands.
  const plain = tempHome();
  writeFileSync(join(plain, "docs.md"), "x");
  const r = run(["cr", "create", "--type", "task", "--reason", "small", "--json"], "Fix the footer.\n", { cwd: plain, env: { HOOP_REPO_DIR: plain } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().id, "CR-1");
  assert.ok(repo);
});

test("FR-61, FR-62: each submit command takes its format, and the old command still works with a notice", () => {
  const { run, repo } = setup();
  writeFileSync(join(repo, "plan.md"), "# Plan\n\nShip the export.\n");
  const md = run(["submit", join(repo, "plan.md"), "--json"]);
  assert.equal(md.code, 0, md.err);
  assert.equal(md.json().outcome, "created");
  writeFileSync(join(repo, "decision.json"), JSON.stringify(JSON.parse(readFileSync(new URL("../examples/order-export.json", import.meta.url), "utf8"))));
  const decision = run(["submit-decision", join(repo, "decision.json"), "--json"]);
  assert.equal(decision.code, 0, decision.err);
  assert.equal(decision.json().notice, undefined);
  const old = run(["submit-json", join(repo, "decision.json"), "--json"]);
  assert.equal(old.code, 0, old.err);
  assert.match(old.json().notice, /hoop submit-json is an old name .* use hoop submit-decision/);
  assert.match(old.err, /old name/);
});

test("FR-11: a change runs from capture through ordered reviews to build from the terminal alone", () => {
  const { repo, home, run } = setup();
  const request = "Queue my requests\nand show overlaps.\n";
  const created = run(["cr", "create", "--type", "story", "--reason", "one capability", "--json"], request);
  assert.equal(created.code, 0, created.err);
  assert.equal(created.json().id, "CR-1");
  assert.equal(readFileSync(join(repo, "docs/changes/CR-1-queue-my-requests/REQUEST.md"), "utf8"), request);
  // FR-93: a change shows on the change request page, not in the tracker.
  assert.doesNotMatch(run(["tracker"]).out, /CR-1/);
  assert.equal(run(["cr", "show", "CR-1", "--json"]).json().project.length > 0, true);

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
  assert.deepEqual(
    show.documents.map((d: { doc: string; status?: string }) => [d.doc, d.status ?? null]),
    [
      ["prd", "approved"],
      ["hld", "open"],
      ["lld", null],
    ],
  );
  assert.equal(show.ready.ok, false);
  const build = run(["cr", "step", "CR-1", "build"]);
  assert.equal(build.code, 1);
  assert.match(build.err, /the next step is lld/);

  assert.equal(run(["cr", "link-pr", "CR-1", "41", "--json"]).json().prs[0], 41);
  // FR-90: a new item through tracker set comes with its block; then its cells change in place.
  const added = run(["tracker", "set", "T-1", "Type=task", "Title=Queue the requests.", "Status=todo", "--json"]);
  assert.equal(added.code, 0, added.err);
  const set = run(["tracker", "set", "T-1", "PR=#41", "Status=in review", "--json"]);
  assert.deepEqual([set.json().cells.PR, set.json().status], ["#41", "in review"]);
  const tracker = readFileSync(join(repo, "docs/TRACKER.md"), "utf8");
  assert.match(tracker, /\| T-1 \| \| task \| Queue the requests\. \| in review \| \| #41 \|/);
  assert.match(tracker, /## Items\n\n### T-1: Queue the requests\.\n/);

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

test("review fixes: flags parse strictly; values may start with --; IDs and PR numbers are checked; actors and audits are right", () => {
  const { repo, home, run } = setup();
  run(["cr", "create", "--type", "task", "--reason", "r"], "Fix it\n");
  assert.equal(run(["cr", "show", "--json", "CR-1"]).json().id, "CR-1", "--json before a positional");
  const unknown = run(["cr", "classify", "CR-1", "bug", "--reasn", "typo"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown flag --reasn; this command takes --reason, --why, --kind, --project and --json/);
  assert.equal(run(["cr", "classify", "CR-1", "bug", "--reason", "--not a flag", "--json"]).json().reason, "--not a flag");
  assert.equal(run(["cr", "classify", "CR-1", "bug", "--reason=equals form", "--json"]).json().reason, "equals form");
  assert.match(run(["cr", "classify", "CR-1", "bug", "--reason"]).err, /--reason needs a value/);
  assert.match(run(["cr", "classify", "CR-1", "bug"]).err, /reason: required[\s\S]*usage: hoop cr classify/);
  assert.match(run(["submit", "x.md", "--review_id", "rv_x"]).err, /unknown flag --review_id; this command takes --review/);
  assert.match(run(["tracker", "set", "CR-1", "ID=CR-7"]).err, /an item's ID can't be changed/);
  assert.match(run(["cr", "link-pr", "CR-1", "0x10"]).err, /expected a PR number, got 0x10/);

  const audited = (env: Record<string, string>) => run(["cr", "step", "CR-1", "build"], undefined, { env });
  const log = join(home, "audit.jsonl");
  audited({ HOOP_AUDIT: "1" });
  const refusals = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === "cr_step");
  assert.equal(refusals.length, 1, "a refusal is audited once");
  run(["cr", "step", "CR-1", "prd"]);
  assert.notEqual(run(["cr", "show", "CR-1", "--json"]).json().steps.at(-1).by, "claude", "terminal moves are the user's");

  spawnSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  const fromSub = run(["cr", "show", "CR-1", "--json"], undefined, { cwd: join(repo, "src", "deep"), env: { HOOP_REPO_DIR: undefined } });
  assert.equal(fromSub.code, 0, fromSub.err);
  assert.equal(fromSub.json().id, "CR-1", "a subdirectory acts on the repository root");
});
