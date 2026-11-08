import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { addChanges } from "../src/steer.js";
import { Store } from "../src/store.js";
import { editWork, moveInQueue, workHook } from "../src/work.js";
import { example, freePort, hoopArgs, pagesFor, TEST_SESSION } from "./helpers.js";

// Replays the recorded hook inputs in test/fixtures/hook-inputs/ through the plugin's hooks, as
// hooks.json runs them, against hoop folders in every state, and checks the rules every hook keeps
// (docs/DESIGN.md, "Rules every hook keeps"). Each gate's own tests cover what it blocks (stop-gate,
// done-gate, steer and plan tests); this checks the rules hold for every input Claude Code sends.

const plugin = new URL("../plugins/hoop/", import.meta.url).pathname;
const inputsDir = new URL("./fixtures/hook-inputs/", import.meta.url).pathname;
const srcDir = new URL("../src/", import.meta.url).pathname;
const HOOP = [process.execPath, ...hoopArgs].join(" ");

type Hook = { event: string; matcher?: string; command: string; script: string; async: boolean; type: string };
type Input = { name: string; input: Record<string, unknown> };
type Run = { code: number | null; stdout: string; stderr: string; ms: number };

/** Every temporary folder the file makes, removed once its tests end. */
const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), `hoop-rules-${prefix}-`));
  temps.push(dir);
  return dir;
};
after(async () => {
  // A pages process still starting would make its folder again.
  await Promise.allSettled(started);
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

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
const inputNamed = (name: string) => INPUTS.find((i) => i.name === name)!.input;

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

/** The pairs Claude Code runs: each hook with each recorded input it runs for. */
const pairsOf = (hooks: Hook[]) => hooks.flatMap((hook) => INPUTS.filter((i) => runsFor(hook, i.input)).map((input) => ({ hook, input })));
const PAIRS = pairsOf(HOOKS);
const hookName = (hook: Hook) => `${hook.script} (${hook.event}${hook.matcher ? ` ${hook.matcher}` : ""})`;
const label = (hook: Hook, input: string, where: string) => `${hookName(hook)} ← ${input}, ${where}`;

/** Runs a hook's command as Claude Code does: through `shell -c`, with CLAUDE_PLUGIN_ROOT set. */
function run(command: string, stdin: string, env: Record<string, string>, shell = "/bin/sh"): Promise<Run> {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn(shell, ["-c", command], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - start }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

/** Runs `jobs` six at a time; the results keep the jobs' order. */
async function pool<T>(jobs: (() => Promise<T>)[], width = 6): Promise<T[]> {
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
const fakeBin = temp("bin");
writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\necho "$*" >> "${fakeBin}/claude.log"\nexit 1\n`, { mode: 0o755 });
const modelCalls = () => (existsSync(join(fakeBin, "claude.log")) ? readFileSync(join(fakeBin, "claude.log"), "utf8") : "");
/** The hooks' HOME: never the person's own. */
const userHome = temp("user");

/** A hoop folder, the Claude Code folder its session's transcript sits in, and its review, if any. */
type Home = { label: string; home: string; claude: string; transcript: string; review?: string; port?: string };

/** The session's transcript in a Claude Code folder of its own, so each home's session has its own `.hoop`. */
function claudeFolder() {
  const claude = temp("claude");
  const dir = join(claude, "projects", "-tmp-hooks");
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, `${TEST_SESSION}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "Go" } })}\n`);
  return { claude, transcript };
}

/**
 * A hoop folder in use: todos the person reordered and commented on, todo #1 waiting on a review,
 * and the review's feedback Claude hasn't read, so every gate has something to block.
 */
function normalHome(label: string): Home {
  const { claude, transcript } = claudeFolder();
  const was = process.env.HOOP_CLAUDE_DIR;
  process.env.HOOP_CLAUDE_DIR = claude;
  try {
    const home = temp("home");
    const hoop = new Hoop(new Store(home));
    const { review_id } = hoop.submit(example());
    hoop.review(review_id, { verdict: "changes_requested", reviewer: "ana", comments: [], summary: "Split it." });
    // A second review, still waiting on the person: the gate refuses a file write once.
    hoop.submit({ ...example(), title: "Back up the orders database nightly", slug: "backup" });
    const post = inputNamed("post-tool-use/task-create");
    // Started after the review's revision, so todo #1 waits on the review.
    const later = new Date(Date.now() + 2000).toISOString();
    const todo = (id: string, subject: string, description: string, start: boolean) => {
      const base = { ...structuredClone(post), transcript_path: transcript };
      workHook(home, { ...base, tool_input: { subject, description }, tool_response: { task: { id, subject } } }, later);
      if (start) workHook(home, { ...base, tool_name: "TaskUpdate", tool_input: { taskId: id, status: "in_progress" } }, later);
    };
    todo("1", "Fix the parser", `Plan: http://localhost:4747/r/${review_id}`, true);
    todo("2", "Write the migration", "", true);
    todo("3", "Run the test suite", "", false);
    todo("4", "Ship it", "", false);
    // The recorded PreToolUse TaskUpdate starts #3, out of the person's order.
    editWork(home, TEST_SESSION, (r) => moveInQueue(r, "4", "before", "3"));
    addChanges(home, TEST_SESSION, [{ kind: "comment", todo: "2", text: "Keep it small" }], { by: "ankur", reachable: false });
    return { label, home, claude, transcript, review: review_id };
  } finally {
    process.env.HOOP_CLAUDE_DIR = was;
  }
}

/** A hoop folder in use with every file in it garbled: JSON that doesn't parse, and gate files of noise. */
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

const emptyHome = (label: string): Home => ({ label, home: temp("home"), ...claudeFolder() });
const missingHome = (label: string): Home => ({ label, home: join(temp("home"), "missing"), ...claudeFolder() });

/** `h` with a pages process for its folder. */
async function withPages(h: Home): Promise<Home> {
  return { ...h, label: `${h.label}, pages process up`, port: (await pagesFor(h.home)).HOOP_PORT };
}

const deadPort = String(await freePort());
/** Each folder with a pages process, started by the first test that needs it; after() waits for them. */
const started: Promise<unknown>[] = [];
const once = (make: () => Promise<Home>) => {
  let home: Promise<Home> | undefined;
  return () => {
    if (!home) started.push((home = make()));
    return home;
  };
};
const brokenUp = once(() => withPages(brokenHome("a broken hoop folder")));
const inUseUp = once(() => withPages(normalHome("a hoop folder in use")));

/** The environment Claude Code gives a hook, with hoop pointed at `h` and no global hoop or gh. */
function envFor(h: Home, root = plugin): Record<string, string> {
  return {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    HOME: userHome,
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

/** A recorded input for `h`: its transcript, and its review for the one that names a review. */
function inputFor(input: Record<string, unknown>, h: Home): Record<string, unknown> {
  const text = JSON.stringify({ ...input, transcript_path: h.transcript });
  return JSON.parse(h.review ? text.replaceAll("rv_REVIEW", h.review) : text);
}

/** Whether the hook's result blocks Claude, and its message. */
function blockOf(r: Run): string | undefined {
  if (r.code === 2) return r.stderr.trim();
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

/** The whole instructions one of which each cause of a block holds: what Claude does next. */
const WAYS_OUT = [
  // The Stop gate's causes, and the Work changes it tells.
  /read it with hoop_feedback rv_\w+\./,
  /take (?:it|them) with hoop_build_wait rv_\w+\./,
  /Answer it with hoop_reply on ch_\w+, as well as in chat\./,
  /Don't do it: delete it with TaskUpdate/,
  /Create it with TaskCreate/,
  /don't start it until (?:it is unparked|#\d+ is done)/,
  /It is back in the queue: do it in its turn\./,
  /Do #\d+ first\./,
  /stop it now with TaskStop/,
  /mark it completed .+, or say what's left\./,
  // The Work gate's.
  /start #\d+, or ask them\./,
  /Go on with another todo, or ask them\./,
  /First .+, or ask the person; starting #\d+ again goes on\./,
  /end your turn now and say what you finished\./,
  // Its gate on file writes while a review waits on the person.
  /Wait with hoop_wait rv_\w+, or end your turn and hoop tells you when they review\. If this change isn't part of that work, make it again: it goes on/,
  /stop and report back to the session that started you\. If this change isn't part of that work, make it again: it goes on/,
  // The done gate's.
  /Keep it in progress until that's done, or, if the todo is done without it, mark it completed again and hoop notes it as done without it\./,
  // The plan hook's.
  /The plan wasn't reviewed, so stop here and tell the user; they can run hoop plan-review themselves or turn the hook off\./,
  /Stop here and tell the user the plan wasn't reviewed\./,
  /Write the plan, then leave plan mode again\./,
  /Stop here and tell the user to review it at \S+\. Once they approve it there, they ask you to go on, and leaving plan mode again finds the approval\./,
  /Revise it with this feedback, then leave plan mode again\./,
  /This changed plan needs a new review: leave plan mode again to send it\./,
  /Don't carry out this plan; ask the user how to go on\./,
];
/** The Stop gate's preamble, said once before its causes. */
const STOP_PREAMBLE = /^Before you end your turn \(hoop says this once\): /;
/** What every Stop gate cause says before its instruction, whoever it names ("Ankur Jain reviewed ..."). */
const CAUSE_MARK = /, and you haven't read it: | that you haven't taken: /;

/**
 * The causes in a block's message that hold no whole instruction. A Stop gate block is split after
 * each cause's mark, so each part holds that cause's instruction and, at most, the next one's opening.
 */
function wayOutProblems(block: string): string[] {
  const text = block.trim();
  let causes = [text];
  if (STOP_PREAMBLE.test(text)) {
    const [, ...after] = text.replace(STOP_PREAMBLE, "").split(CAUSE_MARK);
    causes = after.length ? after : [text.replace(STOP_PREAMBLE, "")];
  }
  return causes.filter((c) => !WAYS_OUT.some((w) => w.test(c))).map((c) => `names no way out: ${JSON.stringify(c)}`);
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
  const only = (keys: string) => Object.keys(out).sort().join() === keys;
  let ok = false;
  if (hook.event === "PreToolUse")
    ok =
      only("hookSpecificOutput") &&
      spec?.hookEventName === "PreToolUse" &&
      ["allow", "deny", "ask"].includes(String(spec.permissionDecision)) &&
      typeof spec.permissionDecisionReason === "string";
  else if (hook.event === "Stop") ok = only("decision,reason") && out.decision === "block" && typeof out.reason === "string";
  else if (hook.event === "SessionStart")
    ok = only("hookSpecificOutput") && spec?.hookEventName === "SessionStart" && typeof spec.additionalContext === "string";
  return ok ? undefined : `output isn't ${hook.event}'s shape: ${r.stdout.slice(0, 200)}`;
}

/** The rule each result breaks: its output's shape, and a block with no way out. */
function outputProblems(hook: Hook, r: Run): string[] {
  const shape = shapeProblem(hook, r);
  const block = blockOf(r);
  return [...(shape ? [`prints only its event's output: ${shape}`] : []), ...(block ? wayOutProblems(block) : [])];
}

test("every hook in hooks.json is a command, and has at least one recorded input it runs for", () => {
  assert.ok(HOOKS.length >= 10);
  for (const hook of HOOKS) {
    assert.equal(hook.type, "command", `${hook.script}: never a prompt or agent hook, which calls a model`);
    assert.ok(
      PAIRS.some((p) => p.hook === hook),
      `${hookName(hook)} has no recorded input in test/fixtures/hook-inputs/`,
    );
  }
  for (const { name, input } of INPUTS) {
    assert.equal(input.session_id, TEST_SESSION, `${name}: one session`);
    assert.doesNotMatch(JSON.stringify(input), /\/Users\/(?!me\/)|\/home\/(?!me\/)/, `${name}: paths sanitized`);
  }
});

/**
 * The only src/ files that may import a network module (http, https, net, tls, http2, dgram), and why.
 * hoop calls no model: it talks to its own pages process on loopback and to the person's own Claude
 * Code sessions. A file that needs the network for anything else is a change to this rule: add it
 * here with its reason, and to "Rules every hook keeps" in docs/DESIGN.md.
 */
const NETWORK_FILES: Record<string, string> = {
  "pages.ts": "asks 127.0.0.1 whether a pages process answers (http), and whether the port is taken on ::1 (net)",
  "remote.ts": "sends writes to the pages process on 127.0.0.1 (http)",
  "web.ts": "is the pages process: serves the pages on loopback (http)",
  "deliver.ts": "writes a person's review, Work change or action item result into their own Claude Code session's messaging socket (net)",
};
/** The only src/ file that may run `claude`: `hoop init` installs the plugin with it. */
const CLAUDE_FILES = ["init.ts"];

test("no hook's code calls a model: hoop's source has no model SDK, runs claude only to install, and touches the network only where listed", () => {
  // Most of a hook's work runs in the pages process, whose PATH may hold a real claude; the fake
  // claude on the hooks' PATH can't see that, so this reads the source, comments stripped.
  const problems: string[] = [];
  for (const f of readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"))) {
    const code = readFileSync(join(srcDir, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
    if (/@anthropic-ai\/|anthropic\.com/i.test(code)) problems.push(`${f}: names a model SDK or API`);
    // "claude" as a program: the first argument of a call, or the start of a command line.
    if (!CLAUDE_FILES.includes(f) && /\(\s*["'`]claude(?:["'`]|\s)|["'`]claude\s+-/.test(code)) problems.push(`${f}: runs claude`);
    const network = /(?:from\s*|import\(\s*|require\(\s*)["'](?:node:)?(?:http|https|net|tls|http2|dgram)["']/.test(code);
    if (network && !(f in NETWORK_FILES)) problems.push(`${f}: imports a network module`);
  }
  assert.deepEqual(
    problems,
    [],
    "hoop calls no model. A file listed here needs a reason in NETWORK_FILES or CLAUDE_FILES (test/hook-rules.test.ts) and docs/DESIGN.md",
  );
});

test("replayed against every hoop folder, hooks fail open, block only with a way out, and print only their event's shape", { timeout: 120_000 }, async () => {
  // The next test's pages process starts alongside this one's.
  void inUseUp();
  const homes = [
    missingHome("no hoop folder"),
    emptyHome("an empty hoop folder"),
    brokenHome("a broken hoop folder"),
    await brokenUp(),
    normalHome("a hoop folder in use"),
  ];
  const jobs = homes.flatMap((h) =>
    PAIRS.map(({ hook, input }) => async () => ({
      hook,
      input: input.name,
      h,
      r: await run(hook.command, JSON.stringify(inputFor(input.input, h)), envFor(h)),
    })),
  );
  const failures: string[] = [];
  for (const { hook, input, h, r } of await pool(jobs)) {
    const at = label(hook, input, h.port ? h.label : `${h.label}, pages process down`);
    for (const p of outputProblems(hook, r)) failures.push(`${at}: ${p}`);
    const block = blockOf(r);
    // The plan hook fails closed: with no pages process, or a broken folder, the plan isn't reviewed, so it denies.
    if (hook.script === "plan-review") {
      if (!block) failures.push(`${at}: plan-review denies when it can't review the plan`);
    } else if (r.code !== 0 || block) failures.push(`${at}: fails open: exit ${r.code}, ${block ?? r.stdout}`);
  }
  assert.deepEqual(failures, []);
  assert.equal(modelCalls(), "", "never calls a model");
});

test("with the pages process up, each gate blocks once per cause, naming the way out", { timeout: 120_000 }, async () => {
  const h = await inUseUp();
  const failures: string[] = [];
  // The plan hook denies until a person approves the plan: its own tests cover it (plan.test.ts).
  const pairs = PAIRS.filter((p) => p.hook.script !== "plan-review");

  // A real input wrapped in a list gets past each sync hook's checks, so hoop runs, then is nothing
  // to do: the gates still block their causes below, for the first time.
  const started = join(temp("started"), "log");
  const logging = join(fakeBin, "hoop-logged");
  writeFileSync(logging, `#!/bin/sh\necho "$1" >> "${started}"\nexec ${HOOP} "$@"\n`, { mode: 0o755 });
  const wrapped = await pool(
    pairs
      .filter((p) => !p.hook.async)
      .map(({ hook, input }) => async () => ({
        hook,
        input,
        r: await run(hook.command, JSON.stringify([inputFor(input.input, h)]), { ...envFor(h), HOOP_BIN: logging }),
      })),
  );
  for (const { hook, input, r } of wrapped)
    if (r.code !== 0 || r.stdout || r.stderr)
      failures.push(`${label(hook, `[${input.name}]`, h.label)}: nothing to do: exit ${r.code}, ${JSON.stringify(r.stdout + r.stderr)}`);
  const ran = new Set(readFileSync(started, "utf8").split("\n"));
  for (const command of ["work-gate", "stop-gate", "done-gate"]) assert.ok(ran.has(command), `a wrapped input reached hoop ${command}`);

  // The gates go first, before the recorded todo calls replace the folder's todos; each input goes twice.
  const blocks = new Map<string, string>();
  const twice = async (group: typeof pairs) =>
    pool(
      group.map(({ hook, input }) => async () => {
        const stdin = JSON.stringify(inputFor(input.input, h));
        const first = await run(hook.command, stdin, envFor(h));
        return { hook, input, first, second: await run(hook.command, stdin, envFor(h)) };
      }),
    );
  for (const group of [pairs.filter((p) => !p.hook.async), pairs.filter((p) => p.hook.async)])
    for (const { hook, input, first, second } of await twice(group)) {
      const at = label(hook, input.name, h.label);
      for (const r of [first, second]) for (const p of outputProblems(hook, r)) failures.push(`${at}: ${p}`);
      const block = blockOf(first);
      if (block) blocks.set(`${hook.script} ← ${input.name}`, block);
      if (blockOf(second)) failures.push(`${at}: blocks once per cause, but blocked the same input twice: ${blockOf(second)}`);
    }
  assert.deepEqual(failures, []);
  assert.deepEqual([...blocks.keys()].sort(), [
    "done-gate ← task-completed/review-linked",
    "gate-work ← pre-tool-use/task-update",
    "gate-work ← pre-tool-use/write",
    "stop-gate ← stop/stop",
  ]);
  assert.match(blocks.get("gate-work ← pre-tool-use/task-update")!, /^The person put #4 first in hoop's Work view; start #4, or ask them\.$/);
  assert.match(
    blocks.get("gate-work ← pre-tool-use/write")!,
    /^Your review "Back up the orders database nightly" \(http:\/\/localhost:\d+\/r\/rv_\w+\) waits on the person to review revision 1,/,
  );
  assert.match(
    blocks.get("stop-gate ← stop/stop")!,
    new RegExp(`ana reviewed "[^"]+" in hoop, and you haven't read it: read it with hoop_feedback ${h.review}\\.`),
  );
  assert.match(
    blocks.get("done-gate ← task-completed/review-linked")!,
    /^hoop \(once\): todo #1 "Fix the parser" isn't done yet: .+\. Keep it in progress until that's done/,
  );
  assert.equal(modelCalls(), "", "never calls a model");
});

test("the way-out check needs a whole instruction for each cause, after the Stop gate's preamble", () => {
  const preamble = "Before you end your turn (hoop says this once): ";
  const review = 'ana reviewed "Plan" in hoop, and you haven\'t read it: read it with hoop_feedback rv_abc.';
  assert.deepEqual(wayOutProblems(preamble + review), []);
  assert.equal(wayOutProblems(`${preamble}${review} bo changed your work in hoop's Work view, and you haven't read it: see hoop_feedback.`).length, 1);
  assert.equal(wayOutProblems(`${preamble}ana reviewed "Plan" in hoop.`).length, 1, "the preamble alone isn't a way out");
  const named = `${preamble}Ankur J. Jain reviewed "Plan" in hoop, and you haven't read it: read it with hoop_feedback rv_abc. Bo Li changed your work in hoop's Work view, and you haven't read it: `;
  assert.deepEqual(
    wayOutProblems(`${named}Comment ch_1 on todo #2 "Ship it": "Small". Answer it with hoop_reply on ch_1, as well as in chat.`),
    [],
    "names of several words",
  );
  assert.equal(wayOutProblems(`${named}Comment ch_1 on todo #2 "Ship it": "Small".`).length, 1, "the second cause has no instruction");
  assert.deepEqual(wayOutProblems("hoop: hoop plan-review failed (exit 1)."), ['names no way out: "hoop: hoop plan-review failed (exit 1)."']);
});

test("regression: a hook whose watchdog it stops leaves nothing on stderr, under bash too", async () => {
  // bash (macOS's sh) printed "Terminated: 15 ( sleep ...; kill ... )" for the watchdog it stopped
  // after hoop answered; dash, Linux's sh, doesn't, so the scripts run under bash where there is one.
  const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const h = normalHome("a hoop folder in use");
  const inputs: Record<string, string> = { "session-start": "session-hooks/resume", "stop-gate": "stop/stop", "pre-compact": "session-hooks/pre-compact" };
  for (const [script, input] of Object.entries(inputs)) {
    const hook = HOOKS.find((k) => k.script === script)!;
    const r = await run(hook.command.replace(/^sh /, `${shell} `), JSON.stringify(inputFor(inputNamed(input), h)), envFor(h), shell);
    assert.deepEqual([r.code, r.stderr], [0, ""], `${script} under ${shell}`);
  }
});

/** Input that isn't a JSON object: Claude Code never sends it, and no hook may crash on it. */
const NOT_OBJECTS = ["", "null", '"a string"', "42", "[]", '{"session_id": '];

test("input that isn't an object is nothing to do for every hook, and plan-review denies naming the problem", { timeout: 120_000 }, async () => {
  const h = normalHome("a hoop folder in use");
  const plan = JSON.stringify([inputFor(inputNamed("pre-tool-use/exit-plan-mode"), h)]);
  const jobs = HOOKS.flatMap((hook) =>
    [...NOT_OBJECTS, ...(hook.script === "plan-review" ? [plan] : [])].map((text) => async () => ({ hook, text, r: await run(hook.command, text, envFor(h)) })),
  );
  const failures: string[] = [];
  for (const { hook, text, r } of await pool(jobs)) {
    const at = label(hook, JSON.stringify(text.slice(0, 40)), h.label);
    if (hook.script === "plan-review") {
      // Empty input reads as an empty object: a plan hook input with no plan.
      const problem =
        text === "" ? /^The plan is empty, so there is nothing to review\./ : /isn't valid JSON|is (?:null|a list|a string|a number), not a JSON object/;
      const reason = blockOf(r);
      if (r.code !== 0 || !reason || !problem.test(reason)) failures.push(`${at}: denies naming the problem: exit ${r.code}, ${r.stdout}${r.stderr}`);
      for (const p of outputProblems(hook, r)) failures.push(`${at}: ${p}`);
    } else if (r.code !== 0 || r.stdout || r.stderr) failures.push(`${at}: nothing to do: exit ${r.code}, ${JSON.stringify(r.stdout + r.stderr)}`);
  }
  assert.deepEqual(failures, []);
});

/** How long a hook with nothing to check may add to hoop's start-up: 300 ms, with headroom for a busy CI machine. */
const TARGET_MS = 300;
const HEADROOM = process.env.HOOP_TEST_BUILT === "1" ? 3 : 5;
const ALLOWED_MS = TARGET_MS * HEADROOM;
/** Runs of each hook before it counts as slow; the timing stops at the first within the limit. */
const TRIES = 5;

/** How long a command takes, spawn to exit; a test swaps in a clock of its own. */
type Timer = (command: string, stdin: string, env: Record<string, string>) => Promise<number>;
const wallClock: Timer = async (command, stdin, env) => (await run(command, stdin, env)).ms;

/**
 * The hooks (all but the plan hook, or the pairs `only` picks) slower with nothing to check (an
 * empty hoop folder) than hoop's start-up plus ALLOWED_MS. Start-up is `hoop help` through `sh -c`,
 * the fastest of two timed just before each run of the hook: like a hook that starts hoop, it pays
 * for the shell, Node and loading hoop's CLI, so a busy machine slows both alike. Each hook runs up
 * to TRIES times; its fastest run is compared with the fastest start-up timed beside it. The plan
 * hook always has a plan to review, so it isn't timed.
 */
async function slowHooks(root: string, only?: (script: string, input: string) => boolean, time: Timer = wallClock): Promise<string[]> {
  const h = emptyHome("an empty hoop folder");
  const env = envFor(h, root);
  const startUp = async () => Math.min(await time(`${HOOP} help`, "", env), await time(`${HOOP} help`, "", env));
  const slow: string[] = [];
  // tsx compiles hoop on its first start; time the hooks, not that.
  await run(`${HOOP} help`, "", env);
  const timed = pairsOf(hooksOf(root)).filter(({ hook, input }) => (only ? only(hook.script, input.name) : hook.script !== "plan-review"));
  for (const { hook, input } of timed) {
    const stdin = JSON.stringify(inputFor(input.input, h));
    let ms = Infinity;
    let base = Infinity;
    for (let n = 0; n < TRIES; n++) {
      base = Math.min(base, await startUp());
      ms = Math.min(ms, await time(hook.command, stdin, env));
      if (ms <= base + ALLOWED_MS) break;
    }
    if (ms > base + ALLOWED_MS)
      slow.push(`${label(hook, input.name, h.label)}: ${Math.round(ms)} ms, over hoop's start-up of ${Math.round(base)} ms + ${ALLOWED_MS} ms`);
  }
  return slow;
}

test("every hook is fast with nothing to check", { timeout: 120_000 }, async () => {
  assert.deepEqual(await slowHooks(plugin), []);
});

test("the timing check fails a hook made slow on purpose", { timeout: 120_000 }, async () => {
  const root = temp("plugin");
  cpSync(plugin, root, { recursive: true });
  const script = join(root, "scripts/track-pr.sh");
  // A second past what it may add to start-up, so it is over wherever start-up lands.
  writeFileSync(script, readFileSync(script, "utf8").replace("input=$(cat)", `input=$(cat)\nsleep ${ALLOWED_MS / 1000 + 1}`));
  // Only the slowed hook, on the Bash call it has nothing to check for.
  const slow = await slowHooks(root, (script, input) => script === "track-pr" && input === "post-tool-use/bash");
  assert.equal(slow.length, 1);
  assert.match(slow[0]!, /^track-pr \(PostToolUse Bash\) ← post-tool-use\/bash, an empty hoop folder: \d+ ms, over hoop's start-up of \d+ ms \+ \d+ ms$/);
});

test("regression: a machine that slows every start alike fails no hook, and one hook slowed alone still fails (#397)", async () => {
  // A clock for a machine where starting hoop takes 2 s, over the old fixed limit as on a busy CI
  // runner: each hook adds 100 ms to that, and the `slowed` script ALLOWED_MS more.
  const busy = (slowed?: string): Timer => {
    return async (command) => {
      if (command.endsWith(" help")) return 2000;
      return 2100 + (slowed && command.includes(`/${slowed}.sh`) ? ALLOWED_MS : 0);
    };
  };
  assert.deepEqual(await slowHooks(plugin, undefined, busy()), []);
  const slow = await slowHooks(plugin, undefined, busy("track-pr"));
  assert.ok(slow.length > 0 && slow.every((s) => s.startsWith("track-pr ")), slow.join("\n"));
  assert.match(slow[0]!, new RegExp(`: ${2100 + ALLOWED_MS} ms, over hoop's start-up of 2000 ms \\+ ${ALLOWED_MS} ms$`));
});
