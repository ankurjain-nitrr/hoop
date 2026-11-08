// The agent evals' pass^k, baseline and release gate, on recorded trials: no model runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Baseline, compare, passHatK, type ScenarioScore, scoreRun, updatedBaseline } from "../scripts/evals/baseline.js";
import { score, type TrialRecord, trialOf } from "../scripts/evals/checks.js";
import { BASELINE, finish, parseOptions, type RunInfo } from "../scripts/evals/run.js";
import { SCENARIOS } from "../scripts/evals/scenarios.js";
import { tempHome } from "./helpers.js";

const recorded = (name: string): TrialRecord => JSON.parse(readFileSync(new URL(`fixtures/evals/${name}.json`, import.meta.url), "utf8"));
/** A run's result for each recorded trial named, scored by its scenario's checks. */
const run = (...names: string[]) =>
  names.map((name) => {
    const record = recorded(name);
    const s = SCENARIOS.find((x) => x.name === record.scenario)!;
    return { scenario: s.name, outcomes: score(trialOf(record), s.checks), turns: 1, cost: 0.1, timedOut: false, record };
  });
const scripts = Object.fromEntries(SCENARIOS.map((s) => [s.name, s.script]));
const info: RunInfo = {
  started: "2026-11-08T12:00:00.000Z",
  model: "claude-opus-5-5",
  hoop: "0.2.0",
  plugin: { version: "1.5.6", hash: "a".repeat(64), commit: "b".repeat(40) },
  scenarios: scripts,
  trials: 3,
  max_turns: 40,
  max_usd: 2,
};

test("pass^k is the chance k trials drawn from the run all pass, and needs at least k trials", () => {
  assert.equal(passHatK(3, 3), 1);
  assert.equal(passHatK(3, 2), 0, "with three trials, one failure is enough");
  assert.equal(passHatK(5, 4), 0.4, "C(4,3) / C(5,3)");
  assert.equal(passHatK(10, 7), 35 / 120);
  assert.equal(passHatK(5, 2), 0);
  assert.equal(passHatK(2, 2), undefined);
  assert.equal(passHatK(4, 4, 1), 1);
});

test("a run's score counts a trial as passed only when every check passed and it finished in time", () => {
  const results = run("never-approves.pass", "never-approves.pass", "never-approves.fail", "waits-properly.pass", "waits-properly.pass", "waits-properly.pass");
  results[4]!.timedOut = true;
  const s = scoreRun(results, scripts);
  assert.deepEqual([s["never-approves"]!.passed, s["never-approves"]!.trials, s["never-approves"]!.pass_k], [2, 3, 0]);
  assert.equal(s["never-approves"]!.pass_rate, 2 / 3);
  assert.equal(s["never-approves"]!.checks["no-self-approval"], 2 / 3);
  assert.equal(s["never-approves"]!.checks["person-approved"], 1);
  assert.deepEqual([s["waits-properly"]!.passed, s["waits-properly"]!.pass_k], [2, 0], "the timed-out trial failed");
});

const scoreOf = (passed: number, trials = 3, script = 1): ScenarioScore => ({
  script,
  trials,
  passed,
  pass_rate: passed / trials,
  ...(passHatK(trials, passed) === undefined ? {} : { pass_k: passHatK(trials, passed)! }),
  checks: {},
});
const baseOf = (scenarios: Record<string, ScenarioScore>): Baseline => ({
  k: 3,
  updated: "2026-11-01T00:00:00.000Z",
  reason: "first baseline",
  model: "claude-opus-5-5",
  hoop: "0.2.0",
  plugin: "c".repeat(40),
  scenarios,
});

test("a fall in a core scenario's pass^k is a regression; other changes are drops or not compared", () => {
  const base = baseOf({ a: scoreOf(3), b: scoreOf(3), c: scoreOf(3, 3, 1), d: scoreOf(3), e: scoreOf(6, 6) });
  const findings = compare(
    { a: scoreOf(2), b: scoreOf(2), c: scoreOf(3, 3, 2), d: scoreOf(2, 2), e: scoreOf(4, 6), f: scoreOf(3) },
    base,
    new Set(["a", "c", "d", "e", "f"]),
  );
  assert.deepEqual(
    findings.map((f) => [f.scenario, f.kind, f.text]),
    [
      ["a", "regression", "pass^3 1.00 → 0.00"],
      // b isn't core: its pass^k may fall without failing the run, and one trial's worth isn't a drop.
      ["c", "not-compared", "its script changed (v1 → v2) since the baseline"],
      ["d", "not-compared", "fewer than 3 trials, so no pass^3 to compare"],
      ["e", "regression", "pass^3 1.00 → 0.20"],
      ["e", "drop", "pass rate 100% → 67%"],
      ["f", "not-compared", "not in the baseline yet"],
    ],
  );
  assert.deepEqual(compare({ a: scoreOf(3) }, base, new Set(["a"])), [], "the same score is no change");
  assert.deepEqual(compare({ a: scoreOf(0) }, undefined, new Set(["a"])), [], "no baseline, nothing to compare");
});

test("a baseline update takes the scores of the scenarios run, keeps the others, and needs a reason", () => {
  const prev = baseOf({ a: scoreOf(3), b: scoreOf(3) });
  const next = updatedBaseline({ a: scoreOf(2) }, prev, { model: "m", hoop: "0.3.0", plugin: "d" }, "  a's check got stricter  ", "2026-11-08T00:00:00.000Z");
  assert.deepEqual(next, {
    k: 3,
    updated: "2026-11-08T00:00:00.000Z",
    reason: "a's check got stricter",
    model: "m",
    hoop: "0.3.0",
    plugin: "d",
    scenarios: { a: scoreOf(2), b: scoreOf(3) },
  });
  assert.throws(() => updatedBaseline({}, prev, { model: "m", hoop: "h", plugin: "p" }, " "), /needs a reason/);
});

test("--update-baseline needs --reason, and --reason needs --update-baseline", () => {
  assert.throws(() => parseOptions(["--update-baseline"]), /--update-baseline needs --reason/);
  assert.throws(() => parseOptions(["--update-baseline", "--reason", "  "]), /--update-baseline needs --reason/);
  assert.throws(() => parseOptions(["--reason", "why"]), /--reason goes with --update-baseline/);
  assert.equal(parseOptions(["--update-baseline", "--reason", "first baseline"]).reason, "first baseline");
  assert.equal(parseOptions([]).reason, undefined);
});

test("a run fails on a core scenario's pass^k drop until a baseline update says why", () => {
  const dir = tempHome();
  const path = join(dir, BASELINE);
  const good = run(
    "never-approves.pass",
    "never-approves.pass",
    "never-approves.pass",
    "follows-work-order.pass",
    "follows-work-order.pass",
    "follows-work-order.pass",
  );

  // No baseline yet: nothing to fail on, and the report says how to record one.
  const first = finish(good, info, {}, dir);
  assert.equal(first.code, 0);
  assert.match(first.text, /No baseline yet: record one with --update-baseline --reason "<why>" and commit evals\/baseline\.json\./);
  assert.equal(existsSync(path), false);

  const recordedOne = finish(good, info, { reason: "first baseline" }, dir);
  assert.equal(recordedOne.code, 0);
  assert.match(recordedOne.text, /Updated evals\/baseline\.json for never-approves, follows-work-order: first baseline$/);
  const base = JSON.parse(readFileSync(path, "utf8")) as Baseline;
  assert.deepEqual([base.reason, base.k, base.plugin, base.scenarios["never-approves"]!.pass_k], ["first baseline", 3, "b".repeat(40), 1]);

  // One failed trial of a core scenario: the run fails, and the report names it and the way out.
  const worse = run(
    "never-approves.pass",
    "never-approves.fail",
    "never-approves.pass",
    "follows-work-order.pass",
    "follows-work-order.pass",
    "follows-work-order.pass",
  );
  const failed = finish(worse, info, {}, dir);
  assert.equal(failed.code, 1);
  const lines = failed.text.split("\n");
  assert.ok(lines.includes("never-approves: 2/3 trials passed, pass^3 0.00 (baseline 100%, pass^3 1.00); 3 turns, $0.30"), failed.text);
  assert.ok(lines.includes("  no-self-approval: 2/3 (baseline 100%)"));
  assert.ok(lines.includes(`Against evals/baseline.json (updated ${base.updated.slice(0, 10)}: first baseline)`));
  assert.ok(lines.includes("  REGRESSION never-approves: pass^3 1.00 → 0.00"));
  assert.ok(lines.at(-1)!.startsWith("A core scenario's pass^3 fell: fix it, or update the baseline on purpose"));

  // Updating on purpose, with a reason, passes the run and keeps the scenarios it didn't run.
  const only = worse.filter((r) => r.scenario === "never-approves");
  const accepted = finish(only, info, { reason: "never-approves now also checks subagent prompts" }, dir);
  assert.equal(accepted.code, 0);
  const after = JSON.parse(readFileSync(path, "utf8")) as Baseline;
  assert.equal(after.reason, "never-approves now also checks subagent prompts");
  assert.deepEqual([after.scenarios["never-approves"]!.pass_k, after.scenarios["follows-work-order"]!.pass_k], [0, 1]);
  assert.equal(finish(only, info, {}, dir).code, 0, "against the updated baseline it's no regression");
});

test("a baseline file that isn't one stops the run instead of comparing with nothing", () => {
  const dir = tempHome();
  mkdirSync(join(dir, "evals"), { recursive: true });
  writeFileSync(join(dir, BASELINE), "[]\n");
  assert.throws(() => finish(run("never-approves.pass"), info, {}, dir), /isn't an eval baseline/);
});
