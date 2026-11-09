import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { type Agent, agentsPrint, agentsStep } from "./agents.js";
import { claudeDir, hoopHome, tryReadJson, writeAtomic, writeJson } from "./util.js";
import { isOn, PERMISSION_PROMPTS } from "./permissions.js";

/** The marketplace that lists hoop's plugin, and the plugin itself. */
const MARKETPLACE = "ankurjain-nitrr/hoop";
/** The marketplace's name, as `claude plugin marketplace update` takes it, and the plugin's. */
export const MARKETPLACE_NAME = "hoop";
export const PLUGIN = "hoop@hoop";

/** The `claude` commands that install the plugin: the MCP server, the plan hook and the pull request hook. */
const SETUP: string[][] = [
  ["plugin", "marketplace", "add", MARKETPLACE],
  ["plugin", "install", PLUGIN],
];

const line = (args: string[]) => `claude ${args.join(" ")}`;
const OLD = "If you installed the old hoop-plan plugin, remove it first: claude plugin uninstall hoop-plan@hoop";

/** Whether `claude` runs here. */
function hasClaude(): boolean {
  const r = spawnSync("claude", ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

/** The environment variable that gives newer models Claude Code's todo tools. */
const TODO_TOOLS = "CLAUDE_CODE_ENABLE_TODO_TOOLS";

/** Claude Code's user settings file: `settings.json` in its folder (`HOOP_CLAUDE_DIR`, `CLAUDE_CONFIG_DIR` or `~/.claude`). */
export const claudeSettings = () => join(claudeDir(), "settings.json");

/** What turning on the todo tools did: `on` when they already were, else `changed` with the backup it kept. */
export type TodoToolsResult = { state: "on" } | { state: "changed"; backup?: string } | { state: "refused"; why: string };

type Settings = Record<string, unknown>;

/** Reads a settings file: `{}` when it is missing, undefined when it isn't a JSON object. */
function readSettings(path: string): Settings | undefined {
  if (!existsSync(path)) return {};
  const v = tryReadJson(path);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Settings) : undefined;
}

/** Whether a settings file already turns the todo tools on. */
export function todoToolsOn(path = claudeSettings()): boolean {
  const env = readSettings(path)?.env;
  return Boolean(env && typeof env === "object" && (env as Settings)[TODO_TOOLS] === "1");
}

/**
 * Sets `env.CLAUDE_CODE_ENABLE_TODO_TOOLS` to "1" in a Claude Code settings file, keeping every other
 * key. It writes atomically and first copies the old file to `<path>.hoop-backup`. It changes nothing
 * when the setting is already on, or when the file isn't a JSON object or its `env` isn't one.
 */
export function enableTodoTools(path = claudeSettings()): TodoToolsResult {
  const settings = readSettings(path);
  if (!settings) return { state: "refused", why: `${path} isn't a JSON object, so hoop left it alone` };
  const env = settings.env ?? {};
  if (!env || typeof env !== "object" || Array.isArray(env)) return { state: "refused", why: `"env" in ${path} isn't an object, so hoop left it alone` };
  if ((env as Settings)[TODO_TOOLS] === "1") return { state: "on" };
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.hoop-backup`;
    copyFileSync(path, backup);
  } else mkdirSync(dirname(path), { recursive: true });
  writeJson(path, { ...settings, env: { ...env, [TODO_TOOLS]: "1" } });
  return { state: "changed", ...(backup ? { backup } : {}) };
}

/** Asks a yes-or-no question on the terminal; no answer is no. */
function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
    rl.on("close", () => resolve(false));
  });
}

const WHY = "Newer Claude models keep no written todo list unless the todo tools are on; hoop's Work view shows and steers that list.";
const CODEX = "Codex: hoop's Work view doesn't read Codex's plan yet, so there is nothing to turn on there.\n";

/**
 * The todo tools step: with `answer` yes or no it does that, on a terminal it asks once, and
 * otherwise it only says how. Returns the exit code.
 */
export async function todoToolsStep(opts: {
  answer?: "yes" | "no";
  settings?: string;
  tty?: boolean;
  ask?: (q: string) => Promise<boolean>;
  out: (s: string) => void;
}): Promise<number> {
  const path = opts.settings ?? claudeSettings();
  const how = `set "env": {"${TODO_TOOLS}": "1"} in ${path}`;
  if (todoToolsOn(path)) {
    opts.out(`hoop: Claude Code's todo tools are already on (${TODO_TOOLS}=1 in ${path}).\n${CODEX}`);
    return 0;
  }
  let yes: boolean;
  if (opts.answer) yes = opts.answer === "yes";
  else if (opts.tty ?? Boolean(process.stdin.isTTY && process.stderr.isTTY)) {
    yes = await (opts.ask ?? askYesNo)(`${WHY}\nTurn on Claude Code's todo tools? This will ${how}. [y/N] `);
  } else {
    opts.out(`${WHY} To turn them on, run hoop init --yes, or ${how}.\n${CODEX}`);
    return 0;
  }
  if (!yes) {
    opts.out(`hoop: left the todo tools off. To turn them on later, run hoop init --yes, or ${how}.\n${CODEX}`);
    return 0;
  }
  const r = enableTodoTools(path);
  if (r.state === "refused") {
    opts.out(`hoop: ${r.why}. To turn the todo tools on, ${how} yourself.\n`);
    return 1;
  }
  opts.out(
    r.state === "on"
      ? `hoop: Claude Code's todo tools are already on.\n${CODEX}`
      : `hoop: set ${TODO_TOOLS}=1 under "env" in ${path}${r.backup ? ` (the old file is at ${r.backup})` : ""}. New Claude Code sessions have the todo tools.\n${CODEX}`,
  );
  return 0;
}

/**
 * The question `hoop init` asks before answering Claude Code's permission prompts from hoop's pages
 * (rv_mw7wkyez20853f), with the limits the person chose to ship with (rv_mw84401j5bd069).
 */
export const PERMISSION_QUESTION =
  "Answer Claude Code's permission prompts from hoop's pages too? The terminal still asks; nothing is allowed without a click, but a Claude session with a browser tool, or another program you run, could click it too. [y/N] ";

/**
 * Turns on answering permission prompts from hoop's pages: adds `permission_prompts` to hoop's on
 * list, `<home>/on`, keeping every other line. The person's own settings file: hoop's processes only
 * read it.
 */
function turnOnPermissions(home: string) {
  const path = join(home, "on");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    mkdirSync(home, { recursive: true });
  }
  writeAtomic(path, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${PERMISSION_PROMPTS}\n`);
  return path;
}

/**
 * The permission prompts step: off until the person says yes. With `answer` it does that, on a
 * terminal it asks once, and otherwise it only says how. Returns the exit code.
 */
export async function permissionStep(opts: {
  answer?: "yes" | "no";
  home?: string;
  tty?: boolean;
  ask?: (q: string) => Promise<boolean>;
  out: (s: string) => void;
}): Promise<number> {
  const home = opts.home ?? hoopHome();
  const path = join(home, "on");
  const how = `run hoop init --permission-prompts, or add a line ${PERMISSION_PROMPTS} to ${path}`;
  if (isOn(home, PERMISSION_PROMPTS)) {
    opts.out(`hoop: Claude Code's permission prompts already show on hoop's pages too (${PERMISSION_PROMPTS} in ${path}).\n`);
    return 0;
  }
  let yes: boolean;
  if (opts.answer) yes = opts.answer === "yes";
  else if (opts.tty ?? Boolean(process.stdin.isTTY && process.stderr.isTTY)) yes = await (opts.ask ?? askYesNo)(PERMISSION_QUESTION);
  else {
    opts.out(`hoop: to answer Claude Code's permission prompts from hoop's pages too, ${how}.\n`);
    return 0;
  }
  if (!yes) {
    opts.out(`hoop: left permission prompts to the terminal. To answer them from hoop's pages too later, ${how}.\n`);
    return 0;
  }
  opts.out(
    `hoop: added ${PERMISSION_PROMPTS} to ${turnOnPermissions(home)}. Claude Code's permission prompts show on hoop's pages too; the terminal still asks.\n`,
  );
  return 0;
}

/**
 * The one-time setup: installs hoop's Claude Code plugin with `claude` when it is on PATH, or
 * prints the commands, then turns on the todo tools after asking (see `todoToolsStep`), then adds
 * hoop to the other agent tools found here after asking about each (see `agentsStep`; `agents` yes
 * or no answers for all), then asks whether to answer permission prompts from hoop's pages too (see
 * `permissionStep`; `permissions` answers), and ends by opening the sample review with `sample`, which gives its link.
 * With `print`, it only prints what to run and which agents it found. Returns the exit code; a
 * sample that can't open says why and leaves it as it is.
 */
export async function init(
  opts: {
    print?: boolean;
    todo?: "yes" | "no";
    agents?: "yes" | "no";
    permissions?: "yes" | "no";
    home?: string;
    agentList?: Agent[];
    settings?: string;
    tty?: boolean;
    ask?: (q: string) => Promise<boolean>;
    out?: (s: string) => void;
    sample?: () => Promise<string>;
  } = {},
): Promise<number> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const code = installPlugin(Boolean(opts.print), out);
  if (code) return code;
  if (opts.print) {
    out(`\n${WHY} To turn them on: hoop init --yes, or set "env": {"${TODO_TOOLS}": "1"} in ${opts.settings ?? claudeSettings()}.\n`);
    out(agentsPrint(opts.agentList));
    out(`To answer Claude Code's permission prompts from hoop's pages too: hoop init --permission-prompts.\n`);
    return 0;
  }
  const { todo, agents, permissions, home, agentList, print: _print, sample, ...rest } = opts;
  const done = await todoToolsStep({ ...rest, ...(todo ? { answer: todo } : {}), out });
  const added = await agentsStep({
    ...(agents ? { answer: agents } : {}),
    ...(opts.tty === undefined ? {} : { tty: opts.tty }),
    ...(agentList ? { agents: agentList } : {}),
    ask: opts.ask ?? askYesNo,
    out,
  });
  const prompts = await permissionStep({
    ...(permissions ? { answer: permissions } : {}),
    ...(home ? { home } : {}),
    ...(opts.tty === undefined ? {} : { tty: opts.tty }),
    ...(opts.ask ? { ask: opts.ask } : {}),
    out,
  });
  if (sample) await sampleStep(sample, out);
  return done || added || prompts;
}

/**
 * What `sample` throws when the review pages running now are an older hoop's, which can't open the
 * sample and whose Home doesn't offer it either.
 */
export class SampleNotYet extends Error {}

/** Opens the sample review to try the page on, and says where it is, or why it didn't open. */
async function sampleStep(sample: () => Promise<string>, out: (s: string) => void) {
  try {
    out(`hoop: a sample review is open to try the review page on: ${await sample()}\n`);
  } catch (err) {
    if (err instanceof SampleNotYet)
      out("hoop: the sample review didn't open: the review pages running now are an older hoop's. Run hoop init again in a moment.\n");
    else out(`hoop: the sample review didn't open (${err instanceof Error ? err.message : String(err)}). Home offers it while you have no reviews.\n`);
  }
}

function installPlugin(print: boolean, out: (s: string) => void): number {
  if (print || !hasClaude()) {
    out(`${print ? "" : "claude isn't on PATH. "}Run these to install hoop in Claude Code:\n\n${SETUP.map((a) => `  ${line(a)}\n`).join("")}\n${OLD}\n`);
    return 0;
  }
  for (const args of SETUP) {
    out(`hoop: ${line(args)}\n`);
    const r = spawnSync("claude", args, { stdio: "inherit" });
    if (r.error || r.status !== 0) {
      out(`hoop: that failed${r.status === null ? "" : ` (exit ${r.status})`}. Run these yourself:\n\n${SETUP.map((a) => `  ${line(a)}\n`).join("")}`);
      return 1;
    }
  }
  out(`hoop: installed. Start a new Claude Code session to use it.\n${OLD}\n`);
  return 0;
}
