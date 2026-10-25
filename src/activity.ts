import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { relative } from "node:path";

// What a Claude Code session or subagent did lately, from the end of its transcript: its last sign of
// life and its recent tool calls, in plain words. The Work page shows it; hoop only reads.

/** One tool call: when it started, the tool, and what it did in plain words. */
export type Step = { at: string; tool: string; what: string };

/**
 * A transcript's recent activity: `last` is the time of its latest entry, `steps` its tool calls
 * oldest first, and `open` the latest call that has no result yet, which is still running.
 */
export type Activity = { last?: string; steps: Step[]; open?: Step };

/** The reference a Work message ends with, so the transcript shows when the agent read it. */
const READ_REF = /\(hoop-ref (st_[a-z0-9]+)\)/g;

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
  if (hoop) {
    if (hoop === "wait") return "waiting on a review in hoop";
    if (hoop === "ask") return "asking you a question in hoop";
    if (hoop === "build_wait") return "waiting on you in a hoop build";
    if (hoop.startsWith("submit")) return "submitting a review to hoop";
    if (hoop === "feedback") return "reading feedback in hoop";
    return `hoop: ${hoop.replace(/_/g, " ")}`;
  }
  switch (tool) {
    case "Bash": {
      const cmd = str(input.command);
      if (!cmd) return "running a command";
      const first = oneLine(cmd.split("\n")[0]!);
      return TESTS.test(cmd) ? `running tests: ${first}` : `running: ${first}`;
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `editing ${path(input.file_path ?? input.notebook_path)}`.trim();
    case "Write":
      return `writing ${path(input.file_path)}`.trim();
    case "Read":
      return `reading ${path(input.file_path)}`.trim();
    case "Grep":
      return str(input.pattern) ? `searching for ${oneLine(String(input.pattern))}` : "searching";
    case "Glob":
      return str(input.pattern) ? `finding files: ${oneLine(String(input.pattern))}` : "finding files";
    case "WebFetch":
      return str(input.url) ? `reading ${oneLine(String(input.url))}` : "reading a web page";
    case "WebSearch":
      return str(input.query) ? `searching the web: ${oneLine(String(input.query))}` : "searching the web";
    case "Agent":
    case "Task": {
      if (input.taskId) return "updating its todos";
      const d = str(input.description) ? oneLine(String(input.description)) : "";
      return `started a subagent${d ? `: ${d}` : ""}`;
    }
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
    case "TodoWrite":
      return "updating its todos";
    case "AskUserQuestion":
      return "asking you a question";
    case "ToolSearch":
      return "loading tools";
    default: {
      const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
      return mcp ? `${mcp[1]}: ${mcp[2]!.replace(/_/g, " ")}` : tool;
    }
  }
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

/** A transcript's activity from its lines, oldest first. Paths in steps show relative to `cwd`. */
export function activityOf(lines: string[], cwd?: string): Activity {
  const steps: (Step & { id?: string })[] = [];
  const done = new Set<string>();
  let last: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let v: Obj | undefined;
    try {
      v = obj(JSON.parse(line));
    } catch {
      continue;
    }
    if (!v) continue;
    const at = str(v.timestamp);
    if (at && !Number.isNaN(Date.parse(at)) && (!last || at > last)) last = at;
    const content = obj(v.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = obj(part);
      if (v.type === "assistant" && p?.type === "tool_use" && str(p.name) && at)
        steps.push({ at, tool: String(p.name), what: stepWords(String(p.name), obj(p.input), cwd), ...(str(p.id) ? { id: String(p.id) } : {}) });
      if (v.type === "user" && p?.type === "tool_result" && str(p.tool_use_id)) done.add(String(p.tool_use_id));
    }
  }
  const running = [...steps].reverse().find((s) => s.id && !done.has(s.id));
  const plain = ({ id: _id, ...s }: Step & { id?: string }): Step => s;
  return { ...(last ? { last } : {}), steps: steps.map(plain), ...(running ? { open: plain(running) } : {}) };
}

/** How far past a message's offset a scan for its reference reads, at most. */
const READS_MAX = 64 * 1024 * 1024;

/** Each transcript's scan for Work message references: from `from`, up to `pos`, with what it found. */
const scans = new Map<string, { from: number; pos: number; partial: string; reads: Record<string, string> }>();

/**
 * When each of hoop's Work messages reached the agent, by its reference, from the transcript's bytes
 * after `from` (its size when the first unread message went out). A scan reads each byte once: the
 * next call goes on from where the last stopped. Undefined when the file can't be read whole from
 * there, so a missing reference can't be told from a missed one.
 */
export function transcriptReads(path: string, from: number): Record<string, string> | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    let scan = scans.get(path);
    if (!scan || scan.from > from || scan.pos > size) scan = { from, pos: from, partial: "", reads: {} };
    if (size - scan.pos > READS_MAX) return undefined;
    const buf = Buffer.alloc(size - scan.pos);
    const n = buf.length ? readSync(fd, buf, 0, buf.length, scan.pos) : 0;
    const lines = (scan.partial + buf.subarray(0, n).toString("utf8")).split("\n");
    scan.partial = lines.pop() ?? "";
    scan.pos += n;
    for (const line of lines) {
      if (!line.includes("hoop-ref")) continue;
      let v: Obj | undefined;
      try {
        v = obj(JSON.parse(line));
      } catch {
        continue;
      }
      const at = v && str(v.timestamp);
      if (at) for (const [, ref] of readText(v!).matchAll(READ_REF)) scan.reads[ref!] ??= at;
    }
    if (scans.size > 200) scans.clear();
    scans.set(path, scan);
    return scan.reads;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
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
