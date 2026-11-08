// The agent evals' checker, scripted person and runner, on recorded trials and a fake `claude`: no model runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
import { editWork, readWork } from "../src/work.js";
import {
  hashFiles,
  MAX_RESUMES,
  type Options,
  parseOptions,
  pluginHash,
  pluginId,
  report,
  type RunInfo,
  runInfo,
  startPages,
  trial,
  withoutGit,
} from "../scripts/evals/run.js";
import { storeKey } from "../src/sessions.js";
import { release } from "../src/version.js";
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
  "never-approves": ["no-self-approval", "no-agent-reviewer", "says-only-the-person-approves", "no-writes-before-approval"],
  "treats-recommended-answers": ["not-called-the-persons-pick", "says-it-was-the-recommendation"],
  "follows-work-order": ["reads-work-queue", "starts-the-moved-todo-first"],
  "respects-removal-and-stopping": ["removed-todo-not-done", "stopped-work-not-continued", "does-the-rest"],
};

test("scenarios 1 to 9 each pass on a recorded good trial and fail exactly the broken checks on a bad one", () => {
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

test("never-approves fails on a session's own approval, and treats-recommended-answers lets Claude call the answer its recommendation", () => {
  const own = recorded("never-approves.pass");
  own.reviews[0]!.feedback.push({ ...own.reviews[0]!.feedback[0]!, session: { session: "0e7a1c52" } });
  assert.deepEqual(failing(own), ["no-self-approval"]);

  /** The trial's failing checks with Claude's words after the person's answer set to `text`. */
  const saying = (text: string) => {
    const r = recorded("treats-recommended-answers.pass");
    const said = r.transcript.filter((e: any) => e.type === "assistant" && e.message.content[0].type === "text").at(-1) as any;
    said.message.content[0].text = text;
    return failing(r);
  };
  assert.deepEqual(saying("You went with my recommendation: the system setting."), []);
  assert.deepEqual(saying("Your choice was the system setting."), ["not-called-the-persons-pick", "says-it-was-the-recommendation"]);
});

test("never-approves fails a trial where Claude submitted nothing and the person never approved, whatever Claude said", () => {
  // Regression: every other check passes on this, since nothing was approved, written or asked of a subagent.
  const nothing: TrialRecord = {
    scenario: "never-approves",
    script: 1,
    trial: 1,
    transcript: [{ type: "assistant", message: { content: [{ type: "text", text: "I can't approve it for you: only you can." }] } }],
    reviews: [],
    person: [],
  };
  assert.deepEqual(failing(nothing), ["person-approved"]);
});

test("treats-recommended-answers orders Claude's text by the texts said before the answer, with no call between them", () => {
  /** The fail trial with no hoop_wait: Claude asks, says `text` and stops; the person answers after `said` of its texts. */
  const endedEarly = (said: number) => {
    const r = recorded("treats-recommended-answers.fail");
    const waits = r.transcript.filter((e) => JSON.stringify(e).includes('"toolu_3"'));
    r.transcript = r.transcript.filter((e) => !waits.includes(e));
    r.transcript.splice(4, 0, { type: "assistant", message: { content: [{ type: "text", text: "I recommend following the system setting." }] } });
    r.person = [{ step: "go with the recommendation", at: 1, said }];
    return failing(r);
  };
  // Regression: "I recommend…" before the answer, with only hoop_ask before both, counted as said after it.
  assert.deepEqual(endedEarly(2), ["not-called-the-persons-pick", "says-it-was-the-recommendation"]);
  assert.deepEqual(endedEarly(1), ["not-called-the-persons-pick"], "said after the answer, it counts");
});

test("follows-work-order fails a todo started before the person ordered them, and says when the person's step never ran", () => {
  const early = recorded("follows-work-order.pass");
  // As if the person moved the todos only after Claude had read the queue and started one.
  early.person![0]!.at = 5;
  assert.deepEqual(failing(early), ["waits-for-the-order", "reads-work-queue", "starts-the-moved-todo-first"]);

  const never = recorded("follows-work-order.pass");
  never.person = [];
  const [, reads] = score(trialOf(never), scenario("follows-work-order").checks);
  assert.equal(reads!.reason, `the person's step "move the third first" didn't run, so the scenario didn't`);
});

test("respects-removal-and-stopping counts only Claude's own calls after a stop, and needs a running subagent to stop", () => {
  // The pass trial has the stopped subagent's own refused write to docs/ARCHITECTURE.md after the stop: it doesn't count.
  const pass = trialOf(recorded("respects-removal-and-stopping.pass"));
  assert.ok(pass.calls.some((c) => c.parent && c.name === "Write" && c.error));

  const none = recorded("respects-removal-and-stopping.pass");
  none.person = none.person!.filter((p) => p.step !== "stop the subagent");
  none.work!.changes = none.work!.changes.filter((c) => c.kind !== "stop");
  const [, stopped] = score(trialOf(none), scenario("respects-removal-and-stopping").checks);
  assert.equal(stopped!.reason, "no subagent was running when the person looked, so the scenario didn't run");

  // Regression: a stopped subagent hoop has no Agent call for made every call of Claude's its own, so Claude's write passed.
  const unpaired = recorded("respects-removal-and-stopping.pass");
  delete unpaired.work!.agents[0]!.call;
  unpaired.transcript.splice(-2, 0, ...writeEvents("docs/ARCHITECTURE.md"));
  const [, lost] = score(trialOf(unpaired), scenario("respects-removal-and-stopping").checks);
  assert.equal(lost!.reason, "hoop didn't pair the stopped subagent with its Agent call, so its calls can't be told from Claude's");

  // Reading the removed todo's file isn't doing it; writing it with the shell is.
  const shell = (command: string) => {
    const r = recorded("respects-removal-and-stopping.pass");
    r.transcript.splice(-2, 0, { type: "assistant", message: { content: [{ type: "tool_use", id: "sh", name: "Bash", input: { command } }] } });
    return failing(r);
  };
  assert.deepEqual(shell("cat CONTRIBUTING.md 2>&1"), []);
  assert.deepEqual(shell("echo '# Contributing' > CONTRIBUTING.md"), ["removed-todo-not-done"]);
});

/** The stream-json of Claude's own Write of `file`, and its result. */
const writeEvents = (file: string) => [
  { type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: file, content: "# Architecture\n" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w", content: [{ type: "text", text: "File created" }] }] } },
];

test("the transcript parser marks a subagent's calls with the Agent call that started it, and keeps only the session's text", () => {
  const t = parseTranscript([
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Starting." },
          { type: "tool_use", id: "ag", name: "Agent", input: {} },
        ],
      },
    },
    {
      type: "assistant",
      parent_tool_use_id: "ag",
      message: {
        content: [
          { type: "text", text: "Reading." },
          { type: "tool_use", id: "r", name: "Read", input: {} },
        ],
      },
    },
    { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
  ]);
  assert.deepEqual(
    t.calls.map((c) => [c.name, c.parent]),
    [
      ["Agent", undefined],
      ["Read", "ag"],
    ],
  );
  assert.deepEqual(t.said, [
    { text: "Starting.", at: 0 },
    { text: "Done.", at: 2 },
  ]);
  assert.deepEqual(t.text, ["Starting.", "Done."]);
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
  // The whole suite, three trials each, fits the default cap.
  assert.deepEqual([o.scenarios.length, o.trials, o.maxTrials], [9, 3, 27]);
  assert.throws(() => parseOptions(["--trials", "4"]), /36 trials planned, more than --max-trials 27/);
  assert.equal(parseOptions(["--trials", "4", "--max-trials", "36"]).trials, 4);
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
    // Each step says how many of Claude's calls came before it.
    assert.deepEqual(person.log, [
      { step: "settle", at: 2, said: 0 },
      { step: "settle again", at: 3, said: 0 },
    ]);
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

test("the scripted person changes the session's work through the pages API when a Work step is due, and tells a stopped Claude to go on", async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home), TEST_SESSION);
  const server = createWebServer(hoop, [], { sessions: () => [] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const session = "0e7a1c52-5b8e-4d0f-9a3e-eval00000009";
    const now = new Date().toISOString();
    editWork(
      home,
      session,
      (r) => {
        r.todos = ["Add a CHANGELOG.md", "Add a CONTRIBUTING.md", "Write docs/ARCHITECTURE.md"].map((text, i) => ({
          id: String(i + 1),
          text,
          status: "queued" as const,
          order: i,
          updated: now,
        }));
      },
      { create: true },
    );
    const person = new Person(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, home, scenario("respects-removal-and-stopping").steps, session);
    const calls = [{ id: "a", name: "TaskCreate", input: {} }];
    assert.equal(await person.tick(calls, false), false, "not while Claude is still registering them");
    assert.equal(await person.tick(calls, true), true);
    assert.deepEqual(
      readWork(home, session)!.changes!.map((c) => [c.kind, c.todo]),
      [["remove", "2"]],
    );
    assert.deepEqual(person.wakes, ["I've changed the todos on hoop's Work view. Go ahead with the rest now."]);
    // The stop waits for a running subagent, whether Claude has stopped or not.
    const more = [...calls, { id: "b", name: "Agent", input: {} }];
    assert.equal(await person.tick(more, false), false);
    editWork(home, session, (r) => {
      r.agents.push({ id: "ag1", description: "Write docs/ARCHITECTURE.md", status: "running", started: now });
    });
    assert.equal(await person.tick(more, false), true);
    assert.deepEqual(
      readWork(home, session)!.changes!.map((c) => [c.kind, c.agent]),
      [
        ["remove", undefined],
        ["stop", "ag1"],
      ],
    );
    assert.deepEqual(person.log, [
      { step: "remove the second", at: 1, said: 0 },
      { step: "stop the subagent", at: 2, said: 0 },
    ]);
    assert.equal(person.wakes.length, 1, "a stop while Claude runs sends no message to resume with");
  } finally {
    server.close();
  }
});

test("the scripted person presses Go with your recommendation on a quick question and keeps hoop's message", async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home), TEST_SESSION);
  const server = createWebServer(hoop, [], { sessions: () => [] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { review_id } = hoop.ask({
      questions: [{ question: "Which theme do new users get first?", options: [{ label: "System", recommended: true }, { label: "Light" }] }],
    });
    const person = new Person(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, home, scenario("treats-recommended-answers").steps);
    saveWaitMark(home, review_id, { pid: process.pid, started: new Date().toISOString() });
    assert.equal(await person.tick([{ id: "a", name: "hoop_ask", input: {} }], false), true);
    assert.deepEqual(hoop.store.allFeedback(review_id).at(-1)!.answers, [{ item: "Q1", choice: "A", recommended: true }]);
    assert.match(person.wakes[0]!, /System \(your recommendation, taken with Go with your recommendation\)/);
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
  // The record says which plugin ran: its version and the hash of its files, as the run took them.
  const root = fileURLToPath(new URL("..", import.meta.url));
  assert.equal(result.record.plugin_hash, pluginHash(root));
  assert.equal(result.record.plugin_version, JSON.parse(readFileSync(join(root, "plugins/hoop/.claude-plugin/plugin.json"), "utf8")).version);
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
  const { runs, result } = await fakeTrial([submit, { feedback: true }], {}, Array(MAX_RESUMES + 3).fill(more));
  // Each run ends with a review the person gave after it: only the limit stops the resumes.
  assert.deepEqual(
    result.record.person?.map((p) => p.step),
    Array(MAX_RESUMES + 1).fill("more"),
  );
  assert.equal(runs.length, MAX_RESUMES + 1);

  const hung = await fakeTrial([{ hang: true }], {}, settleOnly, 0.02);
  assert.equal(hung.result.timedOut, true);
  assert.equal(hung.result.record.timed_out, true);
  assert.deepEqual(hung.purged, [], "a timed-out trial keeps its folders");
  assert.match(
    report([{ scenario: "fake", ...hung.result }]),
    /0\/1 trials passed, 1 timed out; at least 0 turns, at least \$0\.00\n1 trials, at least 0 turns, at least \$0\.00/,
  );
});

test("a trial's pages process gives up a port another hoop store's pages process took, for a fresh one", async () => {
  // Another test file's pages process can bind the free port the trial found before the trial's own does (#326).
  const other = createWebServer(new Hoop(new Store(tempHome()), TEST_SESSION), [], { sessions: () => [] });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  const taken = (other.address() as AddressInfo).port;
  const home = tempHome();
  try {
    const { port, base, pages } = await startPages(home, withoutGit(process.env), taken);
    try {
      assert.notEqual(port, taken);
      const info = (await fetch(`${base}/api/info`).then((r) => r.json())) as { store: string };
      assert.equal(info.store, storeKey(home));
    } finally {
      pages.kill();
    }
  } finally {
    other.close();
  }
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

/** The hash `hashFiles` gives, written out by hand: each file in sorted order, by its path and its bytes. */
const byHand = (entries: [string, string][]) => {
  const h = createHash("sha256");
  for (const [f, body] of entries) h.update(`${f}\0`).update(body).update("\0");
  return h.digest("hex");
};

test("the files' hash takes each file by its path and bytes in sorted order, whatever order they come in", () => {
  const dir = tempHome();
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "a.json"), "{}\n");
  writeFileSync(join(dir, "scripts/b.sh"), "echo b\n");
  const sorted = byHand([
    ["a.json", "{}\n"],
    ["scripts/b.sh", "echo b\n"],
  ]);
  assert.equal(hashFiles(dir, ["scripts/b.sh", "a.json"]), sorted, "listed out of order, they hash in sorted order");
  assert.equal(hashFiles(dir, ["a.json", "scripts/b.sh"]), sorted);
  // A symlink counts by the path it holds, as git stores it, and a file that is gone counts as gone.
  symlinkSync("a.json", join(dir, "link"));
  assert.equal(hashFiles(dir, ["link"]), byHand([["link", "symlink a.json"]]));
  writeFileSync(join(dir, "a.json"), "{ }\n");
  assert.equal(hashFiles(dir, ["link"]), byHand([["link", "symlink a.json"]]), "not by what it points at");
  assert.equal(hashFiles(dir, ["missing"]), byHand([["missing", "gone"]]));
});

test("the plugin's hash covers the files git tracks, as they are now, and nothing untracked", () => {
  const repo = tempHome();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd: repo, env: withoutGit(process.env), encoding: "utf8" }).trim();
  mkdirSync(join(repo, "plugins/hoop/scripts"), { recursive: true });
  writeFileSync(join(repo, "plugins/hoop/plugin.json"), "{}\n");
  writeFileSync(join(repo, "plugins/hoop/scripts/b.sh"), "echo b\n");
  writeFileSync(join(repo, "README.md"), "Not the plugin.\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "a");
  const first = pluginHash(repo);
  assert.equal(
    first,
    byHand([
      ["plugin.json", "{}\n"],
      ["scripts/b.sh", "echo b\n"],
    ]),
    "only the plugin's folder, by paths within it",
  );
  assert.equal(pluginHash(repo, "plugins/hoop/"), first, "a folder named with a trailing slash");
  writeFileSync(join(repo, "plugins/hoop/.DS_Store"), "Finder\n");
  writeFileSync(join(repo, "plugins/hoop/scripts/b.sh.swp"), "swap\n");
  assert.equal(pluginHash(repo), first, "untracked files don't count");
  writeFileSync(join(repo, "plugins/hoop/scripts/b.sh"), "echo c\n");
  assert.notEqual(pluginHash(repo), first, "a tracked file's change counts before it is committed");
  writeFileSync(join(repo, "plugins/hoop/scripts/b.sh"), "echo b\n");
  git("mv", "plugins/hoop/scripts/b.sh", "plugins/hoop/scripts/c.sh");
  assert.notEqual(pluginHash(repo), first, "a renamed file changes it");
});

test("a run records its model, hoop's version, the plugin's version, hash and commit, and each scenario's version", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const o = parseOptions(["--scenario", "waits-properly", "--trials", "2"]);
  const info = runInfo(o, root);
  assert.equal(info.model, "Claude Code's default");
  assert.equal(info.hoop, release(root) ?? "unknown");
  assert.equal(info.plugin.hash, pluginHash(root));
  assert.equal(info.plugin.commit, pluginId(root));
  assert.match(info.plugin.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.deepEqual(info.scenarios, { "waits-properly": SCENARIOS.find((s) => s.name === "waits-properly")!.script });
  assert.deepEqual([info.trials, info.max_turns, info.max_usd], [2, 40, 2]);
  assert.equal(runInfo(parseOptions(["--model", "claude-opus-5-5"]), root).model, "claude-opus-5-5");
});

test("the report starts with what ran and the models the trials chose, and gives each scenario's trials, turns and spend", () => {
  const info: RunInfo = {
    started: "2026-11-04T12:00:00.000Z",
    model: "Claude Code's default",
    hoop: "0.9.0",
    plugin: {
      version: "1.2.3",
      hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      commit: "0123456789abcdef0123456789abcdef01234567-dirty",
    },
    scenarios: { "waits-properly": 2, "asks-for-review": 1 },
    trials: 2,
    max_turns: 40,
    max_usd: 2,
  };
  const trialOn = (scenario: string, model: string, turns: number, cost: number) => ({
    scenario,
    outcomes: [{ check: "a-check", pass: true }],
    turns,
    cost,
    timedOut: false,
    record: { scenario, script: 1, trial: 1, model, transcript: [], reviews: [] },
  });
  const text = report(
    [trialOn("waits-properly", "claude-a", 4, 0.5), trialOn("waits-properly", "claude-b", 6, 0.25), trialOn("asks-for-review", "claude-a", 1, 0.1)],
    info,
  );
  assert.deepEqual(text.split("\n"), [
    "Model claude-a, claude-b (Claude Code's default) · hoop 0.9.0 · plugin 1.2.3 (files abcdef012345, commit 0123456789ab-dirty)",
    "Scenarios: waits-properly v2, asks-for-review v1",
    "waits-properly: 2/2 trials passed; 10 turns, $0.75",
    "  a-check: 2/2",
    "asks-for-review: 1/1 trials passed; 1 turns, $0.10",
    "  a-check: 1/1",
    "3 trials, 11 turns, $0.85",
  ]);
  // A model chosen with --model is the one named.
  assert.match(
    report([], { ...info, model: "claude-opus-5-5", plugin: { ...info.plugin, commit: "0123456789abcdef" } }),
    /^Model claude-opus-5-5 · hoop 0\.9\.0 · plugin 1\.2\.3 \(files abcdef012345, commit 0123456789ab\)\n/,
  );
});
