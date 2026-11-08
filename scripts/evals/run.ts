// The agent evals' runner: each trial runs a real `claude -p` session with hoop's plugin from this
// checkout, in a fresh repository with a fresh hoop folder and pages process, plays the person from
// the scenario's script, and scores the checks. It runs on the person's own Claude Code sign-in and
// costs money, so it never runs in CI; test/evals.test.ts tests the checks on recorded trials. Each
// run writes run.json (the model, hoop's version, the plugin's version, hash and commit, and each
// scenario's script version), a record per trial, and report.txt, which starts with the same.
// Usage: npm run eval -- [--scenario <name>]... [--trials 3] [--model <id>] [--max-turns 40] [--max-usd 2] [--max-trials 27]
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { storeKey } from "../../src/sessions.js";
import { writeAtomic } from "../../src/util.js";
import { release } from "../../src/version.js";
import { type Outcome, parseTranscript, score, type TrialRecord, trialOf } from "./checks.js";
import { Person, snapshot, workSnapshot } from "./person.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
// How many times one trial resumes the session with hoop's message after a review came in once it had stopped.
export const MAX_RESUMES = 4;

export type Options = { scenarios: Scenario[]; trials: number; model?: string; maxTurns: number; maxUsd: number; maxTrials: number };

/** The run's options from its arguments; refuses a run of more trials than `--max-trials` allows. */
export function parseOptions(args: string[]): Options {
  const n = { type: "string" } as const;
  const { values: v } = parseArgs({
    args,
    options: { scenario: { ...n, multiple: true }, trials: n, model: n, "max-turns": n, "max-usd": n, "max-trials": n },
  });
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
  return { scenarios, ...o, ...(v.model ? { model: v.model } : {}) };
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
    trials: o.trials,
    max_turns: o.maxTurns,
    max_usd: o.maxUsd,
  };
}

// A run that stopped for a limit isn't resumed: the trial has spent what it may.
const LIMITS = ["error_max_turns", "error_max_budget_usd"];

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
    trial: n,
    model: o.model ?? (transcript as { type?: string; model?: string }[]).find((e) => e.type === "system" && e.model)?.model,
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

/** The report's head: what the run ran, with the models its trials ran on when no --model chose one. */
function headOf(info: RunInfo, results: Result[]): string[] {
  const seen = [...new Set(results.flatMap((r) => (r.record?.model ? [r.record.model] : [])))];
  const model = info.model === "Claude Code's default" && seen.length ? `${seen.join(", ")} (Claude Code's default)` : info.model;
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

/** What the run ran (with `info`), then per-scenario and per-check pass rates, with the trials, turns and spend. */
export function report(results: Result[], info?: RunInfo): string {
  const lines: string[] = info ? headOf(info, results) : [];
  for (const name of [...new Set(results.map((r) => r.scenario))]) {
    const rs = results.filter((r) => r.scenario === name);
    const late = rs.filter((r) => r.timedOut).length;
    lines.push(
      `${name}: ${rs.filter((r) => !r.timedOut && r.outcomes.every((x) => x.pass)).length}/${rs.length} trials passed${late ? `, ${late} timed out` : ""}; ${spent(rs)}`,
    );
    for (const check of rs[0]!.outcomes.map((x) => x.check)) {
      const os = rs.map((r) => r.outcomes.find((x) => x.check === check)!);
      lines.push(`  ${check}: ${os.filter((x) => x.pass).length}/${os.length}`);
      for (const f of os.filter((x) => !x.pass)) lines.push(`    ✗ ${f.reason}`, ...(f.around ?? []).map((a) => `      ${a}`));
    }
  }
  // A run killed at its deadline never reported its turns and spend, so the totals are at least these.
  lines.push(`${results.length} trials, ${spent(results)}`);
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const o = parseOptions(process.argv.slice(2));
  const out = join(root, "evals/runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(out, { recursive: true });
  const info = runInfo(o);
  writeAtomic(join(out, "run.json"), `${JSON.stringify(info, null, 1)}\n`);
  process.stdout.write(`${headOf(info, []).join("\n")}\n`);
  const results = [];
  for (const s of o.scenarios)
    for (let n = 1; n <= o.trials; n++) {
      process.stdout.write(`• ${s.name} trial ${n}/${o.trials}\n`);
      results.push({ scenario: s.name, ...(await trial(s, n, o, out, 1000, info.plugin)) });
    }
  const text = report(results, info);
  writeAtomic(join(out, "report.txt"), `${text}\n`);
  process.stdout.write(`${text}\nRecords in ${out}\n`);
}
