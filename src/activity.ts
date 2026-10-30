import { closeSync, openSync, readSync, statSync } from "node:fs";
import { relative } from "node:path";
import { follow } from "./transcript.js";
import { idPattern } from "./ids.js";

// What a Claude Code session or subagent did lately, from the end of its transcript: its last sign of
// life and its recent tool calls, in plain words. The Work page shows it; hoop only reads.

/** One tool call: when it started, the tool, and what it did in plain words. */
export type Step = { at: string; tool: string; what: string };

/** The call still running: a step with the tool's input, to tell it from another call of its tool. */
export type OpenStep = Step & { input: Record<string, unknown> };

/**
 * A transcript's recent activity: `last` is the time of its latest entry, `said` of its latest
 * assistant entry, `interrupted` of the latest turn the person interrupted or an API error ended
 * (neither runs the Stop hook), `steps` its tool calls oldest first, `failed` the places in `steps`
 * of calls whose result is an error, and `open` the latest call that has no result yet, which is
 * still running.
 */
export type Activity = { last?: string; said?: string; interrupted?: string; steps: Step[]; failed?: number[]; open?: OpenStep };

/** The reference a Work message ends with, so the transcript shows when the agent read it. */
const READ_REF = new RegExp(`\\(hoop-ref (${idPattern("st")})\\)`, "g");

/**
 * The text a transcript entry put in front of the agent: a user message (a string, or text parts),
 * or a message queued while it worked, which Claude Code attaches to its next step. A queue entry
 * (`queue-operation`) only waits, so it reads as nothing.
 */
function readText(v: Obj): string {
  if (v.type === "attachment") {
    const a = obj(v.attachment);
    return a?.type === "queued_command" && typeof a.prompt === "string" ? a.prompt : "";
  }
  if (v.type !== "user") return "";
  const content = obj(v.message)?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((p) => (obj(p)?.type === "text" ? String(obj(p)!.text ?? "") : "")).join("\n") : "";
}

/** How much of a transcript's end is read: enough for minutes of steps, however long the file. */
const TAIL_BYTES = 256 * 1024;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const oneLine = (text: string, max = 100) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const TESTS = /\b(test|tests|vitest|jest|pytest|mocha|rspec|phpunit)\b/;

/** A hoop tool, under any MCP server name hoop is installed as: `mcp__hoop__hoop_wait`, `mcp__plugin_hoop_hoop__hoop_wait`. */
const HOOP_TOOL = /^mcp__.*hoop.*__hoop_([a-z_]+)$/;

/** The hoop tools that wait on the person, under the server names hoop is installed as. */
const HOOP_WAIT = /^mcp__(?:hoop|plugin_hoop_hoop)__hoop_(?:wait|ask|build_wait)$/;

/**
 * Whether a tool call, while it runs, waits on the person: `review` for a hoop wait or ask, which the
 * person answers on a hoop page, `question` for Claude Code's AskUserQuestion. A permission prompt
 * leaves no trace in the transcript until it is answered; the Work view learns of it from the
 * PermissionRequest hook instead (`prompted` in `src/work.ts`).
 */
export function waitsOn(tool: string): "review" | "question" | undefined {
  if (tool === "AskUserQuestion") return "question";
  return HOOP_WAIT.test(tool) ? "review" : undefined;
}

/**
 * A tool call in plain words: "running tests: npm test", "editing web/work.js", "waiting on a review
 * in hoop". Paths show relative to `cwd` when inside it.
 */
export function stepWords(tool: string, input: Obj = {}, cwd?: string): string {
  const path = (p: unknown) => {
    const s = str(p);
    if (!s) return "";
    const rel = cwd ? relative(cwd, s) : s;
    return oneLine(rel && !rel.startsWith("..") ? rel : s);
  };
  const hoop = tool.match(HOOP_TOOL)?.[1];
  if (hoop) return hoopWords(hoop);
  const words = STEP_WORDS.get(tool);
  if (words) return words(input, path);
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
  return mcp ? `${mcp[1]}: ${mcp[2]!.replace(/_/g, " ")}` : tool;
}

/** A hoop tool call in plain words, by the tool's name after `hoop_`. */
function hoopWords(hoop: string): string {
  if (hoop === "wait") return "waiting on a review in hoop";
  if (hoop === "ask") return "asking you a question in hoop";
  if (hoop === "build_wait") return "waiting on you in a hoop build";
  if (hoop.startsWith("submit")) return "submitting a review to hoop";
  if (hoop === "feedback") return "reading feedback in hoop";
  return `hoop: ${hoop.replace(/_/g, " ")}`;
}

/** A field of a tool call's input on one line, after `label`; `none` when the field is empty. */
const quoted = (field: string, label: string, none: string) => (input: Obj) => (str(input[field]) ? `${label}${oneLine(String(input[field]))}` : none);
const todos = () => "updating its todos";
const editing = (input: Obj, path: (p: unknown) => string) => `editing ${path(input.file_path ?? input.notebook_path)}`.trim();

/** Claude Code's own tools in plain words, from their input; `path` shows a file path relative to the session's folder. */
const STEP_WORDS = new Map<string, (input: Obj, path: (p: unknown) => string) => string>([
  [
    "Bash",
    (input) => {
      const cmd = str(input.command);
      if (!cmd) return "running a command";
      const first = oneLine(cmd.split("\n")[0]!);
      return TESTS.test(cmd) ? `running tests: ${first}` : `running: ${first}`;
    },
  ],
  ["Edit", editing],
  ["MultiEdit", editing],
  ["NotebookEdit", editing],
  ["Write", (input, path) => `writing ${path(input.file_path)}`.trim()],
  ["Read", (input, path) => `reading ${path(input.file_path)}`.trim()],
  ["Grep", quoted("pattern", "searching for ", "searching")],
  ["Glob", quoted("pattern", "finding files: ", "finding files")],
  ["WebFetch", quoted("url", "reading ", "reading a web page")],
  ["WebSearch", quoted("query", "searching the web: ", "searching the web")],
  ["Agent", subagentWords],
  ["Task", subagentWords],
  ["TaskCreate", todos],
  ["TaskUpdate", todos],
  ["TaskList", todos],
  ["TaskGet", todos],
  ["TodoWrite", todos],
  ["AskUserQuestion", () => "asking you a question"],
  ["ToolSearch", () => "loading tools"],
]);

/** The Agent tool starts a subagent; Claude Code's older Task tool with a task ID updates a todo. */
function subagentWords(input: Obj): string {
  if (input.taskId) return "updating its todos";
  const d = str(input.description) ? oneLine(String(input.description)) : "";
  return `started a subagent${d ? `: ${d}` : ""}`;
}

/** How far back a read goes to find one whole line, when the end of a file is a single long line. */
const TAIL_MAX = 8 * 1024 * 1024;

/**
 * The complete lines at the end of a file: its last `bytes`, or further back, up to TAIL_MAX, until
 * the read holds at least one whole line.
 */
export function tailLines(path: string, bytes: number): string[] {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    for (let want = bytes; ; want *= 2) {
      const start = Math.max(0, size - Math.min(want, TAIL_MAX));
      const buf = Buffer.alloc(size - start);
      const n = readSync(fd, buf, 0, buf.length, start);
      const lines = buf.subarray(0, n).toString("utf8").split("\n");
      // A read that starts mid-file starts mid-line.
      const whole = start > 0 ? lines.slice(1) : lines;
      if (start === 0 || whole.some((l) => l.trim()) || want >= TAIL_MAX) return whole;
    }
  } finally {
    closeSync(fd);
  }
}

/** A transcript line's record, or undefined for a blank or unreadable line. */
export function record(line: string): Obj | undefined {
  if (!line.trim()) return undefined;
  try {
    return obj(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** The later of two timestamps, either of which may be missing. */
const later = (cur: string | undefined, at: string | undefined) => (at && (!cur || at > cur) ? at : cur);

type ReadStep = Step & { id?: string; input?: Obj };

/** A transcript's activity as `activityOf` reads it, line by line. */
type Reading = { steps: ReadStep[]; done: Set<string>; errors: Set<string>; last?: string; said?: string; interrupted?: string };

/** One record's times, the tool calls an assistant message makes and the results a user message returns. */
function readRecord(r: Reading, v: Obj, cwd: string | undefined) {
  const at = str(v.timestamp);
  const valid = at && !Number.isNaN(Date.parse(at)) ? at : undefined;
  r.last = later(r.last, valid);
  if (v.type === "assistant") r.said = later(r.said, valid);
  const stopless = (v.type === "assistant" && v.isApiErrorMessage === true) || readText(v).startsWith("[Request interrupted by user");
  if (stopless) r.interrupted = later(r.interrupted, at);
  const content = obj(v.message)?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) readPart(r, v.type, obj(part), at, cwd);
}

/** A part of a message's content: a tool call an assistant message makes, or a result a user message returns. */
function readPart(r: Reading, type: unknown, p: Obj | undefined, at: string | undefined, cwd: string | undefined) {
  if (type === "assistant" && p?.type === "tool_use" && str(p.name) && at)
    r.steps.push({
      at,
      tool: String(p.name),
      what: stepWords(String(p.name), obj(p.input), cwd),
      input: obj(p.input) ?? {},
      ...(str(p.id) ? { id: String(p.id) } : {}),
    });
  if (type === "user" && p?.type === "tool_result" && str(p.tool_use_id)) {
    r.done.add(String(p.tool_use_id));
    if (p.is_error === true) r.errors.add(String(p.tool_use_id));
  }
}

/** A transcript's activity from its lines, oldest first. Paths in steps show relative to `cwd`. */
export function activityOf(lines: string[], cwd?: string): Activity {
  const r: Reading = { steps: [], done: new Set(), errors: new Set() };
  for (const line of lines) {
    const v = record(line);
    if (v) readRecord(r, v, cwd);
  }
  const { steps, done, errors, last, said, interrupted } = r;
  const running = [...steps].reverse().find((s) => s.id && !done.has(s.id));
  const plain = ({ id: _id, input: _input, ...s }: ReadStep): Step => s;
  const failed = steps.flatMap((s, n) => (s.id && errors.has(s.id) ? [n] : []));
  return {
    ...(last ? { last } : {}),
    ...(said ? { said } : {}),
    ...(interrupted ? { interrupted } : {}),
    ...(failed.length ? { failed } : {}),
    steps: steps.map(plain),
    ...(running ? { open: { ...plain(running), input: running.input ?? {} } } : {}),
  };
}

/** How far past a message's offset a scan for its reference reads, at most. */
const READS_MAX = 64 * 1024 * 1024;

/**
 * When each of hoop's Work messages reached the agent, by its reference, from the transcript's bytes
 * after `from` (its size when the first unread message went out). The shared forward reader reads
 * each byte once: the next call goes on from where the last stopped. Undefined when the file can't
 * be read whole from there, so a missing reference can't be told from a missed one.
 */
export function transcriptReads(path: string, from: number): Record<string, string> | undefined {
  return follow(
    path,
    "reads",
    from,
    (): Record<string, string> => ({}),
    (reads, line) => {
      if (!line.includes("hoop-ref")) return;
      let v: Obj | undefined;
      try {
        v = obj(JSON.parse(line));
      } catch {
        return;
      }
      const at = v && str(v.timestamp);
      if (at) for (const [, ref] of readText(v!).matchAll(READ_REF)) reads[ref!] ??= at;
    },
    { max: READS_MAX },
  );
}

const cache = new Map<string, { key: string; activity: Activity }>();

/**
 * A transcript's recent activity, from its last 256 KB, read again only when the file changed. Its
 * last sign of life is its newest entry's time, else the file's modification time. Undefined when
 * the file can't be read.
 */
export function transcriptActivity(path: string, cwd?: string): Activity | undefined {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return undefined;
  }
  const key = `${st.mtimeMs}:${st.size}:${cwd ?? ""}`;
  const cached = cache.get(path);
  if (cached?.key === key) return cached.activity;
  let activity: Activity;
  try {
    activity = activityOf(tailLines(path, TAIL_BYTES), cwd);
  } catch {
    return undefined;
  }
  const mtime = st.mtime.toISOString();
  if (!activity.last || mtime > activity.last) activity.last = mtime;
  if (cache.size > 200) cache.clear();
  cache.set(path, { key, activity });
  return activity;
}

/** How far back the Work page's "Last 5 minutes" looks, and how many steps it lists. */
export const RECENT_MS = 5 * 60_000;
export const RECENT_MAX = 10;

/** The steps of the last five minutes before `now`, newest first, at most ten. */
export function recentSteps(a: Activity | undefined, now: number): Step[] {
  if (!a) return [];
  return a.steps
    .filter((s) => now - Date.parse(s.at) <= RECENT_MS)
    .reverse()
    .slice(0, RECENT_MAX);
}
