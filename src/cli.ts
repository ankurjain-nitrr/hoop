#!/usr/bin/env node
import { runMcp } from "./mcp.js";
import { Hoop, PORT, reviewUrl, type SubmitResult } from "./hoop.js";
import { resolve } from "node:path";
import { startWeb } from "./web.js";
import { ensurePages, ipv6Held, probe, runPages, watchStale } from "./pages.js";
import { storeKey } from "./sessions.js";
import { waitForAsk, waitForReview } from "./wait.js";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { checkInput, OPS, waitingLine, type CliArgs, type Op } from "./ops.js";
import { init } from "./init.js";
import { type PlanHookInput, planReview } from "./plan.js";
import { openedPr } from "./prs.js";
import { clientHoop, Remote, runOp as perform } from "./remote.js";
import { Store } from "./store.js";
import { CLEAR_USAGE, clearReviews } from "./clear.js";
import { currentUser, HoopError, hoopHome, isRecord } from "./util.js";
import { agentFromEnv, sessionFromEnv, validSession } from "./owner.js";
import { isDoneInput } from "./done.js";
import { isGateable } from "./stop.js";

/** How long `hoop work-hook` waits on the pages process before it drops the record. */
const WORK_HOOK_MS = 1500;
/** How long `hoop stop-gate` waits on the pages process before it lets the turn end. */
const STOP_GATE_MS = 2000;
/** How long `hoop done-gate` waits on the pages process, which reads the todo's pull requests from gh for up to 2 s. */
const DONE_GATE_MS = 3500;
const OPEN_USAGE = "open <file.md> [--title <t>] [--no-browser]";

const USAGE = `Usage: hoop <command>

  init [--print] [--yes | --no]
         Install hoop's Claude Code plugin (its MCP server and hooks) with claude, or print the commands.
         Then turn on Claude Code's todo tools for the Work view (CLAUDE_CODE_ENABLE_TODO_TOOLS=1 in
         its settings): it asks on a terminal; --yes or --no answers; otherwise it only says how.
  mcp    Start the MCP server on stdio and the review pages (for: claude mcp add hoop -- hoop mcp)
  serve  Serve the review pages only, on http://localhost:$HOOP_PORT (default 4747)
  ${OPEN_USAGE}
         Open a markdown file for you to review, as yours, with no Claude session: print its link and
         open it in the browser (--no-browser skips that). Run it again after editing the file to add
         a revision. Claude sessions can read it, comment and reply; only you revise it.
  wait <review_id> [--after <cursor>] [--timeout <seconds>] [--partial]
         Wait until a reviewer submits a review (or the review is approved), then print the
         feedback as JSON. Exit 0 on a review, 3 on timeout. Run it in the background. On a quick
         question, wait until every question has an answer, or with --partial for each answer.
  ${CLEAR_USAGE}
         Delete one review, or every review of one Claude Code session, for good. Asks first on a
         terminal; otherwise needs --yes. hoop never deletes reviews by itself.
  plan-review
         Claude Code's plan hook: review the plan on stdin in hoop, and print the hook's decision.
  pr-hook
         Claude Code's Bash hook: track the pull request a \`gh pr create\` on stdin opened. Always exits 0.
  work-hook
         Claude Code's hook on the todo and Agent tools and on subagents: record the session's todos
         and subagents on stdin for the Work page. Always exits 0.
  work-gate
         Claude Code's hook before each tool call: refuse a todo a person removed or edited, a todo
         started out of the order a person set, or any tool call of an agent a person stopped, from
         the Work page. Prints the hook's decision.
  stop-gate
         Claude Code's hook at the end of a turn: block it once for a todo left in progress by a turn
         with no tool calls, or for feedback that came during the turn unread. Prints the decision.
  done-gate
         Claude Code's hook when a todo is marked completed: refuse it once while a review it links
         to isn't approved or a pull request it owns isn't merged. Prints "refuse: <reason>" or nothing.

The same operations as hoop's agent tools (add --json for JSON output):
${commands()}
`;

function commands() {
  return OPS.filter((op) => op.cli)
    .map((op) => `  ${op.cli!.usage}\n         ${op.title}.`)
    .join("\n");
}

/** The operation and its command words for an argument list. */
function findOp(argv: string[]): { op: Op; command: string } | undefined {
  const names = OPS.flatMap((op) => (op.cli ? [{ op, command: op.cli.command }] : []));
  return names.sort((a, b) => b.command.length - a.command.length).find((n) => n.command.split(" ").every((w, i) => argv[i] === w));
}

/** The `--name <value>` flags in a usage line. */
export const valueFlags = (usage: string) => [...new Set([...usage.matchAll(/--([a-z-]+) </g)].map((m) => m[1]!))];

/** The flags a command takes, for the line that refuses another. */
const takesLine = (takes: string[]) =>
  takes.length ? `this command takes ${takes.map((f) => `--${f}`).join(", ")} and --json` : "this command takes only --json";

/** `--name=value` as its name and value; `--name` as its name alone. */
function splitFlag(a: string): [string, string?] {
  const eq = a.indexOf("=");
  return eq < 0 ? [a.slice(2)] : [a.slice(2, eq), a.slice(eq + 1)];
}

/**
 * Splits arguments into positionals and flags. A flag the command takes always consumes the next
 * argument (so values may start with `--`); `--name=value` works too, `--json` is the only
 * switch, and `--` ends the flags. Any other flag is refused, naming the valid ones.
 */
export function parseArgs(argv: string[], usage: string): CliArgs {
  const takes = valueFlags(usage);
  const pos: string[] = [],
    flags: Record<string, string | true> = {},
    lists: Record<string, string[]> = {};
  // A flag given more than once keeps its last value in flags and every value in lists.
  const set = (name: string, value: string) => {
    flags[name] = value;
    (lists[name] ??= []).push(value);
  };
  const bad = (message: string) => new HoopError(message, [{ path: "flags", message }]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const [name, value] = splitFlag(a);
    if (name === "json" && value === undefined) {
      flags.json = true;
      continue;
    }
    if (!takes.includes(name)) throw bad(`unknown flag --${name}; ${takesLine(takes)}`);
    if (value !== undefined) {
      set(name, value);
      continue;
    }
    if (i + 1 >= argv.length) throw bad(`--${name} needs a value`);
    set(name, argv[++i]!);
  }
  return { pos, flags, lists };
}

/** Readable output: top-level values one per line, nested ones as indented JSON. */
function text(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const entries: [string, unknown][] = Object.entries(value);
  return entries
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => (v !== null && typeof v === "object" ? `${k}:\n${JSON.stringify(v, null, 2).replace(/^/gm, "  ")}` : `${k}: ${v}`))
    .join("\n");
}

/** Runs the operation the arguments name, if any: true when one ran. */
async function runOp(argv: string[]): Promise<boolean> {
  const found = findOp(argv);
  if (!found) return false;
  const { op } = found;
  const cli = op.cli!;
  let out: unknown, args: CliArgs | undefined;
  try {
    args = parseArgs(argv.slice(found.command.split(" ").length), cli.usage);
    const hoop = clientHoop(),
      input = checkInput(op, cli.parse(args));
    const pages = op.link ? (await ensurePages(hoop.store.home, PORT, { wait: true })).notice : undefined;
    out = await perform(hoop, op, input, { actor: currentUser(), ...(pages ? { pages } : {}) });
    if (pages) {
      process.stderr.write(`hoop: ${pages.message}\n`);
      if (out && typeof out === "object") out = { ...out, pages };
    }
  } catch (err) {
    if (!(err instanceof HoopError)) throw err;
    reportError(err, cli.usage);
    return true;
  }
  const file = typeof args!.flags.out === "string" ? args!.flags.out : undefined;
  if (file) out = writeMarkdown(out, file, found.command);
  process.stdout.write((args!.flags.json ? JSON.stringify(out, null, 2) : text(out)) + "\n");
  return true;
}

/** An operation's refusal on stderr, with its usage when a required input is missing. */
function reportError(err: HoopError, usage: string) {
  process.stderr.write(`hoop: ${err.message}\n${err.errors.map((e) => `  ${e.path}: ${e.message}\n`).join("")}`);
  if (err.detail) process.stderr.write(`${JSON.stringify({ detail: err.detail }, null, 2)}\n`);
  if (err.errors.some((e) => e.message === "required")) process.stderr.write(`usage: hoop ${usage}\n`);
  process.exitCode = 1;
}

/** `--out <file>`: writes the result's markdown to the file, and the result names the file instead. */
function writeMarkdown(out: unknown, file: string, command: string): unknown {
  if (!isRecord(out) || typeof out.markdown !== "string") throw new HoopError(`hoop ${command} has no markdown to write to ${file}`);
  writeFileSync(file, out.markdown);
  return { ...out, markdown: undefined, written: file };
}

/** The command that opens a link, by platform; others use xdg-open. */
const OPENERS: Partial<Record<NodeJS.Platform, string>> = { darwin: "open", win32: "explorer" };

/** Opens a link in the person's browser, unless HOOP_NO_BROWSER is set; a failure only means they open it themselves. */
function openBrowser(url: string) {
  if (process.env.HOOP_NO_BROWSER) return;
  const command = OPENERS[process.platform] ?? "xdg-open";
  try {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no opener: the link is printed */
  }
}

/** `hoop open`: a review of a markdown file, owned by the person at the terminal. */
async function openCommand(argv: string[]) {
  const browser = !argv.includes("--no-browser");
  try {
    const args = parseArgs(
      argv.filter((a) => a !== "--no-browser"),
      OPEN_USAGE,
    );
    const [file, extra] = args.pos;
    if (!file || extra !== undefined) throw new HoopError(file ? "open takes one file" : "missing <file.md>", [{ path: "file", message: "required" }]);
    const hoop = clientHoop(null);
    const pages = (await ensurePages(hoop.store.home, PORT, { wait: true })).notice;
    try {
      readFileSync(file);
    } catch {
      throw new HoopError(`can't read ${file}`, [{ path: "file", message: "not a readable file" }]);
    }
    // The pages process writes the review; it reads the file from its full path.
    if (pages) throw new HoopError(`hoop couldn't save this: ${pages.message}`);
    const out = await hoop.remote!.post<SubmitResult>("open", {
      file: resolve(file),
      ...(typeof args.flags.title === "string" ? { title: args.flags.title } : {}),
    });
    if (args.flags.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else {
      const what = { created: "Opened", revised: "Added revision", superseded: "Opened a new review of", unchanged: "No change to" }[out.outcome];
      process.stdout.write(`${what} "${hoop.store.meta(out.review_id).title}"${out.outcome === "revised" ? ` (rev ${out.revision})` : ""}: ${out.url}\n`);
    }
    if (browser) openBrowser(out.url);
  } catch (err) {
    if (!(err instanceof HoopError)) throw err;
    process.stderr.write(`hoop: ${err.message}\nusage: hoop ${OPEN_USAGE}\n`);
    process.exitCode = 1;
  }
}

/** Commands act on the repository the terminal is in, from any subdirectory. */
function defaultRepo() {
  if (process.env.HOOP_REPO_DIR) return;
  try {
    process.env.HOOP_REPO_DIR = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    /* not in a git repository: the current directory */
  }
}

/** `hoop init`: refuses flags it doesn't know, and --yes with --no. */
async function initCommand(argv: string[]) {
  const flags = argv.slice(1);
  if (flags.some((f) => !["--print", "--yes", "--no"].includes(f)) || (flags.includes("--yes") && flags.includes("--no"))) {
    process.stderr.write("usage: hoop init [--print] [--yes | --no]\n");
    process.exitCode = 2;
    return;
  }
  const todo = (["yes", "no"] as const).find((answer) => flags.includes(`--${answer}`));
  process.exitCode = await init({ print: flags.includes("--print"), ...(todo ? { todo } : {}) });
}

/** What `hoop serve` says when its port is taken: by this store's pages, another store's, or another program. */
function portHeldLine(held: Awaited<ReturnType<typeof probe>>): string {
  if (held.kind === "old" || (held.kind === "pages" && held.info.store === storeKey(new Hoop().store.home)))
    return `hoop: port ${PORT} is already serving hoop\n`;
  if (held.kind === "pages") return `hoop: another hoop store serves port ${PORT}; set HOOP_PORT to use another port\n`;
  return `hoop: another program holds port ${PORT}; set HOOP_PORT to use another port\n`;
}

async function serveCommand() {
  if (process.env.HOOP_PAGES === "background") return runPages();
  const hoop = new Hoop();
  // A program on the IPv6 loopback address would answer this server's localhost links.
  if (await ipv6Held(PORT)) return void process.stdout.write(`hoop: another program holds port ${PORT}; set HOOP_PORT to use another port\n`);
  const server = await startWeb(hoop, PORT, { stale: watchStale(hoop) });
  if (server) return void process.stdout.write(`hoop: review pages on http://localhost:${PORT}\n`);
  process.stdout.write(portHeldLine(await probe()));
}

const WAIT_USAGE = "usage: hoop wait <review_id> [--after <cursor>] [--timeout <seconds>] [--partial]";
/** What `hoop wait` says about a flag whose value it refuses. */
const WAIT_FLAG_ERRORS = new Map([
  ["--timeout", "hoop: --timeout needs a positive number of seconds\n"],
  ["--after", "hoop: --after needs a cursor such as 1.0, from a submit, feedback or wait result\n"],
]);
type WaitOpts = { after?: string; seconds?: number; partial?: boolean };

/** `hoop wait`'s flags, or the line that refuses them. */
function waitOpts(rest: string[]): WaitOpts | string {
  const opts: WaitOpts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i]!, rest[i + 1]];
    if (flag === "--partial") {
      opts.partial = true;
      i--;
    } else if (flag === "--timeout" && Number.isFinite(Number(value)) && Number(value) > 0) opts.seconds = Number(value);
    else if (flag === "--after" && /^\d+\.\d+$/.test(value ?? "")) opts.after = value;
    else return WAIT_FLAG_ERRORS.get(flag) ?? `hoop: ${WAIT_USAGE}\n`;
  }
  return opts;
}

async function waitCommand(argv: string[]) {
  const [, id, ...rest] = argv;
  if (!id) throw new Error(WAIT_USAGE);
  const opts = waitOpts(rest);
  if (typeof opts === "string") {
    process.stderr.write(opts);
    process.exitCode = 2;
    return;
  }
  const hoop = clientHoop();
  const meta = hoop.store.meta(id);
  // stdout carries only the feedback's JSON; the line for the person goes to stderr.
  process.stderr.write(`hoop: ${waitingLine(meta.title, reviewUrl(meta.id), Boolean(meta.ask))}
`);
  const timing = { timeoutMs: (opts.seconds ?? 0) * 1000, after: opts.after };
  const result = meta.ask ? await waitForAsk(hoop, id, { ...timing, partial: opts.partial }) : await waitForReview(hoop, id, timing);
  if (!result) {
    process.stderr.write(`hoop: no ${meta.ask ? "answer" : "review"} on ${id} within ${opts.seconds}s\n`);
    process.exitCode = 3;
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

async function clearCommand(argv: string[]) {
  try {
    // The pages process deletes them, like every other write.
    const remote = new Remote(hoopHome());
    process.exitCode = await clearReviews(argv.slice(1), new Store(hoopHome(), { readOnly: true }), (ids) => remote.post("clear", { ids }));
  } catch (err) {
    if (!(err instanceof HoopError)) throw err;
    process.stderr.write(`hoop: ${err.message}\n`);
    process.exitCode = 2;
  }
}

/** A hook's input on stdin. */
const hookInput = (): unknown => JSON.parse(readFileSync(0, "utf8") || "{}");

async function planReviewCommand() {
  // Claude Code's ExitPlanMode hook: the hook's input on stdin, its decision as JSON on stdout.
  const input: PlanHookInput = JSON.parse(readFileSync(0, "utf8") || "{}");
  // A hook runs in its Claude Code session, which the hook's input names too.
  const hooked = validSession(input.session_id);
  const hoop = clientHoop(agentFromEnv() ?? (hooked ? { session: hooked, claude: true } : null));
  await ensurePages(hoop.store.home, PORT, { wait: true });
  const waitMs = Number(process.env.HOOP_PLAN_WAIT_SECONDS ?? 540) * 1000;
  process.stdout.write(`${JSON.stringify(await planReview(input, hoop, { waitMs }))}\n`);
}

async function prHookCommand() {
  // Claude Code's PostToolUse hook on Bash: it never fails the tool call, so every error is quiet.
  // It sends the pull request to the pages process, and drops it when none answers: it never starts one.
  try {
    const input = hookInput();
    if (openedPr(input))
      await new Remote(hoopHome(), PORT, { start: false }).post("pr_hook", {
        input,
        session: sessionFromEnv() ?? null,
        plugin: process.env.HOOP_PLUGIN_VERSION,
      });
  } catch {
    /* unreadable input, or no pages process */
  }
}

async function workHookCommand() {
  // Claude Code's hooks on the todo tools, the Agent tool and subagents: never fail the tool call.
  // Like pr-hook, it drops the record when no pages process answers. It gives up after
  // WORK_HOOK_MS: Claude Code's exit waits for its SessionEnd hooks. Every hook input goes, one
  // with no work too, so the pages process stamps that the hook ran.
  try {
    const input = hookInput();
    if (isRecord(input) && typeof input.hook_event_name === "string" && validSession(input.session_id))
      await new Remote(hoopHome(), PORT, { start: false, timeoutMs: WORK_HOOK_MS }).post("work_hook", { input, plugin: process.env.HOOP_PLUGIN_VERSION });
  } catch {
    /* unreadable input, or no pages process */
  }
}

async function workGateCommand() {
  // The gate's shell script decides what an error means: it fails open, except for a stopped agent.
  const input = hookInput();
  process.stdout.write(`${JSON.stringify(await new Remote(hoopHome()).post("work_gate", { input, plugin: process.env.HOOP_PLUGIN_VERSION }))}\n`);
}

async function stopGateCommand() {
  // Claude Code's Stop hook: any error, or no pages process, lets the turn end. It never starts one.
  let out: unknown = {};
  try {
    const input = hookInput();
    if (isGateable(input)) out = await new Remote(hoopHome(), PORT, { start: false, timeoutMs: STOP_GATE_MS }).post("stop_gate", { input });
  } catch {
    /* unreadable input, or no pages process */
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

async function doneGateCommand() {
  // Claude Code's TaskCompleted hook: any error, or no pages process, lets the completion go ahead. It never starts one.
  try {
    const input = hookInput();
    if (!isDoneInput(input)) return;
    const out: unknown = await new Remote(hoopHome(), PORT, { start: false, timeoutMs: DONE_GATE_MS }).post("done_gate", {
      input,
      plugin: process.env.HOOP_PLUGIN_VERSION,
    });
    const refuse = typeof out === "object" && out !== null && "refuse" in out ? out.refuse : undefined;
    if (typeof refuse === "string") process.stdout.write(`refuse: ${refuse}\n`);
  } catch {
    /* unreadable input, or no pages process */
  }
}

/** The commands that aren't operations, by name; each gets the whole argument list. */
const COMMANDS = new Map<string, (argv: string[]) => Promise<void>>([
  ["init", initCommand],
  ["mcp", () => runMcp()],
  ["serve", serveCommand],
  ["open", (argv) => openCommand(argv.slice(1))],
  ["wait", waitCommand],
  ["clear", clearCommand],
  ["plan-review", planReviewCommand],
  ["pr-hook", prHookCommand],
  ["work-hook", workHookCommand],
  ["work-gate", workGateCommand],
  ["stop-gate", stopGateCommand],
  ["done-gate", doneGateCommand],
]);

async function main(argv: string[]) {
  defaultRepo();
  const [command] = argv;
  const run = command === undefined ? undefined : COMMANDS.get(command);
  if (run) return run(argv);
  if (await runOp(argv)) return;
  process.stdout.write(USAGE);
  process.exitCode = command && command !== "help" && command !== "--help" ? 2 : 0;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`hoop: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof HoopError && err.detail) process.stderr.write(`${JSON.stringify({ detail: err.detail }, null, 2)}\n`);
  process.exitCode = 1;
});
