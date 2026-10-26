// The agent evals' checker, scripted person and runner, on recorded trials and a fake `claude`: no model runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hoop } from "../src/hoop.js";
import { OPS } from "../src/ops.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { parseTranscript, type Revision, score, type TrialRecord, trialOf } from "../scripts/evals/checks.js";
import { Person, type Step, snapshot } from "../scripts/evals/person.js";
import { saveWaitMark } from "../src/wait.js";
import { MAX_RESUMES, type Options, parseOptions, pluginId, report, trial, withoutGit } from "../scripts/evals/run.js";
import { SCENARIOS } from "../scripts/evals/scenarios.js";
import { TEST_SESSION, tempHome } from "./helpers.js";

const recorded = (name: string): TrialRecord => JSON.parse(readFileSync(new URL(`fixtures/evals/${name}.json`, import.meta.url), "utf8"));
const scenario = (name: string) => SCENARIOS.find((s) => s.name === name)!;
const failing = (r: TrialRecord) =>
  score(trialOf(r), scenario(r.scenario).checks)
    .filter((o) => !o.pass)
    .map((o) => o.check);

// The checks each recorded failing trial breaks; every other check passes on it.
const FAILS: Record<string, string[]> = {
  "asks-for-review": ["title-names-the-decision", "questions-well-formed", "link-given-once"],
  "waits-properly": ["waits-with-cursor", "waits-again", "link-not-repeated", "no-writes-before-approval"],
  "answers-every-comment": ["every-comment-answered"],
  "uses-exact-edits": ["proposes-edits", "edits-apply", "only-that-line-changes"],
  "revises-after-changes": ["answer-kept", "waits-after-revision", "no-writes-before-approval"],
};

test("scenarios 1 to 5 each pass on a recorded good trial and fail exactly the broken checks on a bad one", () => {
  assert.deepEqual(
    SCENARIOS.map((s) => s.name),
    Object.keys(FAILS),
  );
  for (const [name, fails] of Object.entries(FAILS)) {
    assert.deepEqual(failing(recorded(`${name}.pass`)), [], `${name}.pass`);
    assert.deepEqual(failing(recorded(`${name}.fail`)), fails, `${name}.fail`);
  }
});

test("a proposed edit answers its comment, and a summary that says nothing fails", () => {
  const answered = recorded("answers-every-comment.pass");
  answered.reviews[0]!.edits = [];
  assert.deepEqual(failing(answered), ["every-comment-answered"]);

  const asks = recorded("asks-for-review.pass");
  asks.reviews[0]!.revisions[0]!.tldr = "A plan.";
  assert.deepEqual(failing(asks), ["has-a-summary"]);

  const twice = recorded("asks-for-review.pass");
  twice.reviews.push({ ...twice.reviews[0]!, id: "rv_other" });
  assert.deepEqual(failing(twice), ["one-review"]);
});

test("replies that only promise a change, after a request for changes, don't answer the comments", () => {
  // Recorded: Claude replied "Done in the next revision." and proposed one edit, with no revision 2.
  const promise = recorded("answers-every-comment.promise");
  assert.equal(promise.reviews[0]!.revisions.length, 1);
  assert.deepEqual(failing(promise), ["every-comment-answered"]);
});

test("a repository changed before approval fails, and so does a trial where no wait timed out", () => {
  const bash = recorded("waits-properly.pass");
  bash.dirty_before_approval = ["?? migrations/"];
  assert.deepEqual(failing(bash), ["no-writes-before-approval"]);

  const quick = recorded("waits-properly.pass");
  quick.transcript = JSON.parse(JSON.stringify(quick.transcript).replaceAll('\\"again\\":true', '\\"again\\":false'));
  const [, again] = score(trialOf(quick), scenario("waits-properly").checks);
  assert.equal(again!.reason, "no wait timed out, so the scenario didn't run");
});

test("an edit that no longer applies, or a change beside the rename, fails its own check", () => {
  const stale = recorded("uses-exact-edits.pass");
  stale.reviews[0]!.edits.push({ ...stale.reviews[0]!.edits[0]!, id: "ed_stale", status: "proposed" });
  assert.deepEqual(failing(stale), ["edits-apply"]);

  const more = recorded("uses-exact-edits.pass");
  const last = more.reviews[0]!.revisions.at(-1)!;
  last.lines = last.lines.map((l) => (l.item === "S-2" && l.line === 1 ? { ...l, text: l.text.replace("twice", "once") } : l));
  const [, , only] = score(trialOf(more), scenario("uses-exact-edits").checks);
  assert.equal(only!.reason, "revision 2 doesn't read as revision 1 with only the rename, at S-2 line 1");
});

test("only-that-line-changes judges the revision the accepted edit made, not a later one that writes in an answer", () => {
  const r = recorded("uses-exact-edits.pass");
  const revs = r.reviews[0]!.revisions;
  const question = [
    { item: "S-3", line: 0, text: "Question: Which storage?" },
    { item: "S-3", line: 1, text: "A. S3 (recommended)" },
  ];
  const [one, two] = revs as [Revision, Revision];
  // Revision 3 writes the answer in: the question's section becomes a statement.
  const answered = [
    { item: "S-3", line: 0, text: "Storage" },
    { item: "S-3", line: 1, text: "Archives go to S3." },
  ];
  revs.push({ ...two, revision: 3, lines: [...two.lines, ...answered] });
  one.lines.push(...question);
  two.lines.push(...question);
  assert.deepEqual(failing(r), []);
});

test("answer-kept reads the answered option from its stored revision and wants one line that names it and no other option", () => {
  /** answer-kept's reason on the pass trial with question S-2's options set to `labels` (B chosen) and its decision line set to `text`. */
  const kept = (text: string, labels?: [string, string], edit?: (r: TrialRecord) => void) => {
    const r = recorded("revises-after-changes.pass");
    const [first, second] = r.reviews[0]!.revisions as [Revision, Revision];
    if (labels) first.questions[0]!.choices.forEach((c, i) => (c.label = labels[i]!));
    second.lines.find((x) => x.item === "S-2" && x.line === 1)!.text = text;
    edit?.(r);
    return score(trialOf(r), scenario("revises-after-changes").checks).find((o) => o.check === "answer-kept")!.reason;
  };
  const no = /^no line of revision 2 names the person's choice/;
  // The person chose B "RabbitMQ on our own hosts": its name is rabbitmq, own and host, in any order and number.
  assert.equal(kept("RabbitMQ runs on a host we own."), undefined);
  assert.match(kept("We use Amazon SQS.") ?? "", no);
  // The chosen option named as the rejected one, beside the option taken, doesn't state it.
  assert.match(kept("We use Amazon SQS. We rejected RabbitMQ on our own hosts.") ?? "", no);
  // Part of the name doesn't state it.
  assert.match(kept("RabbitMQ.") ?? "", no);
  // A one-word option mentioned beside the option taken doesn't state it.
  assert.match(kept("We use Amazon SQS and keep job history in Postgres.", ["Amazon SQS", "Postgres"]) ?? "", no);
  assert.equal(kept("We use Postgres.", ["Amazon SQS", "Postgres"]), undefined);
  // Words every option or the heading has don't name one; the bracketed text does.
  const managed: [string, string] = ["Managed service (Amazon SQS)", "Managed service (RabbitMQ)"];
  assert.match(kept("We use a managed queue service.", managed) ?? "", no);
  assert.equal(kept("We use RabbitMQ.", managed), undefined);
  // The text outside square brackets, and the text before a dash without spaces, name it too.
  assert.equal(kept("We use RabbitMQ.", ["Amazon SQS", "[Self-hosted] RabbitMQ"]), undefined);
  assert.equal(kept("We use RabbitMQ.", ["Amazon SQS", "RabbitMQ—self-hosted"]), undefined);
  // An option whose name holds the chosen one's is another option.
  const standby: [string, string] = ["RabbitMQ on our own hosts, with a standby", "RabbitMQ"];
  assert.match(kept("RabbitMQ on our own hosts, with a standby.", standby) ?? "", no);
  assert.equal(kept("We use plain RabbitMQ.", standby), undefined);
  // The question still asked, or no revision after the answer, fails.
  const ok = "We run RabbitMQ on our own hosts.";
  assert.equal(
    kept(ok, undefined, (r) => r.reviews[0]!.revisions[1]!.questions.push(r.reviews[0]!.revisions[0]!.questions[0]!)),
    "revision 2 still asks question S-2",
  );
  assert.equal(
    kept(ok, undefined, (r) => r.reviews[0]!.revisions.pop()),
    "no revision after the person's answer on revision 1",
  );
});

test("revises-after-changes wants the rollback step the person asked for, in a later revision or an edit", () => {
  const dropped = recorded("revises-after-changes.pass");
  const second = dropped.reviews[0]!.revisions[1]!;
  second.lines = second.lines.filter((l) => !/roll back/i.test(l.text));
  assert.deepEqual(failing(dropped), ["comment-acted-on"]);
  // An edit proposed on the comment acts on it too.
  const edited = recorded("revises-after-changes.pass");
  edited.reviews[0]!.revisions[1]!.lines = second.lines;
  const thread = edited.reviews[0]!.threads[0]!.thread;
  edited.reviews[0]!.edits = [{ id: "ed_x", thread, status: "proposed", find: "first.", replace: "first, with a rollback." }];
  assert.deepEqual(failing(edited), []);
});

test("a reply without a revision, or a new review, doesn't revise the review the person answered", () => {
  const replied = recorded("revises-after-changes.pass");
  replied.reviews[0]!.revisions.pop();
  replied.transcript = replied.transcript.filter((e: any) => !JSON.stringify(e).includes("base_revision"));
  assert.deepEqual(failing(replied), ["revises-the-same-review", "answer-kept", "waits-after-revision", "comment-acted-on"]);

  const twice = recorded("revises-after-changes.pass");
  twice.reviews.push({ ...twice.reviews[0]!, id: "rv_other" });
  assert.deepEqual(failing(twice), ["one-review"]);
});

test("a failure names its reason and shows the calls around the one at fault", () => {
  const [, , , writes] = score(trialOf(recorded("waits-properly.fail")), scenario("waits-properly").checks);
  assert.equal(writes!.reason, "Write before the person approved");
  assert.ok(writes!.around!.some((l) => l.startsWith("> Write")));
  assert.ok(writes!.around!.some((l) => l.startsWith("  hoop_submit")));
});

test("the transcript parser strips hoop's MCP prefix, parses results and sums each run's turns and spend", () => {
  const t = parseTranscript([
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hi" },
          { type: "tool_use", id: "a", name: "mcp__plugin_hoop_hoop__hoop_wait", input: { review_id: "rv_1" } },
        ],
      },
    },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: '{"again":true}' }] }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "b", name: "Write", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", content: "denied", is_error: true }] } },
    { type: "result", num_turns: 3, total_cost_usd: 0.25 },
    { type: "result", num_turns: 2, total_cost_usd: 0.5 },
  ]);
  assert.deepEqual(t.text, ["Hi"]);
  assert.deepEqual(
    t.calls.map((c) => [c.name, c.result, c.error ?? false]),
    [
      ["hoop_wait", { again: true }, false],
      ["Write", "denied", true],
    ],
  );
  assert.deepEqual([t.turns, t.cost], [5, 0.75]);
});

test("the runner caps a run with --max-trials and refuses unknown scenarios and options", () => {
  const o = parseOptions([]);
  assert.deepEqual([o.scenarios.length, o.trials, o.maxTrials], [5, 3, 15]);
  assert.throws(() => parseOptions(["--trials", "4"]), /20 trials planned, more than --max-trials 15/);
  assert.equal(parseOptions(["--trials", "4", "--max-trials", "20"]).trials, 4);
  const one = parseOptions(["--scenario", "waits-properly", "--model", "claude-opus-5-5", "--max-turns", "10"]);
  assert.deepEqual([one.scenarios.map((s) => s.name), one.model, one.maxTurns], [["waits-properly"], "claude-opus-5-5", 10]);
  assert.throws(() => parseOptions(["--scenario", "nope"]), /no scenario nope/);
  assert.throws(() => parseOptions(["--trials", "0"]), /--trials takes a positive number/);
  assert.throws(() => parseOptions(["--bogus"]), /Unknown option '--bogus'/);
});

test("the scripted person reviews through the pages API only when Claude is idle and did something since", async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home), TEST_SESSION);
  const server = createWebServer(hoop, [], { sessions: () => [] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const markdown =
      "# Add CSV export of orders\n\nThe export plan.\n\n## Question: How should it reach people?\n\n- A. Stream it (recommended)\n- B. Email a link\n";
    const { review_id } = OPS.find((o) => o.name === "submit")!.run(hoop, { markdown }, { actor: "claude" }) as { review_id: string };
    const person = new Person(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, home, scenario("asks-for-review").steps);
    const calls = [{ id: "a", name: "hoop_submit", input: { markdown } }];
    // A hoop_wait call in the transcript isn't a wait yet: only hoop's mark of it is.
    const waiting = [...calls, { id: "b", name: "hoop_wait", input: { review_id } }];
    assert.equal(await person.tick(waiting, false), false, "not until hoop records the wait");
    saveWaitMark(home, review_id, { pid: process.pid, started: new Date().toISOString() });
    assert.equal(await person.tick(waiting, false), true);
    const fb = hoop.store.allFeedback(review_id).at(-1)!;
    assert.deepEqual([fb.verdict, fb.answers], ["changes_requested", [{ item: "S-1", choice: "a" }]]);
    // The runner resumes a Claude that had stopped with the message hoop sends.
    assert.match(person.wakes[0]!, /reviewed "Add CSV export of orders" in hoop: changes requested, 0 comments\. Read it with hoop_feedback rv_/);
    assert.equal(await person.tick(waiting, true), false, "nothing new from Claude since");
    // The review isn't approved yet, so once Claude does something the second settle runs.
    assert.equal(await person.tick([...waiting, { id: "c", name: "hoop_feedback", input: {} }], true), true);
    assert.deepEqual(person.log, [{ step: "settle" }, { step: "settle again" }]);
  } finally {
    server.close();
  }
});

test("the scripted person accepts the edits that still apply, read afresh, leaves a stale one proposed and stops on any other refusal", async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home), TEST_SESSION);
  const server = createWebServer(hoop, [], { sessions: () => [] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const markdown = "# Archive old orders nightly\n\nThe archive plan.\n\n## Job\n\nThe archiveWorker runs at 02:00.\n";
    const { review_id } = OPS.find((o) => o.name === "submit")!.run(hoop, { markdown }, { actor: "claude" }) as { review_id: string };
    const fb = hoop.review(review_id, { verdict: "changes_requested", comments: [{ item: "S-1", line: 1, body: "Rename it." }], answers: [] }, true);
    const thread = fb.comments[0]!.thread!;
    const person = new Person(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, home, []);
    // The view the person's step was given, from before Claude proposed: acceptEdits reads the edits afresh.
    const before = person.view()!;
    // Two edits over the same words: once the first is accepted, the second's text is gone.
    hoop.proposeEdits(review_id, thread, [{ item: "S-1", line: 1, find: "archiveWorker", replace: "orderArchiver" }]);
    hoop.proposeEdits(review_id, thread, [{ item: "S-1", line: 1, find: "archiveWorker runs", replace: "job runs" }]);
    const after = await person.acceptEdits(before);
    assert.deepEqual(
      after.record.edits.map((e) => e.status),
      ["accepted", "proposed"],
    );
    assert.equal(after.latest.lines.at(-1)!.text, "The orderArchiver runs at 02:00.");
    // A refusal that isn't a stale line is the harness's, not Claude's: it reaches the step, which stops the person.
    const title = hoop.review(review_id, { verdict: "changes_requested", comments: [{ item: "DOC", line: 1, body: "Say move." }], answers: [] }, true);
    hoop.proposeEdits(review_id, title.comments[0]!.thread!, [{ item: "DOC", line: 1, find: "Archive", replace: "Move" }]);
    hoop.store.update(review_id, { status: "approved" });
    await assert.rejects(person.acceptEdits(after), /is approved and frozen/);
  } finally {
    server.close();
  }
});

test("the scripted person waits on a review hoop has recorded but not yet given its first revision", async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home), TEST_SESSION);
  const markdown = "# Export orders as CSV\n\nThe plan.\n\n## Endpoint\n\nGET /orders/export.\n";
  const { review_id } = OPS.find((o) => o.name === "submit")!.run(hoop, { markdown }, { actor: "claude" }) as { review_id: string };
  // The state between Store.create writing review.json and its first revision: no revision yet.
  const dir = hoop.store.dirOf(review_id);
  const meta = JSON.parse(readFileSync(join(dir, "review.json"), "utf8"));
  writeFileSync(join(dir, "review.json"), JSON.stringify({ ...meta, revisions: 0 }));
  rmSync(join(dir, "rev-1.json"));
  assert.deepEqual(snapshot(home), []);
  const person = new Person("http://127.0.0.1:1", home, scenario("asks-for-review").steps);
  assert.equal(await person.tick([{ id: "a", name: "hoop_submit", input: { markdown } }], true), false);
  assert.deepEqual(person.log, []);
});

/** Runs one trial against the fake `claude`, which plays `plan`, and returns its result and each run's arguments. */
async function fakeTrial(plan: unknown[], o: Partial<Options>, steps: Step[], minutes = 1) {
  const dir = tempHome();
  const log = join(dir, "claude.log");
  Object.assign(process.env, {
    CLAUDE_BIN: fileURLToPath(new URL("fixtures/evals/fake-claude.mjs", import.meta.url)),
    FAKE_LOG: log,
    FAKE_PLAN: JSON.stringify(plan),
  });
  const s = { name: "fake", script: 1, prompt: "Plan it.", minutes, steps, checks: [] };
  const result = await trial(s, 1, { scenarios: [s], trials: 1, maxTurns: 10, maxUsd: 1, maxTrials: 1, ...o }, dir, 50);
  const runs = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[]);
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  return { result, runs: runs.filter((r) => r[0] !== "purge"), purged: runs.filter((r) => r[0] === "purge").map((r) => r.at(-1)!), flag };
}
const submit = { submit: "# Export orders as CSV\n\nThe plan for the export, in one section.\n\n## Endpoint\n\nGET /orders/export.\n", turns: 3, cost: 0.25 };
const settleOnly: Step[] = [{ name: "settle", act: (p, v) => p.settle(v) }];

test("a trial resumes Claude with hoop's message, within the turns and spend left, and cleans up after a pass", async () => {
  // Under a git hook GIT_DIR names the hook's repository; the trial's git commands must not touch it.
  const decoy = tempHome();
  execFileSync("git", ["init", "-q", decoy], { env: withoutGit(process.env) });
  process.env.GIT_DIR = join(decoy, ".git");
  const { result, runs, purged, flag } = await fakeTrial([submit, { turns: 2, cost: 0.1 }], {}, settleOnly).finally(() => delete process.env.GIT_DIR);
  assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: decoy, env: withoutGit(process.env) }).status, 128, "the decoy got a commit");
  assert.equal(runs.length, 2);
  const [first, second] = runs as [string[], string[]];
  assert.deepEqual([flag(first, "--max-turns"), flag(first, "--max-budget-usd")], ["10", "1.00"]);
  assert.equal(flag(second, "--resume"), flag(first, "--session-id"));
  assert.match(flag(second, "-p")!, /reviewed "Export orders as CSV" in hoop: approved, 0 comments/);
  assert.deepEqual([flag(second, "--max-turns"), flag(second, "--max-budget-usd")], ["7", "0.75"]);
  assert.deepEqual([result.turns, result.cost, result.timedOut], [5, 0.35, false]);
  assert.equal(result.record.reviews[0]!.status, "approved");
  // The trial passed, so Claude Code's state for its repository is purged and its folders are gone.
  assert.equal(purged.length, 1);
  assert.equal(existsSync(purged[0]!), false);
});

test("a trial isn't resumed once its turns are spent or a run stopped at a limit", async () => {
  for (const [plan, o] of [
    [[submit], { maxTurns: 3 }],
    [[{ ...submit, turns: 1, subtype: "error_max_budget_usd" }], {}],
  ] as const) {
    const { runs, result } = await fakeTrial([...plan], o, settleOnly);
    assert.equal(runs.length, 1, JSON.stringify(o));
    assert.equal(result.record.reviews[0]!.status, "approved", "the person still reviewed");
  }
});

test("a trial resumes at most MAX_RESUMES times, and a run past the deadline is killed and marked timed out", async () => {
  const more: Step = { name: "more", act: (p, v) => p.review(v, { verdict: "changes_requested", comments: [{ item: "DOC", line: 1, body: "More." }] }) };
  const { runs } = await fakeTrial([submit, { feedback: true }], {}, Array(MAX_RESUMES + 3).fill(more));
  assert.equal(runs.length, MAX_RESUMES + 1);

  const hung = await fakeTrial([{ hang: true }], {}, settleOnly, 0.02);
  assert.equal(hung.result.timedOut, true);
  assert.equal(hung.result.record.timed_out, true);
  assert.deepEqual(hung.purged, [], "a timed-out trial keeps its folders");
  assert.match(report([{ scenario: "fake", ...hung.result }]), /0\/1 trials passed, 1 timed out\n1 trials, at least 0 turns, at least \$0\.00/);
});

test("a trial records the plugin's commit, marked dirty when the checkout has changes", () => {
  const dir = tempHome();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd: dir, env: withoutGit(process.env), encoding: "utf8" }).trim();
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "a");
  assert.equal(pluginId(dir), git("rev-parse", "HEAD"));
  writeFileSync(join(dir, "a.txt"), "b\n");
  assert.equal(pluginId(dir), `${git("rev-parse", "HEAD")}-dirty`);
});
