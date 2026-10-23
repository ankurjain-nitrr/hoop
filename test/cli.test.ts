import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { cli, tempHome, tsx } from "./helpers.js";

// A git hook's GIT_* variables would point git at the repository running the hook, not the test's own.
const gitFree = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

function setup() {
  const repo = tempHome(),
    home = tempHome();
  const run = (args: string[], input?: string, opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) => {
    const r = spawnSync(process.execPath, [tsx, cli, ...args], {
      cwd: opts.cwd ?? repo,
      input,
      encoding: "utf8",
      env: { ...gitFree, HOOP_HOME: home, HOOP_REPO_DIR: repo, ...opts.env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  return { repo, home, run };
}

test("every agent tool has a terminal command, and the usage lists them", () => {
  assert.deepEqual(
    OPS.map((o) => o.name),
    ["submit", "submit_decision", "feedback", "wait", "propose_edits", "reply", "comment", "export", "track_pr"],
  );
  const { run } = setup();
  const help = run(["help"]).out;
  // The wait tool's command is `hoop wait`, which keeps its own options.
  assert.deepEqual(
    OPS.filter((op) => !op.cli).map((op) => op.name),
    ["wait"],
  );
  assert.match(help, /wait <review_id> \[--after <cursor>\] \[--timeout <seconds>\]/);
  for (const op of OPS.filter((o) => o.cli)) assert.ok(help.includes(op.cli!.usage), op.cli!.usage);
  // Every flag an operation reads is one its usage line declares, so the strict parser accepts it.
  for (const op of OPS.filter((o) => o.cli)) {
    const read = [...op.cli!.parse.toString().matchAll(/flag\(a, "([a-z-]+)"\)/g)].map((m) => m[1]);
    for (const f of read) assert.ok(op.cli!.usage.includes(`--${f} <`), `${op.cli!.command} reads --${f} but its usage doesn't declare it`);
  }
});

test("each submit command takes its format, and the old submit-json command is gone", () => {
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
  assert.equal(old.code, 2, "an unknown command prints the usage");
  assert.doesNotMatch(old.out, /submit-json|old name/i);
});

test("a document is submitted, read and exported from the terminal", () => {
  const { repo, run } = setup();
  writeFileSync(join(repo, "PRD.md"), "# PRD\n\nThe problem.\n");
  const prd = run(["submit", "PRD.md", "--json"]).json();
  assert.equal(run(["feedback", prd.review_id, "--json"]).json().status, "pending");
  const out = join(repo, "PRD.out.md");
  assert.equal(run(["export", prd.review_id, "--out", out]).code, 0);
  assert.equal(readFileSync(out, "utf8"), "# PRD\n\nThe problem.\n");
});

test("comments, edits and replies from the terminal; failures exit 1 naming the field", () => {
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
});

test("review fixes: flags parse strictly; values may start with --; a subdirectory acts on the repository root", () => {
  const { repo, home, run } = setup();
  writeFileSync(join(repo, "doc.md"), "# Plan\n\nShip on Friday.\n");
  assert.equal(run(["submit", "--json", "doc.md"]).json().outcome, "created", "--json before a positional");
  const unknown = run(["submit", "doc.md", "--titel", "typo"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown flag --titel; this command takes --review, --title, --tldr, --slug and --json/);
  assert.equal(run(["submit", "doc.md", "--title", "--not a flag", "--json"]).json().outcome, "created");
  assert.equal(run(["submit", "doc.md", "--slug=equals-form", "--json"]).code, 0);
  assert.match(run(["submit", "doc.md", "--title"]).err, /--title needs a value/);
  assert.match(run(["propose", "rv_x"]).err, /missing <thread>[\s\S]*usage: hoop propose/);
  assert.match(run(["submit", "x.md", "--review_id", "rv_x"]).err, /unknown flag --review_id; this command takes --review/);

  spawnSync("git", ["init", "-q"], { cwd: repo, env: gitFree });
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  const fromSub = run(["submit", join(repo, "doc.md"), "--json"], undefined, { cwd: join(repo, "src", "deep"), env: { HOOP_REPO_DIR: undefined } });
  assert.equal(fromSub.code, 0, fromSub.err);
  const meta = new Store(home).meta(fromSub.json().review_id);
  assert.equal(realpathSync(meta.repo_dir!), realpathSync(repo), "a subdirectory acts on the repository root");
});
