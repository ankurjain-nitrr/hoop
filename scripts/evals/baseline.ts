// The agent evals' pass^k and baseline: each scenario's pass rate and pass^k from a run's trials,
// the baseline in evals/baseline.json they are compared with, and the comparison. A drop in pass^k on
// a core scenario is a regression: the run fails, and a release waits, until a baseline update says
// why (`--update-baseline --reason`).
import { existsSync, readFileSync } from "node:fs";
import type { Outcome } from "./checks.js";

/** k for pass^k: a scenario is reliable when it passes this many trials in a row, as often as a run of three. */
export const PASS_K = 3;

/** One trial's result, as the runner gives it. */
export type TrialOutcome = { scenario: string; outcomes: Outcome[]; timedOut: boolean };

/** A trial passes when it finished in time and every check passed. */
export const passed = (r: TrialOutcome) => !r.timedOut && r.outcomes.every((x) => x.pass);

/** How many ways to choose k of n. */
function choose(n: number, k: number): number {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c;
}

/**
 * The chance that k trials drawn from these n all pass, with c of them passing: C(c, k) / C(n, k),
 * the unbiased estimate of pass^k. Undefined with fewer than k trials. With n = k it is 1 when every
 * trial passed and 0 otherwise.
 */
export function passHatK(n: number, c: number, k = PASS_K): number | undefined {
  if (n < k || k < 1) return undefined;
  return c < k ? 0 : choose(c, k) / choose(n, k);
}

/** A scenario's score in one run: its trials, how many passed, its pass rate and pass^k, and each check's pass rate. */
export type ScenarioScore = { script: number; trials: number; passed: number; pass_rate: number; pass_k?: number; checks: Record<string, number> };

/** Each scenario's score from a run's trials, with each scenario's script version from `scripts`. */
export function scoreRun(results: TrialOutcome[], scripts: Record<string, number>): Record<string, ScenarioScore> {
  const out: Record<string, ScenarioScore> = {};
  for (const name of [...new Set(results.map((r) => r.scenario))]) {
    const rs = results.filter((r) => r.scenario === name);
    const ok = rs.filter(passed).length;
    const checks = Object.fromEntries(
      (rs[0]?.outcomes ?? []).map((o) => [o.check, rs.filter((r) => r.outcomes.find((x) => x.check === o.check)?.pass).length / rs.length]),
    );
    const k = passHatK(rs.length, ok);
    out[name] = { script: scripts[name] ?? 0, trials: rs.length, passed: ok, pass_rate: ok / rs.length, ...(k === undefined ? {} : { pass_k: k }), checks };
  }
  return out;
}

/** evals/baseline.json: the scores a run is compared with, and when, why and on what they were last updated. */
export type Baseline = {
  k: number;
  updated: string;
  reason: string;
  model: string;
  hoop: string;
  plugin: string;
  scenarios: Record<string, ScenarioScore>;
};

/** The baseline at `path`, or undefined when there is none yet. A file that isn't one is an error: the comparison can't go on without it. */
export function readBaseline(path: string): Baseline | undefined {
  if (!existsSync(path)) return undefined;
  const b = JSON.parse(readFileSync(path, "utf8")) as Baseline;
  if (typeof b?.k !== "number" || typeof b.scenarios !== "object" || !b.scenarios) throw new Error(`${path} isn't an eval baseline`);
  return b;
}

/** The baseline after a run: the scenarios it ran take their new scores, the others keep theirs. A reason is required. */
export function updatedBaseline(
  now: Record<string, ScenarioScore>,
  prev: Baseline | undefined,
  run: { model: string; hoop: string; plugin: string },
  reason: string,
  at = new Date().toISOString(),
): Baseline {
  if (!reason.trim()) throw new Error("a baseline update needs a reason");
  return { k: PASS_K, updated: at, reason: reason.trim(), ...run, scenarios: { ...(prev?.scenarios ?? {}), ...now } };
}

/**
 * What the run shows against the baseline, per scenario:
 * - `regression`: a core scenario's pass^k fell; it fails the run;
 * - `drop`: its pass rate fell by more than one trial's worth;
 * - `not-compared`: no baseline for it, its script changed since, or too few trials for pass^k.
 */
export type Finding = { scenario: string; kind: "regression" | "drop" | "not-compared"; text: string };

const fixed = (x: number | undefined) => (x === undefined ? "n/a" : x.toFixed(2));
// Two scores this close are the same: pass^k is a ratio of whole numbers.
const EPSILON = 1e-9;

function compareOne(name: string, now: ScenarioScore, was: ScenarioScore | undefined, core: boolean, k: number): Finding[] {
  const say = (kind: Finding["kind"], text: string): Finding[] => [{ scenario: name, kind, text }];
  if (!was) return say("not-compared", "not in the baseline yet");
  if (was.script !== now.script) return say("not-compared", `its script changed (v${was.script} → v${now.script}) since the baseline`);
  if (now.pass_k === undefined || was.pass_k === undefined) return say("not-compared", `fewer than ${k} trials, so no pass^${k} to compare`);
  const out: Finding[] = [];
  if (core && now.pass_k < was.pass_k - EPSILON) out.push(...say("regression", `pass^${k} ${fixed(was.pass_k)} → ${fixed(now.pass_k)}`));
  // More than one trial's worth of this run below the baseline's rate.
  if ((was.pass_rate - now.pass_rate) * now.trials > 1 + EPSILON)
    out.push(...say("drop", `pass rate ${Math.round(was.pass_rate * 100)}% → ${Math.round(now.pass_rate * 100)}%`));
  return out;
}

/** The run's scores against the baseline; `core` names the scenarios whose pass^k gates a release. */
export function compare(now: Record<string, ScenarioScore>, base: Baseline | undefined, core: Set<string>): Finding[] {
  if (!base) return [];
  return Object.entries(now).flatMap(([name, s]) => compareOne(name, s, base.scenarios[name], core.has(name), base.k));
}

/** The report's lines on the baseline: what it is, and each finding; a regression says how to go on. */
export function baselineLines(base: Baseline | undefined, findings: Finding[], path = "evals/baseline.json"): string[] {
  if (!base) return [`No baseline yet: record one with --update-baseline --reason "<why>" and commit ${path}.`];
  const lines = [`Against ${path} (updated ${base.updated.slice(0, 10)}: ${base.reason})`];
  const label = { regression: "REGRESSION", drop: "drop", "not-compared": "not compared" };
  for (const f of findings) lines.push(`  ${label[f.kind]} ${f.scenario}: ${f.text}`);
  if (!findings.length) lines.push("  no change");
  if (findings.some((f) => f.kind === "regression"))
    lines.push(`A core scenario's pass^${base.k} fell: fix it, or update the baseline on purpose with --update-baseline --reason "<why>".`);
  return lines;
}
