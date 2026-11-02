import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { addChanges } from "../src/steer.js";
import { Store } from "../src/store.js";
import { editWork, moveInQueue, workHook } from "../src/work.js";
import { example, freePort, hoopArgs, pagesFor, TEST_SESSION, tempHome } from "./helpers.js";

// Replays the recorded hook inputs in test/fixtures/hook-inputs/ through the plugin's hooks, as
// hooks.json runs them, against hoop folders in every state, and checks the rules every hook keeps
// (docs/DESIGN.md, "Rules every hook keeps"). Each gate's own tests cover what it blocks and that it
// blocks once per cause (stop-gate, done-gate, steer and plan tests); this checks the rules hold for
// every input Claude Code sends.

const plugin = new URL("../plugins/hoop/", import.meta.url).pathname;
const inputsDir = new URL("./fixtures/hook-inputs/", import.meta.url).pathname;
const HOOP = [process.execPath, ...hoopArgs].join(" ");

type Hook = { event: string; matcher?: string; command: string; script: string; async: boolean; type: string };
type Input = { name: string; input: Record<string, unknown> };
type Run = { code: number | null; stdout: string; stderr: string; ms: number };

/** Every command hook in hooks.json, with its event and matcher. */
function hooksOf(root: string): Hook[] {
  const config = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8")).hooks as Record<
    string,
    { matcher?: string; hooks: { type: string; command: string; async?: boolean }[] }[]
  >;
  return Object.entries(config).flatMap(([event, groups]) =>
    groups.flatMap((g) =>
      g.hooks.map((h) => ({
        event,
        matcher: g.matcher,
        command: h.command,
        script: /scripts\/([\w-]+)\.sh/.exec(h.command)?.[1] ?? h.command,
        async: h.async === true,
        type: h.type,
      })),
    ),
  );
}
const HOOKS = hooksOf(plugin);

/** The recorded inputs, by "<file>/<name>". */
const INPUTS: Input[] = readdirSync(inputsDir)
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) =>
    Object.entries(JSON.parse(readFileSync(join(inputsDir, f), "utf8")) as Record<string, unknown>)
      .filter(([k]) => k !== "_note")
      .map(([k, v]) => ({ name: `${f.slice(0, -5)}/${k}`, input: v as Record<string, unknown> })),
  );

/** What a hook's matcher is matched against, for each event that has one. */
const MATCHED: Record<string, string> = {
  PreToolUse: "tool_name",
  PostToolUse: "tool_name",
  PermissionRequest: "tool_name",
  Notification: "notification_type",
  SessionStart: "source",
  PreCompact: "trigger",
};

/** Whether Claude Code runs `hook` for `input`. */
function runsFor(hook: Hook, input: Record<string, unknown>): boolean {
  if (input.hook_event_name !== hook.event) return false;
  if (!hook.matcher || hook.matcher === "*") return true;
  const field = MATCHED[hook.event];
  return field !== undefined && new RegExp(`^(?:${hook.matcher})$`).test(String(input[field] ?? ""));
}

/** Runs a hook's command as Claude Code does: through the shell, with CLAUDE_PLUGIN_ROOT set. */
function run(command: string, stdin: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn("/bin/sh", ["-c", command], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - start }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

/** Runs `jobs` four at a time, in order of their results. */
async function pool<T>(jobs: (() => Promise<T>)[], width = 4): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]!();
      }
    }),
  );
  return out;
}

/** A folder whose `claude` records each call: no hook may call a model. */
const fakeBin = mkdtempSync(join(tmpdir(), "hoop-rules-bin-"));
writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\necho "$*" >> "${fakeBin}/claude.log"\nexit 1\n`, { mode: 0o755 });
const modelCalls = () => (existsSync(join(fakeBin, "claude.log")) ? readFileSync(join(fakeBin, "claude.log"), "utf8") : "");

/** A hoop folder and the Claude Code folder its session's transcript sits in. */
type Home = { label: string; home: string; claude: string; transcript: string; port?: string };

/** The session's transcript in a Claude Code folder of its own, so each home's session has its own `.hoop`. */
function claudeFolder() {
  const claude = mkdtempSync(join(tmpdir(), "hoop-rules-claude-"));
  const dir = join(claude, "projects", "-tmp-hooks");
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, `${TEST_SESSION}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "Go" } })}\n`);
  return { claude, transcript };
}

/**
 * A hoop folder in use: todos the person reordered and commented on, one linked to a review, and a
 * review with feedback Claude hasn't read, so every gate has something to check.
 */
function normalHome(label: string): Home {
  const { claude, transcript } = claudeFolder();
  const was = process.env.HOOP_CLAUDE_DIR;
  process.env.HOOP_CLAUDE_DIR = claude;
  try {
    const home = tempHome();
    const hoop = new Hoop(new Store(home));
    const { review_id } = hoop.submit(example());
    hoop.review(review_id, { verdict: "changes_requested", reviewer: "ana", comments: [], summary: "Split it." });
    const post = INPUTS.find((i) => i.name === "post-tool-use/task-create")!.input;
    // Started after the review's revision, so todo #1 waits on the review.
    const later = new Date(Date.now() + 2000).toISOString();
    const todo = (id: string, subject: string, description: string, start: boolean) => {
      workHook(
        home,
        { ...structuredClone(post), transcript_path: transcript, tool_input: { subject, description }, tool_response: { task: { id, subject } } },
        later,
      );
      if (start)
        workHook(
          home,
          { ...structuredClone(post), transcript_path: transcript, tool_name: "TaskUpdate", tool_input: { taskId: id, status: "in_progress" } },
          later,
        );
    };
    todo("1", "Fix the parser", `Plan: http://localhost:4747/r/${review_id}`, true);
    todo("2", "Write the migration", "", true);
    todo("3", "Run the test suite", "", false);
    todo("4", "Ship it", "", false);
    // The recorded PreToolUse TaskUpdate starts #3, out of the person's order.
    editWork(home, TEST_SESSION, (r) => moveInQueue(r, "4", "before", "3"));
    addChanges(home, TEST_SESSION, [{ kind: "comment", todo: "2", text: "Keep it small" }], { by: "ankur", reachable: false });
    return { label, home, claude, transcript };
  } finally {
    process.env.HOOP_CLAUDE_DIR = was;
  }
}

/** A normal home with every file in it garbled: JSON that doesn't parse, and gate files of noise. */
function brokenHome(label: string): Home {
  const h = normalHome(label);
  const garble = (dir: string) => {
    for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      const path = join(dir, f);
      if (statSync(path).isFile()) writeFileSync(path, f.endsWith(".json") ? '{"broken": ' : "\u0000\tnoise\t\u0000\n");
    }
  };
  garble(h.home);
  garble(join(h.transcript.slice(0, -".jsonl".length), ".hoop"));
  return h;
}

function emptyHome(label: string): Home {
  return { label, home: tempHome(), ...claudeFolder() };
}

function missingHome(label: string): Home {
  return { label, home: join(tempHome(), "missing"), ...claudeFolder() };
}

const deadPort = String(await freePort());

/** The environment Claude Code gives a hook, with hoop pointed at `h` and no global hoop or gh. */
function envFor(h: Home, root = plugin): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "hoop-rules-user-"));
  return {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    HOME: home,
    CLAUDE_PLUGIN_ROOT: root.replace(/\/$/, ""),
    CLAUDE_CODE_SESSION_ID: TEST_SESSION,
    HOOP_BIN: HOOP,
    HOOP_HOME: h.home,
    HOOP_CLAUDE_DIR: h.claude,
    HOOP_REPO_DIR: process.env.HOOP_REPO_DIR!,
    HOOP_PORT: h.port ?? deadPort,
    HOOP_PAGES: "off",
    HOOP_NO_BROWSER: "1",
    HOOP_PLAN_WAIT_SECONDS: "1",
    ...(process.env.HOOP_TEST_BUILT ? { HOOP_TEST_BUILT: process.env.HOOP_TEST_BUILT } : {}),
  };
}

const withTranscript = (input: Record<string, unknown>, h: Home) => ({ ...structuredClone(input), transcript_path: h.transcript });

/** A block's message names the way out: what Claude does next. */
const WAY_OUT = /read it with hoop_|hoop_\w+|tell the user|end your turn|keep it in progress|turn the hook off|or ask them/i;

/** Whether the hook's result blocks Claude, and its message. */
function blockOf(r: Run): string | undefined {
  if (r.code === 2) return r.stderr;
  try {
    const out = JSON.parse(r.stdout);
    if (out.decision === "block") return String(out.reason);
    const d = out.hookSpecificOutput?.permissionDecision;
    if (d === "deny" || d === "ask") return String(out.hookSpecificOutput.permissionDecisionReason);
  } catch {
    /* no JSON: no block */
  }
  return undefined;
}

/** What is wrong with a hook's output for its event: Claude Code reads nothing else. */
function shapeProblem(hook: Hook, r: Run): string | undefined {
  if (r.code !== 0 && r.code !== 2) return `exit ${r.code}`;
  if (r.code === 2) {
    if (!["PreToolUse", "TaskCompleted"].includes(hook.event)) return "exit 2 on an event the plugin never blocks";
    if (r.stdout) return "exit 2 with stdout";
    return r.stderr.trim() ? undefined : "exit 2 without a reason on stderr";
  }
  if (r.stderr) return `stderr on exit 0: ${JSON.stringify(r.stderr.slice(0, 200))}`;
  if (!r.stdout) return undefined;
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    return `stdout isn't JSON: ${JSON.stringify(r.stdout.slice(0, 200))}`;
  }
  const spec = out.hookSpecificOutput as Record<string, unknown> | undefined;
  const ok =
    hook.event === "PreToolUse"
      ? Object.keys(out).join() === "hookSpecificOutput" &&
        spec?.hookEventName === "PreToolUse" &&
        ["allow", "deny", "ask"].includes(String(spec.permissionDecision)) &&
        typeof spec.permissionDecisionReason === "string"
      : hook.event === "Stop"
        ? Object.keys(out).sort().join() === "decision,reason" && out.decision === "block" && typeof out.reason === "string"
        : hook.event === "SessionStart"
          ? Object.keys(out).join() === "hookSpecificOutput" && spec?.hookEventName === "SessionStart" && typeof spec.additionalContext === "string"
          : false;
  return ok ? undefined : `output isn't ${hook.event}'s shape: ${r.stdout.slice(0, 200)}`;
}

/** The pairs Claude Code runs: each hook with each recorded input it runs for. */
const PAIRS = HOOKS.flatMap((hook) => INPUTS.filter((i) => runsFor(hook, i.input)).map((input) => ({ hook, input })));
const label = (hook: Hook, input: string, home: string) => `${hook.script} (${hook.event}${hook.matcher ? ` ${hook.matcher}` : ""}) ← ${input}, ${home}`;

test("every hook in hooks.json is a command, and has at least one recorded input it runs for", () => {
  assert.ok(HOOKS.length >= 10);
  for (const hook of HOOKS) {
    assert.equal(hook.type, "command", `${hook.script}: never a prompt or agent hook, which calls a model`);
    assert.ok(
      PAIRS.some((p) => p.hook === hook),
      `${hook.script} (${hook.event}${hook.matcher ? ` ${hook.matcher}` : ""}) has no recorded input in test/fixtures/hook-inputs/`,
    );
  }
  for (const { name, input } of INPUTS) {
    assert.equal(input.session_id, TEST_SESSION, `${name}: one session`);
    assert.doesNotMatch(JSON.stringify(input), /\/Users\/(?!me\/)/, `${name}: paths sanitized`);
  }
});

test("replayed against every hoop folder, hooks fail open, block only with a way out, and print only their event's shape", { timeout: 120_000 }, async () => {
  const homes = [missingHome("no hoop folder"), emptyHome("an empty hoop folder"), brokenHome("a broken hoop folder"), normalHome("a hoop folder in use")];
  const jobs = homes.flatMap((h) =>
    PAIRS.map(({ hook, input }) => async () => ({
      hook,
      input: input.name,
      h,
      r: await run(hook.command, JSON.stringify(withTranscript(input.input, h)), envFor(h)),
    })),
  );
  const failures: string[] = [];
  for (const { hook, input, h, r } of await pool(jobs)) {
    const at = label(hook, input, `${h.label}, pages process down`);
    const shape = shapeProblem(hook, r);
    if (shape) failures.push(`${at}: prints only its event's output: ${shape}`);
    const block = blockOf(r);
    if (hook.script === "plan-review") {
      // The plan hook fails closed: with no pages process the plan isn't reviewed, so it denies.
      if (!block) failures.push(`${at}: plan-review denies when it can't review the plan`);
      else if (!WAY_OUT.test(block)) failures.push(`${at}: names the way out: ${block}`);
    } else if (r.code !== 0 || block) failures.push(`${at}: fails open: exit ${r.code}, ${block ?? r.stdout}`);
  }
  assert.deepEqual(failures, []);
  assert.equal(modelCalls(), "", "never calls a model");
});

test("with the pages process up, a hook blocks at most once per cause, naming the way out", { timeout: 120_000 }, async () => {
  const h = normalHome("a hoop folder in use");
  h.port = (await pagesFor(h.home)).HOOP_PORT;
  const failures: string[] = [];
  let blocked = 0;
  // The plan hook denies until a person approves the plan: its own tests cover it (plan.test.ts).
  // The gates go first, before the recorded todo calls replace the folder's todos.
  const pairs = PAIRS.filter((p) => p.hook.script !== "plan-review").sort((a, b) => Number(a.hook.async) - Number(b.hook.async));
  for (const { hook, input } of pairs) {
    const stdin = JSON.stringify(withTranscript(input.input, h));
    const at = label(hook, input.name, "pages process up");
    const first = await run(hook.command, stdin, envFor(h));
    const second = await run(hook.command, stdin, envFor(h));
    for (const r of [first, second]) {
      const shape = shapeProblem(hook, r);
      if (shape) failures.push(`${at}: prints only its event's output: ${shape}`);
    }
    const block = blockOf(first);
    if (block) {
      blocked++;
      if (!WAY_OUT.test(block)) failures.push(`${at}: names the way out: ${block}`);
    }
    if (blockOf(second)) failures.push(`${at}: blocks once per cause, but blocked the same input twice: ${blockOf(second)}`);
  }
  assert.deepEqual(failures, []);
  assert.ok(blocked >= 2, "the folder in use gives the gates something to block");
  assert.equal(modelCalls(), "", "never calls a model");
});

test("regression: a hook whose watchdog it stops leaves nothing on stderr", async () => {
  // The shell printed "Terminated: 15 ( sleep ...; kill ... )" for the watchdog it stopped after hoop answered.
  const h = normalHome("a hoop folder in use");
  const hooks = ["session-start", "stop-gate", "pre-compact"].map((s) => HOOKS.find((k) => k.script === s)!);
  const inputs = { "session-start": "session-hooks/resume", "stop-gate": "stop/stop", "pre-compact": "session-hooks/pre-compact" } as Record<string, string>;
  for (const hook of hooks) {
    const input = INPUTS.find((i) => i.name === inputs[hook.script])!.input;
    const r = await run(hook.command, JSON.stringify(withTranscript(input, h)), envFor(h));
    assert.deepEqual([r.code, r.stderr], [0, ""], hook.script);
  }
});

/** Input that isn't a JSON object: Claude Code never sends it, and no hook may crash on it. */
const NOT_OBJECTS = ["", "null", '"a string"', "42", "[]", '{"session_id": '];

test("input that isn't an object is nothing to do for every hook, and plan-review denies naming the problem", { timeout: 120_000 }, async () => {
  const h = normalHome("a hoop folder in use");
  const jobs = HOOKS.flatMap((hook) => NOT_OBJECTS.map((text) => async () => ({ hook, text, r: await run(hook.command, text, envFor(h)) })));
  const failures: string[] = [];
  for (const { hook, text, r } of await pool(jobs)) {
    const at = label(hook, JSON.stringify(text), h.label);
    if (hook.script === "plan-review" && text !== "") {
      const reason = blockOf(r);
      if (r.code !== 0 || !reason || !/isn't valid JSON|not a JSON object/.test(reason))
        failures.push(`${at}: denies naming the problem: exit ${r.code}, ${r.stdout}${r.stderr}`);
    } else if (hook.script !== "plan-review" && (r.code !== 0 || r.stdout || r.stderr))
      failures.push(`${at}: nothing to do: exit ${r.code}, ${JSON.stringify(r.stdout + r.stderr)}`);
  }
  assert.deepEqual(failures, []);
});

/** How fast a hook with nothing to check must answer: 300 ms, with headroom for a busy CI machine. */
const TARGET_MS = 300;
const HEADROOM = process.env.HOOP_TEST_BUILT === "1" ? 3 : 5;

/**
 * The hooks slower than TARGET_MS × HEADROOM with nothing to check (an empty hoop folder), each by
 * its faster of two runs. The plan hook always has a plan to review, so it isn't timed.
 */
async function slowHooks(root: string): Promise<string[]> {
  const h = emptyHome("an empty hoop folder");
  const slow: string[] = [];
  // tsx compiles hoop on its first start; time the hooks, not that.
  await run(`${HOOP} help`, "", envFor(h, root));
  for (const { hook, input } of hooksOf(root).flatMap((hook) => INPUTS.filter((i) => runsFor(hook, i.input)).map((input) => ({ hook, input })))) {
    if (hook.script === "plan-review") continue;
    const stdin = JSON.stringify(withTranscript(input.input, h));
    let ms = Infinity;
    for (let n = 0; n < 2 && ms > TARGET_MS * HEADROOM; n++) ms = Math.min(ms, (await run(hook.command, stdin, envFor(h, root))).ms);
    if (ms > TARGET_MS * HEADROOM) slow.push(`${label(hook, input.name, h.label)}: ${Math.round(ms)} ms, over ${TARGET_MS * HEADROOM} ms`);
  }
  return slow;
}

test("every hook is fast with nothing to check", { timeout: 120_000 }, async () => {
  assert.deepEqual(await slowHooks(plugin), []);
});

test("the timing check fails a hook made slow on purpose", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hoop-rules-plugin-"));
  cpSync(plugin, root, { recursive: true });
  const script = join(root, "scripts/track-pr.sh");
  writeFileSync(script, readFileSync(script, "utf8").replace("input=$(cat)", `input=$(cat)\nsleep ${(TARGET_MS * HEADROOM) / 1000 + 0.5}`));
  const slow = await slowHooks(root);
  assert.ok(slow.length > 0 && slow.every((s) => s.startsWith("track-pr (PostToolUse Bash)")), slow.join("\n"));
});
