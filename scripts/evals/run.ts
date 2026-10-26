// The agent evals' runner: each trial runs a real `claude -p` session with hoop's plugin from this
// checkout, in a fresh repository with a fresh hoop folder and pages process, plays the person from
// the scenario's script, and scores the checks. It runs on the person's own Claude Code sign-in and
// costs money, so it never runs in CI; test/evals.test.ts tests the checks on recorded trials.
// Usage: npx tsx scripts/evals/run.ts [--scenario <name>]... [--trials 3] [--model <id>] [--max-turns 40] [--max-usd 2] [--max-trials 15]
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { release } from "../../src/version.js";
import { type Outcome, parseTranscript, score, type TrialRecord, trialOf } from "./checks.js";
import { Person, snapshot } from "./person.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
// How many times one trial resumes the session with hoop's message after a review came in once it had stopped.
const MAX_RESUMES = 4;

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
    maxTrials: Math.floor(num("max-trials", 15)),
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
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@localhost", ...args], { cwd, encoding: "utf8" }).stdout.trim();

/** A fresh repository, hoop folder and pages process, and an environment for Claude in them. */
async function sandbox() {
  const repo = mkdtempSync(join(tmpdir(), "hoop-eval-repo-")),
    home = mkdtempSync(join(tmpdir(), "hoop-eval-home-"));
  writeFileSync(join(repo, "README.md"), "# Orders\n\nA small web app that takes and ships orders.\n");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Start");
  const port = await freePort();
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Nothing of the session that started the run reaches the trial's session.
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("HOOP_")) delete env[k];
  Object.assign(env, {
    HOOP_HOME: home,
    HOOP_PORT: String(port),
    HOOP_NO_BROWSER: "1",
    HOOP_BIN: `${process.execPath} ${join(root, "node_modules/tsx/dist/cli.mjs")} ${join(root, "src/cli.ts")}`,
  });
  const pages = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/cli.ts"), "serve"], {
    env: { ...env, HOOP_PAGES: "background" },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (const end = Date.now() + 20_000; Date.now() < end; await sleep(200)) {
    const info = (await fetch(`${base}/api/info`).then(
      (r) => r.json(),
      () => undefined,
    )) as { hoop?: string } | undefined;
    if (info?.hoop === "pages") return { repo, home, env, base, pages };
  }
  pages.kill();
  throw new Error(`no hoop pages on port ${port}`);
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

async function trial(s: Scenario, n: number, o: Options, out: string) {
  const box = await sandbox();
  const person = new Person(box.base, box.home, s.steps);
  const transcript: unknown[] = [];
  const session = randomUUID();
  const deadline = Date.now() + s.minutes * 60_000;
  let message: string | undefined = s.prompt;
  try {
    for (let run = 0; message && run <= MAX_RESUMES && Date.now() < deadline; run++) {
      const spent = parseTranscript(transcript).cost;
      if (spent >= o.maxUsd) break;
      const args = [
        ...["-p", message, run === 0 ? "--session-id" : "--resume", session],
        ...["--output-format", "stream-json", "--verbose", "--max-turns", String(o.maxTurns), "--max-budget-usd", Math.max(0.01, o.maxUsd - spent).toFixed(2)],
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
        const { calls } = parseTranscript(transcript);
        const last = calls.at(-1);
        const ended = exited;
        const wakes = person.wakes.length;
        const acted = await person.tick(calls, ended || (last?.name === "hoop_wait" && last.result === undefined));
        // A review given after Claude stopped reaches it as hoop's message, in the same session.
        if (ended && person.wakes.length > wakes) message = person.wakes.at(-1);
        if (ended && !acted) break;
        if (Date.now() > deadline) c.child.kill();
        await sleep(1000);
      }
    }
  } finally {
    box.pages.kill();
  }
  const record: TrialRecord = {
    scenario: s.name,
    script: s.script,
    trial: n,
    model: o.model ?? (transcript as { type?: string; model?: string }[]).find((e) => e.type === "system" && e.model)?.model,
    hoop: release(root) ?? "unknown",
    plugin: git(root, "rev-parse", "HEAD"),
    transcript,
    reviews: snapshot(box.home),
    person: person.log,
  };
  const t = trialOf(record);
  const outcomes = score(t, s.checks);
  // Every trial keeps its record; a failing one also keeps its repository and hoop folder.
  writeFileSync(join(out, `${s.name}-${n}.json`), `${JSON.stringify(record, null, 1)}\n`);
  if (outcomes.some((x) => !x.pass)) process.stdout.write(`  kept ${box.repo} and ${box.home}\n`);
  return { outcomes, turns: t.turns, cost: t.cost };
}

/** Per-scenario and per-check pass rates, with the trials, turns and spend. */
export function report(results: { scenario: string; outcomes: Outcome[]; turns: number; cost: number }[]): string {
  const lines: string[] = [];
  for (const name of [...new Set(results.map((r) => r.scenario))]) {
    const rs = results.filter((r) => r.scenario === name);
    lines.push(`${name}: ${rs.filter((r) => r.outcomes.every((x) => x.pass)).length}/${rs.length} trials passed`);
    for (const check of rs[0]!.outcomes.map((x) => x.check)) {
      const os = rs.map((r) => r.outcomes.find((x) => x.check === check)!);
      lines.push(`  ${check}: ${os.filter((x) => x.pass).length}/${os.length}`);
      for (const f of os.filter((x) => !x.pass)) lines.push(`    ✗ ${f.reason}`, ...(f.around ?? []).map((a) => `      ${a}`));
    }
  }
  const sum = (k: "turns" | "cost") => results.reduce((a, r) => a + r[k], 0);
  lines.push(`${results.length} trials, ${sum("turns")} turns, $${sum("cost").toFixed(2)}`);
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const o = parseOptions(process.argv.slice(2));
  const out = join(root, "evals/runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(out, { recursive: true });
  const results = [];
  for (const s of o.scenarios)
    for (let n = 1; n <= o.trials; n++) {
      process.stdout.write(`• ${s.name} trial ${n}/${o.trials}\n`);
      results.push({ scenario: s.name, ...(await trial(s, n, o, out)) });
    }
  const text = report(results);
  writeFileSync(join(out, "report.txt"), `${text}\n`);
  process.stdout.write(`${text}\nRecords in ${out}\n`);
}
