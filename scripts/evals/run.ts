// The agent evals' runner: each trial runs a real `claude -p` session with hoop's plugin from this
// checkout, in a fresh repository with a fresh hoop folder and pages process, plays the person from
// the scenario's script, and scores the checks. It runs on the person's own Claude Code sign-in and
// costs money, so it never runs in CI; test/evals.test.ts tests the checks on recorded trials. Each
// run writes run.json (the model, hoop's version, the plugin's version, hash and commit, and each
// scenario's script version), a record per trial, and report.txt, which starts with the same. The
// report compares each scenario with evals/baseline.json; a core scenario whose pass^k fell fails the
// run (exit 1), unless the run updates the baseline with a reason. `--release` runs every scenario
// three times and fails unless each core scenario was compared with the committed baseline and held.
// Usage: npm run eval -- [--scenario <name>]... [--trials 3] [--model <id>] [--max-turns 40] [--max-usd 2] [--max-trials 27]
//        [--update-baseline --reason "<why>"] | [--release] | --rescore evals/runs/<dir> [--assume-same-setup] [--update-baseline --reason "<why>"]
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { storeKey } from "../../src/sessions.js";
import { writeAtomic } from "../../src/util.js";
import { release } from "../../src/version.js";
import {
  type Baseline,
  type BaselineEntry,
  baselineLines,
  type Conditions,
  compare,
  type Finding,
  PASS_K,
  passed,
  passHatK,
  readBaseline,
  releaseBlocks,
  type ScenarioScore,
  scoreRun,
  updatedBaseline,
} from "./baseline.js";
import { LIMITS, type Outcome, parseTranscript, score, type TrialRecord, trialOf } from "./checks.js";
import { Person, snapshot, workSnapshot } from "./person.js";
import { SCENARIOS, type Scenario, setupHash } from "./scenarios.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
// How many times one trial resumes the session with hoop's message after a review came in once it had stopped.
export const MAX_RESUMES = 4;

/**
 * `reason` is set when the run updates the baseline: why its scores are the new ones to compare with.
 * `release` is set for the release check: the whole suite, at the default trials, against the committed baseline.
 */
export type Options = {
  scenarios: Scenario[];
  trials: number;
  model?: string;
  maxTurns: number;
  maxUsd: number;
  maxTrials: number;
  reason?: string;
  release?: true;
  /** A recorded run's folder to score again with the current checks, instead of running Claude. */
  rescore?: string;
  /** With `rescore`: score records that hold no setup hash as if they ran today's setup, and say so. */
  assumeSameSetup?: true;
};

/** The flags a rescore refuses, since a recorded run is scored as it ran: its scenarios, trials, model and limits are the record's. */
const RUN_FLAGS = ["scenario", "trials", "model", "release", "max-turns", "max-usd", "max-trials"] as const;

/** Refuses a rescore with a flag that shapes a live run, and --assume-same-setup without a rescore. */
function checkRescore(v: Partial<Record<(typeof RUN_FLAGS)[number] | "rescore" | "assume-same-setup", unknown>>) {
  const runs = RUN_FLAGS.filter((f) => v[f] !== undefined);
  if (v.rescore !== undefined && runs.length) throw new Error(`--rescore scores a recorded run as it ran; drop --${runs.join(", --")}`);
  if (v["assume-same-setup"] && v.rescore === undefined) throw new Error("--assume-same-setup goes with --rescore");
}

/** The baseline's file in a checkout. */
export const BASELINE = "evals/baseline.json";

/** Refuses a baseline update without a reason or with too few trials, a reason without one, and a release check that narrows the run. */
function checkModes(v: { scenario?: string[]; trials?: string; reason?: string; "update-baseline"?: boolean; release?: boolean }) {
  const reason = v.reason?.trim();
  if (v["update-baseline"] && !reason) throw new Error('--update-baseline needs --reason "<why the new scores are the ones to compare with>"');
  if (reason && !v["update-baseline"]) throw new Error("--reason goes with --update-baseline");
  if (v["update-baseline"] && v.trials !== undefined && Number(v.trials) < PASS_K)
    throw new Error(`--update-baseline needs at least ${PASS_K} trials of each scenario, for its pass^${PASS_K}`);
  const narrowed = (["scenario", "trials", "update-baseline"] as const).filter((f) => v[f] !== undefined);
  if (v.release && narrowed.length)
    throw new Error(`--release runs every scenario ${PASS_K} times against the committed baseline; drop --${narrowed.join(", --")}`);
  return reason;
}

/**
 * The run's options from its arguments; refuses a run of more trials than `--max-trials` allows, and
 * the mode combinations `checkModes` refuses.
 */
export function parseOptions(args: string[]): Options {
  const n = { type: "string" } as const;
  const { values: v } = parseArgs({
    args,
    options: {
      scenario: { ...n, multiple: true },
      trials: n,
      model: n,
      "max-turns": n,
      "max-usd": n,
      "max-trials": n,
      "update-baseline": { type: "boolean" },
      reason: n,
      release: { type: "boolean" },
      rescore: n,
      "assume-same-setup": { type: "boolean" },
    },
  });
  checkRescore(v);
  const reason = checkModes(v);
  const num = (flag: keyof typeof v, fallback: number) => {
    const x = v[flag] === undefined ? fallback : Number(v[flag]);
    if (!(x > 0)) throw new Error(`--${flag} takes a positive number`);
    return x;
  };
  const names = v.scenario ?? [];
  const unknown = names.filter((name) => !SCENARIOS.some((s) => s.name === name));
  if (unknown.length) throw new Error(`no scenario ${unknown.join(", ")}; the scenarios are ${SCENARIOS.map((s) => s.name).join(", ")}`);
  const scenarios = names.length ? SCENARIOS.filter((s) => names.includes(s.name)) : SCENARIOS;
  const o = {
    trials: Math.floor(num("trials", 3)),
    maxTurns: Math.floor(num("max-turns", 40)),
    maxUsd: num("max-usd", 2),
    // Every scenario three times, and no more.
    maxTrials: Math.floor(num("max-trials", 27)),
  };
  const planned = scenarios.length * o.trials;
  if (planned > o.maxTrials) throw new Error(`${planned} trials planned, more than --max-trials ${o.maxTrials}; narrow it with --scenario or --trials`);
  return {
    scenarios,
    ...o,
    ...(v.model ? { model: v.model } : {}),
    ...(reason ? { reason } : {}),
    ...(v.release ? { release: true as const } : {}),
    ...(v.rescore ? { rescore: v.rescore } : {}),
    ...(v["assume-same-setup"] ? { assumeSameSetup: true as const } : {}),
  };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The environment without git's own variables: a git hook sets GIT_DIR, which would point every git command at its repository. */
export const withoutGit = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => !e[0].startsWith("GIT_") && e[1] !== undefined));
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@localhost", ...args], { cwd, env: withoutGit(process.env), encoding: "utf8" }).stdout.trim();

/** A fresh repository, hoop folder and pages process, and an environment for Claude in them. */
async function sandbox() {
  const repo = mkdtempSync(join(tmpdir(), "hoop-eval-repo-")),
    home = mkdtempSync(join(tmpdir(), "hoop-eval-home-"));
  writeFileSync(join(repo, "README.md"), "# Orders\n\nA small web app that takes and ships orders.\n");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Start");
  const env = withoutGit(process.env);
  // Nothing of the session that started the run reaches the trial's session.
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("HOOP_")) delete env[k];
  Object.assign(env, {
    HOOP_HOME: home,
    HOOP_NO_BROWSER: "1",
    // The person's claude.ai connectors (mail, drive and the rest) stay out of the trial; hoop's plugin stays.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    // Claude Code's todo tools, as `hoop init` turns them on, so the Work scenarios have todos to follow.
    CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
    HOOP_BIN: `${process.execPath} ${join(root, "node_modules/tsx/dist/cli.mjs")} ${join(root, "src/cli.ts")}`,
  });
  const { port, base, pages } = await startPages(home, env);
  env.HOOP_PORT = String(port);
  return { repo, home, env, base, pages };
}

/** Which pages process answers at `base`: the one for the store `store`, another store's, or none within 20 seconds. */
async function pagesAt(base: string, store: string): Promise<"ours" | "another" | undefined> {
  for (const end = Date.now() + 20_000; Date.now() < end; await sleep(200)) {
    const info = (await fetch(`${base}/api/info`).then(
      (r) => r.json(),
      () => undefined,
    )) as { hoop?: string; store?: string } | undefined;
    if (info?.hoop === "pages") return info.store === store ? "ours" : "another";
  }
  return undefined;
}

/**
 * A pages process for the hoop folder `home`, once it answers there for that folder. Another
 * process, such as another trial's or test's pages process, can take a free port before this one
 * binds it: that port is given up for a fresh one, up to three tries. `firstPort` is tried first.
 */
export async function startPages(home: string, env: Record<string, string>, firstPort?: number): Promise<{ port: number; base: string; pages: ChildProcess }> {
  for (let tries = 1; tries <= 3; tries++) {
    const port = tries === 1 && firstPort ? firstPort : await freePort();
    const pages = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/cli.ts"), "serve"], {
      env: { ...env, HOOP_HOME: home, HOOP_PORT: String(port), HOOP_PAGES: "background" },
      stdio: "ignore",
    });
    const base = `http://127.0.0.1:${port}`;
    const at = await pagesAt(base, storeKey(home));
    if (at === "ours") return { port, base, pages };
    pages.kill();
    if (!at) throw new Error(`no hoop pages on port ${port}`);
  }
  throw new Error(`another hoop store took each free port tried for ${home}`);
}

/** One `claude -p` run, its stream-json events appended to `transcript` as they come. */
function claude(args: string[], cwd: string, env: Record<string, string>, transcript: unknown[]): { child: ChildProcess; done: Promise<void> } {
  const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
  createInterface({ input: child.stdout! }).on("line", (line) => {
    try {
      transcript.push(JSON.parse(line));
    } catch {
      // Not an event: Claude Code printed something else.
    }
  });
  return { child, done: new Promise((r) => child.on("close", () => r())) };
}

/** Claude Code's folder of state for a project: its transcripts, and the hoop data of its sessions. */
const claudeProject = (repo: string) => join(homedir(), ".claude/projects", realpathSync(repo).replace(/[^A-Za-z0-9]/g, "-"));
/** The plugin's commit, marked dirty when the checkout has changes the commit doesn't hold. */
export const pluginId = (dir: string) => git(dir, "rev-parse", "HEAD") + (git(dir, "status", "--porcelain") ? "-dirty" : "");
/** The plugin's folder in a checkout. */
const PLUGIN = "plugins/hoop";

/**
 * The SHA-256 of `files`, paths under `dir` given in any order: each by its path and its bytes, in
 * sorted order, so the same files always give the same hash. A symlink counts by the path it holds,
 * as git stores it, not by what it points at; a file that is gone counts as gone.
 */
export function hashFiles(dir: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const f of [...files].sort()) {
    const path = join(dir, f);
    let body: Buffer | string;
    try {
      body = lstatSync(path).isSymbolicLink() ? `symlink ${readlinkSync(path)}` : readFileSync(path);
    } catch {
      body = "gone";
    }
    hash.update(`${f}\0`).update(body).update("\0");
  }
  return hash.digest("hex");
}

/**
 * The SHA-256 of the plugin's files that git tracks in the checkout `repo`, with their bytes as they
 * are now (`hashFiles`). An untracked file, such as Finder's .DS_Store, doesn't count.
 */
export function pluginHash(repo: string, folder = PLUGIN): string {
  const dir = join(repo, folder);
  const tracked = git(repo, "ls-files", "-z", "--", folder).split("\0").filter(Boolean);
  return hashFiles(
    dir,
    tracked.map((f) => relative(dir, join(repo, f))),
  );
}

/** A plugin folder's version, from its plugin.json. */
const pluginVersion = (dir: string): string | undefined => {
  try {
    return JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8")).version;
  } catch {
    return undefined;
  }
};

/** Which plugin a run runs, taken once when it starts: its version, the hash of its files and its commit. */
export type PluginInfo = { version?: string; hash: string; commit: string };
const pluginNow = (dir = root): PluginInfo => {
  const version = pluginVersion(join(dir, PLUGIN));
  return { ...(version ? { version } : {}), hash: pluginHash(dir), commit: pluginId(dir) };
};

/** What a run ran: the model, hoop's version, the plugin's version, hash and commit, and each scenario's script version. */
export type RunInfo = {
  started: string;
  model: string;
  hoop: string;
  plugin: PluginInfo;
  scenarios: Record<string, number>;
  /** Each scenario's setup hash (`setupHash`), so a rescore knows the trials ran this setup. Missing in runs before it was kept. */
  setups?: Record<string, string>;
  trials: number;
  max_turns: number;
  max_usd: number;
};

/** The run's record of what it ran, from its options and the checkout at `dir`. */
export function runInfo(o: Options, dir = root): RunInfo {
  return {
    started: new Date().toISOString(),
    // Without --model, each trial records the model Claude Code chose.
    model: o.model ?? "Claude Code's default",
    hoop: release(dir) ?? "unknown",
    plugin: pluginNow(dir),
    scenarios: Object.fromEntries(o.scenarios.map((s) => [s.name, s.script])),
    setups: Object.fromEntries(o.scenarios.map((s) => [s.name, setupHash(s)])),
    trials: o.trials,
    max_turns: o.maxTurns,
    max_usd: o.maxUsd,
  };
}

export type TrialResult = { outcomes: Outcome[]; turns: number; cost: number; timedOut: boolean; record: TrialRecord };

/**
 * One trial: Claude's first run, then a resume each time the person reviews after Claude stopped, at
 * most MAX_RESUMES, within the trial's turns, spend and time. A passing trial's repository, hoop
 * folder and Claude Code state are removed; a failing one's are kept and printed.
 */
export async function trial(s: Scenario, n: number, o: Options, out: string, tickMs = 1000, plugin = pluginNow()): Promise<TrialResult> {
  const box = await sandbox();
  const session = randomUUID();
  const person = new Person(box.base, box.home, s.steps, session);
  const transcript: unknown[] = [];
  const deadline = Date.now() + s.minutes * 60_000;
  let message: string | undefined = s.prompt;
  let timedOut = false;
  // What the repository held before the person approved: a write the tool calls don't show, such as Bash's.
  let dirty: string[] | undefined;
  try {
    for (let run = 0; message && run <= MAX_RESUMES && Date.now() < deadline; run++) {
      const { cost, turns } = parseTranscript(transcript);
      // A run that stopped for a limit isn't resumed: the trial has spent what it may.
      const stop = (transcript as { type?: string; subtype?: string }[]).some((e) => e.type === "result" && LIMITS.includes(e.subtype ?? ""));
      if (stop || cost >= o.maxUsd || turns >= o.maxTurns) break;
      const args = [
        ...["-p", message, run === 0 ? "--session-id" : "--resume", session],
        ...["--output-format", "stream-json", "--verbose", "--max-turns", String(o.maxTurns - turns)],
        ...["--max-budget-usd", Math.max(0.01, o.maxUsd - cost).toFixed(2)],
        // Only this checkout's plugin: the person's own plugins and settings stay out of the trial.
        ...["--plugin-dir", join(root, "plugins/hoop"), "--setting-sources", "project"],
        ...["--permission-mode", "acceptEdits", "--permission-prompts", "none", "--allowedTools", "mcp__plugin_hoop_hoop"],
        ...(o.model ? ["--model", o.model] : []),
      ];
      const c = claude(args, box.repo, box.env, transcript);
      let exited = false;
      c.done.then(() => (exited = true));
      message = undefined;
      for (;;) {
        const { calls, said } = parseTranscript(transcript);
        const ended = exited;
        if (!dirty && !calls.some((x) => x.result?.approved === true)) {
          const status = git(box.repo, "status", "--porcelain");
          if (status) dirty = status.split("\n");
        }
        const wakes = person.wakes.length;
        const acted = await person.tick(calls, ended, said.length);
        // A review given after Claude stopped reaches it as hoop's message, in the same session.
        if (ended && person.wakes.length > wakes) message = person.wakes.at(-1);
        if (ended && !acted) break;
        if (Date.now() > deadline && !ended) {
          timedOut = true;
          message = undefined;
          c.child.kill();
        }
        await sleep(tickMs);
      }
    }
  } finally {
    box.pages.kill();
  }
  const work = workSnapshot(box.home, session);
  const record: TrialRecord = {
    scenario: s.name,
    script: s.script,
    setup: setupHash(s),
    trial: n,
    // The model the session reports, which --model's alias resolved to; the flag only when it reports none.
    model: (transcript as { type?: string; model?: string }[]).find((e) => e.type === "system" && e.model)?.model ?? o.model,
    hoop: release(root) ?? "unknown",
    // The plugin as it was when the run started, as run.json has it.
    plugin: plugin.commit,
    ...(plugin.version ? { plugin_version: plugin.version } : {}),
    plugin_hash: plugin.hash,
    transcript,
    reviews: snapshot(box.home),
    ...(work ? { work } : {}),
    person: person.log,
    ...(dirty ? { dirty_before_approval: dirty } : {}),
    ...(timedOut ? { timed_out: true } : {}),
  };
  const t = trialOf(record);
  const outcomes = score(t, s.checks);
  writeAtomic(join(out, `${s.name}-${n}.json`), `${JSON.stringify(record, null, 1)}\n`);
  if (outcomes.some((x) => !x.pass) || timedOut) {
    process.stdout.write(`  kept ${box.repo}, ${box.home} and ${claudeProject(box.repo)}\n`);
  } else {
    // Claude Code keeps the trial's transcripts and hoop's review data under its own folder.
    spawnSync(process.env.CLAUDE_BIN ?? "claude", ["purge", "--yes", box.repo], { env: box.env, stdio: "ignore" });
    for (const dir of [box.repo, box.home]) rmSync(dir, { recursive: true, force: true });
  }
  return { outcomes, turns: t.turns, cost: t.cost, timedOut, record };
}

type Result = { scenario: string; outcomes: Outcome[]; turns: number; cost: number; timedOut: boolean; record?: TrialRecord };

/** The model the run ran on: the one --model asked for, else the ones its trials ran on. */
function modelOf(info: RunInfo, results: Result[]): string {
  const seen = modelsRun(results);
  return info.model === "Claude Code's default" && seen.length ? `${seen.join(", ")} (Claude Code's default)` : info.model;
}

/** The models the trials report they ran on, sorted. */
const modelsRun = (results: Result[]) => [...new Set(results.flatMap((r) => (r.record?.model ? [r.record.model] : [])))].sort();

/**
 * The model a baseline records and a release compares: the ones the trials ran on, as their
 * transcripts report them, whatever --model alias asked for them; the flag only when none reports one.
 */
const ranOn = (info: RunInfo, results: Result[]) => modelsRun(results).join(", ") || info.model;

/** The report's head: what the run ran, with the models its trials ran on when no --model chose one. */
function headOf(info: RunInfo, results: Result[]): string[] {
  const model = modelOf(info, results);
  const p = info.plugin;
  return [
    `Model ${model} · hoop ${info.hoop} · plugin ${p.version ?? "unknown"} (files ${p.hash.slice(0, 12)}, commit ${p.commit.slice(0, 12)}${p.commit.endsWith("-dirty") ? "-dirty" : ""})`,
    `Scenarios: ${Object.entries(info.scenarios)
      .map(([name, script]) => `${name} v${script}`)
      .join(", ")}`,
  ];
}

/** At least, when a trial was killed at its deadline before it reported its turns and spend. */
const spent = (rs: Result[]) => {
  const atLeast = rs.some((r) => r.timedOut) ? "at least " : "";
  return `${atLeast}${rs.reduce((a, r) => a + r.turns, 0)} turns, ${atLeast}$${rs.reduce((a, r) => a + r.cost, 0).toFixed(2)}`;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
const kText = (x: number | undefined) => (x === undefined ? "n/a" : x.toFixed(2));

/** One scenario's lines: its trials, pass rate and pass^k, then each check's, each beside the baseline's (`was`) with its date and reason. */
function scenarioLines(name: string, rs: Result[], was: BaselineEntry | undefined): string[] {
  const late = rs.filter((r) => r.timedOut).length;
  const ok = rs.filter(passed).length;
  const then = was ? ` (baseline ${pct(was.pass_rate)}, pass^${PASS_K} ${kText(was.pass_k)}; ${String(was.updated).slice(0, 10)}: ${was.reason})` : "";
  const lines = [
    `${name}: ${ok}/${rs.length} trials passed${late ? `, ${late} timed out` : ""}, pass^${PASS_K} ${kText(passHatK(rs.length, ok))}${then}; ${spent(rs)}`,
  ];
  for (const check of rs[0]!.outcomes.map((x) => x.check)) {
    const os = rs.map((r) => r.outcomes.find((x) => x.check === check)!);
    const before = was?.checks[check];
    lines.push(`  ${check}: ${os.filter((x) => x.pass).length}/${os.length}${before === undefined ? "" : ` (baseline ${pct(before)})`}`);
    for (const f of os.filter((x) => !x.pass)) lines.push(`    ✗ ${f.reason}`, ...(f.around ?? []).map((a) => `      ${a}`));
  }
  return lines;
}

/**
 * What the run ran (with `info`), then per-scenario pass rates and pass^k and per-check pass rates,
 * with the trials, turns and spend; with `against`, each next to the baseline's, and what changed.
 */
export function report(results: Result[], info?: RunInfo, against?: { base: Baseline | undefined; findings: Finding[] }): string {
  const lines: string[] = info ? headOf(info, results) : [];
  for (const name of [...new Set(results.map((r) => r.scenario))])
    lines.push(
      ...scenarioLines(
        name,
        results.filter((r) => r.scenario === name),
        against?.base?.scenarios[name],
      ),
    );
  // A run killed at its deadline never reported its turns and spend, so the totals are at least these.
  lines.push(`${results.length} trials, ${spent(results)}`);
  if (against) lines.push(...baselineLines(against.base, against.findings, BASELINE));
  return lines.join("\n");
}

/** The scenarios whose pass^k gates a release. */
const CORE = new Set(SCENARIOS.filter((s) => s.core).map((s) => s.name));

/** git's output in `dir`; throws, saying so, when git can't run there or fails, rather than reading a failure as an empty answer. */
function gitOrThrow(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, env: withoutGit(process.env), encoding: "utf8" });
  if (r.error || r.status !== 0)
    throw new Error(`--release couldn't check with git that ${BASELINE} is committed: ${r.error?.message ?? (r.stderr.trim() || `git exited ${r.status}`)}`);
  return r.stdout.trim();
}

/** Why the baseline in the checkout `dir` isn't committed as it is, or undefined when it is. */
function uncommitted(dir: string): string | undefined {
  if (!gitOrThrow(dir, "ls-files", "--", BASELINE)) return "it isn't committed";
  return gitOrThrow(dir, "status", "--porcelain", "--", BASELINE) ? "it has changes that aren't committed" : undefined;
}

/**
 * Before any trial runs, so a run that can't end well spends nothing: the baseline in the checkout
 * `dir`, which must parse, and for `--release` must be committed as it is.
 */
export function preflight(o: Pick<Options, "release">, dir = root): Baseline | undefined {
  const base = readBaseline(join(dir, BASELINE));
  if (!o.release) return base;
  const why = base ? uncommitted(dir) : "there is none";
  if (why) throw new Error(`--release compares with the committed ${BASELINE}, but ${why}`);
  return base;
}

/** The release check's lines and verdict: every core scenario ran and held its pass^k against the baseline, or what didn't. */
function releaseCheck(
  scores: Record<string, ScenarioScore>,
  base: Baseline | undefined,
  findings: Finding[],
  run: Conditions,
): { lines: string[]; ok: boolean } {
  const blocks = releaseBlocks(scores, base, findings, CORE, run);
  if (!blocks.length) return { lines: [`Release check passed: every core scenario held its pass^${PASS_K} against ${BASELINE}.`], ok: true };
  return { lines: ["Release check failed:", ...blocks.map((b) => `  ${b}`)], ok: false };
}

/**
 * The end of a run: its report against `base` (the baseline `preflight` read from the checkout
 * `dir`), and the exit code, 1 when a core scenario's pass^k fell. With a reason (`--update-baseline
 * --reason`), the run's scores become the baseline for the scenarios it ran, each with the reason,
 * and the run doesn't fail. With `release`, it fails unless every core scenario ran and held.
 */
export function finish(
  results: Result[],
  info: RunInfo,
  o: Pick<Options, "reason" | "release">,
  base: Baseline | undefined,
  dir = root,
): { text: string; code: number } {
  const scores = scoreRun(results, info.scenarios);
  const findings = compare(scores, base, CORE);
  const text = report(results, info, { base, findings });
  const conditions: Conditions = { model: ranOn(info, results), max_turns: info.max_turns, max_usd: info.max_usd };
  if (o.reason) {
    try {
      const next = updatedBaseline(scores, base, { ...conditions, hoop: info.hoop, plugin: info.plugin.commit }, o.reason);
      mkdirSync(join(dir, "evals"), { recursive: true });
      writeAtomic(join(dir, BASELINE), `${JSON.stringify(next, null, 1)}\n`);
      return { text: `${text}\nUpdated ${BASELINE} for ${Object.keys(scores).join(", ")}: ${o.reason}`, code: 0 };
    } catch (err) {
      return { text: `${text}\nDidn't update ${BASELINE}: ${(err as Error).message}`, code: 1 };
    }
  }
  const regressed = findings.some((f) => f.kind === "regression");
  if (!o.release) return { text, code: regressed ? 1 : 0 };
  const check = releaseCheck(scores, base, findings, conditions);
  return { text: [text, ...check.lines].join("\n"), code: check.ok && !regressed ? 0 : 1 };
}

/** A recorded trial's setup hash: its own, else the one its run recorded for its scenario, else none (a record from before hoop kept it). */
const setupOf = (record: TrialRecord, ran: RunInfo) => record.setup ?? ran.setups?.[record.scenario];

/** A scenario's trial records in a run's folder, in trial order. */
function recordsOf(dir: string, scenario: string): TrialRecord[] {
  return readdirSync(dir)
    .filter((f) => new RegExp(`^${scenario}-\\d+\\.json$`).test(f))
    .sort((a, b) => trialNo(a) - trialNo(b))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as TrialRecord);
}
const trialNo = (file: string) => Number(/-(\d+)\.json$/.exec(file)?.[1]);

/**
 * A recorded run scored again with the current checks, and no Claude: its run.json and each trial
 * record in `dir`, read only. The run keeps its own model, limits, hoop release and plugin, and each
 * trial its recorded model, so a baseline from it carries that provenance; the scenarios' script
 * versions are the current ones, since the checks are.
 *
 * Only a trial that ran today's setup (`setupHash`: its prompt and scripted steps) can be scored by
 * today's checks. A scenario whose recorded setup differs is left out, and `notes` names it. A record
 * from before setups were kept holds none: the rescore refuses it, unless `assumeSameSetup` says the
 * scenario's prompt and steps haven't changed since the run, and `notes` says that was assumed. A
 * record of a scenario hoop no longer has is left out.
 */
export function rescore(dir: string, assumeSameSetup = false): { info: RunInfo; results: Result[]; notes: string[] } {
  const ran = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunInfo;
  const results: Result[] = [];
  const [changed, unknown] = [[] as string[], [] as string[]];
  for (const s of SCENARIOS) {
    const records = recordsOf(dir, s.name);
    const setups = records.map((r) => setupOf(r, ran));
    if (setups.some((h) => h !== undefined && h !== setupHash(s))) changed.push(s.name);
    else {
      if (setups.some((h) => h === undefined)) unknown.push(s.name);
      for (const record of records) {
        const t = trialOf(record);
        results.push({ scenario: s.name, outcomes: score(t, s.checks), turns: t.turns, cost: t.cost, timedOut: Boolean(record.timed_out), record });
      }
    }
  }
  if (unknown.length && !assumeSameSetup)
    throw new Error(
      `the records of ${unknown.join(", ")} hold no setup hash, so --rescore can't tell they ran today's prompts and steps; ` +
        "if those haven't changed since the run, pass --assume-same-setup",
    );
  const notes = [
    ...(changed.length ? [`Left out ${changed.join(", ")}: the prompt or steps changed since the run, so today's checks can't score its trials.`] : []),
    ...(unknown.length ? [`Assumed ${unknown.join(", ")} ran today's prompts and steps (--assume-same-setup): their records hold no setup hash.`] : []),
  ];
  const scenarios = Object.fromEntries(SCENARIOS.filter((s) => results.some((r) => r.scenario === s.name)).map((s) => [s.name, s.script]));
  return { info: { ...ran, scenarios }, results, notes };
}

/**
 * `npm run eval` itself: parses the arguments once, then scores a recorded run again (`--rescore`,
 * which runs no Claude) or runs the trials, in the checkout `dir`. Returns the exit code.
 */
export async function main(args: string[], dir = root, print = (s: string) => void process.stdout.write(s)): Promise<number> {
  const o = parseOptions(args);
  const base = preflight(o, dir);
  if (o.rescore) {
    const { info, results, notes } = rescore(o.rescore, Boolean(o.assumeSameSetup));
    const { text, code } = finish(results, info, o, base, dir);
    print(`Scored again with the current checks, from ${o.rescore}; no Claude ran.\n${notes.map((n) => `${n}\n`).join("")}${text}\n`);
    return code;
  }
  const out = join(dir, "evals/runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(out, { recursive: true });
  const info = runInfo(o, dir);
  writeAtomic(join(out, "run.json"), `${JSON.stringify(info, null, 1)}\n`);
  print(`${headOf(info, []).join("\n")}\n`);
  const results = [];
  for (const s of o.scenarios)
    for (let n = 1; n <= o.trials; n++) {
      print(`• ${s.name} trial ${n}/${o.trials}\n`);
      results.push({ scenario: s.name, ...(await trial(s, n, o, out, 1000, info.plugin)) });
    }
  const { text, code } = finish(results, info, o, base, dir);
  writeAtomic(join(out, "report.txt"), `${text}\n`);
  print(`${text}\nRecords in ${out}\n`);
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
