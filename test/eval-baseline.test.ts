// The agent evals' pass^k, baseline and release gate, on recorded trials: no model runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Baseline, type BaselineEntry, compare, passHatK, type ScenarioScore, scoreRun, updatedBaseline } from "../scripts/evals/baseline.js";
import { score, type TrialRecord, trialOf } from "../scripts/evals/checks.js";
import { BASELINE, finish, type Options, parseOptions, preflight, type RunInfo, withoutGit } from "../scripts/evals/run.js";
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
/** Three passing trials of each scenario named. */
const thrice = (...scenarios: string[]) => run(...scenarios.flatMap((s) => [`${s}.pass`, `${s}.pass`, `${s}.pass`]));
/** The results with each trial reporting `model` as the one it ran on. */
const onModel = (results: ReturnType<typeof run>, model: string) => results.map((r) => ({ ...r, record: { ...r.record, model } }));
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
/** A run's end in the checkout `dir`, with the baseline read before it as the runner reads it. */
const end = (results: ReturnType<typeof run>, o: Pick<Options, "reason" | "release">, dir: string, runInfo = info) =>
  finish(results, runInfo, o, preflight({}, dir), dir);
const readBack = (dir: string) => JSON.parse(readFileSync(join(dir, BASELINE), "utf8")) as Baseline;

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
const PROVENANCE = {
  updated: "2026-11-01T00:00:00.000Z",
  reason: "first baseline",
  model: "claude-opus-5-5",
  max_turns: 40,
  max_usd: 2,
  hoop: "0.2.0",
  plugin: "c".repeat(40),
};
const entry = (s: ScenarioScore): BaselineEntry => ({ ...s, ...PROVENANCE });
const baseOf = (scenarios: Record<string, ScenarioScore>): Baseline => ({
  k: 3,
  scenarios: Object.fromEntries(Object.entries(scenarios).map(([n, s]) => [n, entry(s)])),
});

test("a fall in a core scenario's pass^k is a regression; other changes are drops, not compared or not run", () => {
  const base = baseOf({ a: scoreOf(3), b: scoreOf(3), c: scoreOf(3, 3, 1), d: scoreOf(3), e: scoreOf(6, 6), g: scoreOf(2, 2), h: scoreOf(3), i: scoreOf(3) });
  const findings = compare(
    { a: scoreOf(2), b: scoreOf(2), c: scoreOf(3, 3, 2), d: scoreOf(2, 2), e: scoreOf(4, 6), f: scoreOf(3), g: scoreOf(3) },
    base,
    new Set(["a", "c", "d", "e", "f", "g", "h"]),
  );
  assert.deepEqual(
    findings.map((f) => [f.scenario, f.kind, f.text]),
    [
      ["a", "regression", "pass^3 1.00 → 0.00"],
      // b isn't core: its pass^k may fall without failing the run, and one trial's worth isn't a drop.
      ["c", "not-compared", "its script changed (v1 → v2) since the baseline"],
      ["d", "not-compared", "this run had 2 of it, fewer than 3 trials, so no pass^3 to compare"],
      ["e", "regression", "pass^3 1.00 → 0.20"],
      ["e", "drop", "pass rate 100% → 67%"],
      ["f", "not-compared", "not in the baseline yet"],
      ["g", "not-compared", "the baseline has 2 of it, fewer than 3 trials, so no pass^3 to compare"],
      // h is core and in the baseline, but this run didn't run it; i isn't core.
      ["h", "not-run", "a core scenario in the baseline that this run didn't run"],
    ],
  );
  assert.deepEqual(compare({ a: scoreOf(3) }, baseOf({ a: scoreOf(3) }), new Set(["a"])), [], "the same score is no change");
  assert.deepEqual(compare({ a: scoreOf(0) }, undefined, new Set(["a"])), [], "no baseline, nothing to compare");
});

test("a baseline update gives each scenario it ran this run's provenance, keeps the others', and needs a reason and three trials", () => {
  const prev = baseOf({ a: scoreOf(3), b: scoreOf(3) });
  const next = updatedBaseline(
    { a: scoreOf(2) },
    prev,
    { model: "m", max_turns: 40, max_usd: 2, hoop: "0.3.0", plugin: "d" },
    "  a's check got stricter  ",
    "2026-11-08T00:00:00.000Z",
  );
  assert.deepEqual(next, {
    k: 3,
    scenarios: {
      a: {
        ...scoreOf(2),
        updated: "2026-11-08T00:00:00.000Z",
        reason: "a's check got stricter",
        model: "m",
        max_turns: 40,
        max_usd: 2,
        hoop: "0.3.0",
        plugin: "d",
      },
      b: entry(scoreOf(3)),
    },
  });
  assert.throws(() => updatedBaseline({}, prev, { model: "m", max_turns: 40, max_usd: 2, hoop: "h", plugin: "p" }, " "), /needs a reason/);
  // Regression: two trials stored a scenario with no pass^k, so it could never be compared again.
  assert.throws(
    () => updatedBaseline({ a: scoreOf(2, 2) }, prev, { model: "m", max_turns: 40, max_usd: 2, hoop: "h", plugin: "p" }, "why"),
    /needs at least 3 trials of each scenario; a ran 2/,
  );
});

test("the run's modes: --update-baseline needs --reason and three trials, and --release can't be narrowed", () => {
  assert.throws(() => parseOptions(["--update-baseline"]), /--update-baseline needs --reason/);
  assert.throws(() => parseOptions(["--update-baseline", "--reason", "  "]), /--update-baseline needs --reason/);
  assert.throws(() => parseOptions(["--reason", "why"]), /--reason goes with --update-baseline/);
  assert.throws(() => parseOptions(["--update-baseline", "--reason", "why", "--trials", "2"]), /needs at least 3 trials/);
  assert.equal(parseOptions(["--update-baseline", "--reason", "first baseline"]).reason, "first baseline");
  assert.equal(parseOptions([]).reason, undefined);
  for (const narrow of [
    ["--scenario", "never-approves"],
    ["--trials", "1"],
    ["--update-baseline", "--reason", "why"],
  ])
    assert.throws(
      () => parseOptions(["--release", ...narrow]),
      /--release runs every scenario 3 times against the committed baseline; drop --/,
      narrow.join(" "),
    );
  assert.equal(parseOptions(["--release"]).release, true);
  assert.equal(parseOptions(["--release"]).scenarios.length, SCENARIOS.length);
});

test("a run fails on a core scenario's pass^k drop until a baseline update says why, and each scenario keeps its own reason", () => {
  const dir = tempHome();
  const good = thrice("never-approves", "follows-work-order");

  // No baseline yet: nothing to fail on, and the report says how to record one.
  const first = end(good, {}, dir);
  assert.equal(first.code, 0);
  assert.match(first.text, /No baseline yet: record one with --update-baseline --reason "<why>" and commit evals\/baseline\.json\./);
  assert.equal(existsSync(join(dir, BASELINE)), false);

  const recordedOne = end(good, { reason: "first baseline" }, dir);
  assert.equal(recordedOne.code, 0);
  assert.match(recordedOne.text, /Updated evals\/baseline\.json for never-approves, follows-work-order: first baseline$/);
  const base = readBack(dir);
  const day = base.scenarios["never-approves"]!.updated.slice(0, 10);
  assert.deepEqual(
    [base.scenarios["never-approves"]!.reason, base.scenarios["never-approves"]!.plugin, base.scenarios["never-approves"]!.pass_k],
    ["first baseline", "b".repeat(40), 1],
  );

  // One failed trial of a core scenario: the run fails, and the report names it and the way out.
  const worse = [...run("never-approves.pass", "never-approves.fail", "never-approves.pass"), ...thrice("follows-work-order")];
  const failed = end(worse, {}, dir);
  assert.equal(failed.code, 1);
  const lines = failed.text.split("\n");
  assert.ok(lines.includes(`never-approves: 2/3 trials passed, pass^3 0.00 (baseline 100%, pass^3 1.00; ${day}: first baseline); 3 turns, $0.30`), failed.text);
  assert.ok(lines.includes("  no-self-approval: 2/3 (baseline 100%)"));
  assert.ok(lines.includes("  REGRESSION never-approves: pass^3 1.00 → 0.00"));
  assert.ok(lines.at(-1)!.startsWith("A core scenario's pass^3 fell: fix it, or update the baseline on purpose"));

  // Updating on purpose, with a reason, passes the run; the scenario it didn't run keeps its own provenance.
  const only = worse.filter((r) => r.scenario === "never-approves");
  assert.equal(end(only, { reason: "never-approves now also checks subagent prompts" }, dir).code, 0);
  const after = readBack(dir);
  assert.deepEqual(
    [after.scenarios["never-approves"]!.reason, after.scenarios["follows-work-order"]!.reason],
    ["never-approves now also checks subagent prompts", "first baseline"],
  );
  assert.deepEqual([after.scenarios["never-approves"]!.pass_k, after.scenarios["follows-work-order"]!.pass_k], [0, 1]);
  const next = end([...only, ...thrice("follows-work-order")], {}, dir);
  assert.equal(next.code, 0, "against the updated baseline it's no regression");
  assert.match(next.text, /follows-work-order: 3\/3 trials passed, pass\^3 1\.00 \(baseline 100%, pass\^3 1\.00; \d{4}-\d\d-\d\d: first baseline\)/);
  // A plain run that leaves out a core scenario of the baseline says so, without failing.
  const partial = end(only, {}, dir);
  assert.equal(partial.code, 0);
  assert.ok(partial.text.split("\n").includes("  not run follows-work-order: a core scenario in the baseline that this run didn't run"));
});

test("a baseline update with too few trials of a scenario is refused after the run, and the baseline stays as it was", () => {
  const dir = tempHome();
  end(thrice("never-approves"), { reason: "first baseline" }, dir);
  const before = readFileSync(join(dir, BASELINE), "utf8");
  const short = end(run("never-approves.pass", "never-approves.pass"), { reason: "why" }, dir);
  assert.equal(short.code, 1);
  assert.match(short.text, /Didn't update evals\/baseline\.json: a baseline update needs at least 3 trials of each scenario; never-approves ran 2$/);
  assert.equal(readFileSync(join(dir, BASELINE), "utf8"), before);
});

test("a baseline file that isn't one stops the run before any trial", () => {
  const dir = tempHome();
  mkdirSync(join(dir, "evals"), { recursive: true });
  for (const bad of ["[]\n", "{not json\n", '{"k":3,"scenarios":[]}\n']) {
    writeFileSync(join(dir, BASELINE), bad);
    assert.throws(() => preflight({}, dir), /isn't an eval baseline/, bad);
  }
});

/** A git checkout with no commits, for the release check's committed baseline. */
function checkout() {
  const dir = tempHome();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd: dir, env: withoutGit(process.env) });
  git("init", "-q");
  return { dir, git };
}

test("the release check needs a committed baseline before any trial runs", () => {
  const { dir, git } = checkout();
  assert.throws(() => preflight({ release: true }, dir), /--release compares with the committed evals\/baseline\.json, but there is none/);
  end(thrice("never-approves"), { reason: "first baseline" }, dir);
  assert.throws(() => preflight({ release: true }, dir), /but it isn't committed/);
  git("add", BASELINE);
  git("commit", "-qm", "baseline");
  assert.equal(preflight({ release: true }, dir)!.scenarios["never-approves"]!.pass_k, 1);
  writeFileSync(join(dir, BASELINE), readFileSync(join(dir, BASELINE), "utf8").replace('"first baseline"', '"edited"'));
  assert.throws(() => preflight({ release: true }, dir), /but it has changes that aren't committed/);
});

test("the release check fails a core scenario run under another model or budget than its baseline, or missing from it", () => {
  const { dir, git } = checkout();
  const core = SCENARIOS.filter((s) => s.core).map((s) => s.name);
  const all = thrice(...core);
  // The baseline leaves out one core scenario.
  end(
    all.filter((r) => r.scenario !== "follows-work-order"),
    { reason: "first baseline" },
    dir,
  );
  git("add", BASELINE);
  git("commit", "-qm", "baseline");
  assert.deepEqual(
    [
      readBack(dir).scenarios["never-approves"]!.max_turns,
      readBack(dir).scenarios["never-approves"]!.max_usd,
      readBack(dir).scenarios["never-approves"]!.model,
    ],
    [40, 2, "claude-opus-5-5"],
    "each entry records the model and budgets it ran under",
  );
  const release = (runInfo: RunInfo, results = all) => finish(results, runInfo, { release: true }, preflight({ release: true }, dir), dir);
  const blocks = (text: string) => text.slice(text.indexOf("Release check failed:")).split("\n").slice(1);
  const missing = "  follows-work-order: not compared, not in the baseline yet";

  // Both match: only the scenario missing from the baseline blocks.
  const same = release(info);
  assert.equal(same.code, 1);
  assert.deepEqual(blocks(same.text), [missing]);

  // Regression: an easier model or a bigger budget than the baseline's passed the release.
  const other = (diff: string) => (n: string) =>
    `  ${n}: ran under other conditions than its baseline (${diff}); re-record the baseline with --update-baseline`;
  const recorded = core.filter((n) => n !== "follows-work-order");
  // The trials report the model they ran on.
  const model = release(info, onModel(all, "claude-sonnet-5"));
  assert.equal(model.code, 1);
  assert.deepEqual(
    blocks(model.text),
    core.map((n) => (n === "follows-work-order" ? missing : other("model claude-opus-5-5 → claude-sonnet-5")(n))),
  );
  const budget = release({ ...info, max_turns: 80, max_usd: 5 });
  assert.equal(budget.code, 1);
  assert.deepEqual(
    blocks(budget.text).filter((l) => l !== missing),
    recorded.map(other("max_turns 40 → 80, max_usd 2 → 5")),
  );
});

test("the baseline records the model the trials report, not a --model alias, and a release on another id is blocked", () => {
  const { dir, git } = checkout();
  const core = SCENARIOS.filter((s) => s.core).map((s) => s.name);
  // Regression: `--model opus` recorded and compared the alias, whatever model it resolved to.
  const alias = { ...info, model: "opus" };
  end(onModel(thrice(...core), "claude-opus-5-5"), { reason: "first baseline" }, dir, alias);
  git("add", BASELINE);
  git("commit", "-qm", "baseline");
  assert.equal(readBack(dir).scenarios["never-approves"]!.model, "claude-opus-5-5");
  const release = (model: string) => finish(onModel(thrice(...core), model), alias, { release: true }, preflight({ release: true }, dir), dir);
  assert.equal(release("claude-opus-5-5").code, 0, "the same alias on the same model passes");
  const moved = release("claude-opus-5-6");
  assert.equal(moved.code, 1);
  assert.match(moved.text, /\n {2}never-approves: ran under other conditions than its baseline \(model claude-opus-5-5 → claude-opus-5-6\)/);
});

test("the release check says so when git can't tell whether the baseline is committed", () => {
  const dir = tempHome();
  end(thrice("never-approves"), { reason: "first baseline" }, dir);
  // Not a git checkout: git fails, which isn't an answer.
  assert.throws(
    () => preflight({ release: true }, dir),
    /--release couldn't check with git that evals\/baseline\.json is committed: fatal: not a git repository/,
  );
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.throws(() => preflight({ release: true }, dir), /--release couldn't check with git that evals\/baseline\.json is committed: spawnSync git ENOENT/);
  } finally {
    process.env.PATH = path;
  }
});

test("the release check fails unless every core scenario ran and held its pass^k against the baseline", () => {
  const { dir, git } = checkout();
  const core = SCENARIOS.filter((s) => s.core).map((s) => s.name);
  const all = thrice(...core);
  end(all, { reason: "first baseline" }, dir);
  git("add", BASELINE);
  git("commit", "-qm", "baseline");
  const release = (results: ReturnType<typeof run>, runInfo = info) => finish(results, runInfo, { release: true }, preflight({ release: true }, dir), dir);

  const ok = release(all);
  assert.equal(ok.code, 0);
  assert.equal(ok.text.split("\n").at(-1), "Release check passed: every core scenario held its pass^3 against evals/baseline.json.");

  // Regression: a run that compared nothing passed the release.
  const subset = release(all.filter((r) => r.scenario === "never-approves"));
  assert.equal(subset.code, 1);
  const blocks = subset.text.slice(subset.text.indexOf("Release check failed:")).split("\n");
  assert.deepEqual(blocks, ["Release check failed:", ...core.filter((n) => n !== "never-approves").map((n) => `  ${n}: not run`)]);

  const fewer = release([...all.filter((r) => r.scenario !== "never-approves"), ...run("never-approves.pass", "never-approves.pass")]);
  assert.equal(fewer.code, 1);
  assert.match(fewer.text, /\n {2}never-approves: not compared, this run had 2 of it, fewer than 3 trials, so no pass\^3 to compare$/);

  // The scenario's script bumped by one since the baseline, whatever version it is at now.
  const was = scripts["never-approves"]!;
  const bumped = release(all, { ...info, scenarios: { ...scripts, "never-approves": was + 1 } });
  assert.equal(bumped.code, 1);
  assert.ok(bumped.text.endsWith(`\n  never-approves: not compared, its script changed (v${was} → v${was + 1}) since the baseline`), bumped.text);

  const worse = release([...all.filter((r) => r.scenario !== "never-approves"), ...run("never-approves.pass", "never-approves.fail", "never-approves.pass")]);
  assert.equal(worse.code, 1);
  assert.match(worse.text, /\n {2}never-approves: pass\^3 fell, pass\^3 1\.00 → 0\.00$/);
});
