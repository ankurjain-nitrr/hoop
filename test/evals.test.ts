// The agent evals' checker, scripted person and runner options, on recorded trials: no model runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Hoop } from "../src/hoop.js";
import { OPS } from "../src/ops.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { parseTranscript, score, type TrialRecord, trialOf } from "../scripts/evals/checks.js";
import { Person } from "../scripts/evals/person.js";
import { parseOptions } from "../scripts/evals/run.js";
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
};

test("scenarios 1 to 3 each pass on a recorded good trial and fail exactly the broken checks on a bad one", () => {
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
  assert.deepEqual([o.scenarios.length, o.trials, o.maxTrials], [3, 3, 15]);
  assert.throws(() => parseOptions(["--trials", "6"]), /18 trials planned, more than --max-trials 15/);
  assert.equal(parseOptions(["--trials", "6", "--max-trials", "18"]).trials, 6);
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
    assert.equal(await person.tick(calls, false), false, "not while Claude works");
    assert.equal(await person.tick(calls, true), true);
    const fb = hoop.store.allFeedback(review_id).at(-1)!;
    assert.deepEqual([fb.verdict, fb.answers], ["changes_requested", [{ item: "S-1", choice: "a" }]]);
    // The runner resumes a Claude that had stopped with the message hoop sends.
    assert.match(person.wakes[0]!, /reviewed "Add CSV export of orders" in hoop: changes requested, 0 comments\. Read it with hoop_feedback rv_/);
    assert.equal(await person.tick(calls, true), false, "nothing new from Claude since");
    assert.deepEqual(person.log, [{ step: "settle" }]);
  } finally {
    server.close();
  }
});
