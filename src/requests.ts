import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// What the person asked a session for, from its transcript: their prompts, the hoop reviews that woke
// it, and the Work-page changes hoop sent it. A todo the agent creates takes the request its turn
// answers as its source; the Work page lists each request with the todos it became (#209).

/**
 * One request: a person's `prompt` (in their own words), a hoop `review` that woke the session, or a
 * Work-page `change` hoop sent it. `id` is the transcript entry's.
 */
export type Request = { id: string; kind: "prompt" | "review" | "change"; text: string; at: string; review?: string; ref?: string };

/** Where a todo came from: a request, or the agent, when no request started the turn it was created in. */
export type Source = (Pick<Request, "kind" | "at" | "review" | "ref"> & { request: string; text: string }) | { kind: "agent"; at: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);

/** How much of a request's text is kept, and how many requests and todo calls a scan remembers. */
const TEXT_MAX = 2000,
  REQUESTS_MAX = 200,
  CALLS_MAX = 500,
  /** How far back from the end a first scan of a long transcript starts. */
  SCAN_MAX = 64 * 1024 * 1024;

const REVIEW = /\bhoop_feedback (rv_[a-z0-9]+)/;
const REF = /\(hoop-ref (st_[a-z0-9]+)\)/;
/** The tools that create todos: a todo they create takes the request of the turn they ran in. */
const CREATES = new Set(["TaskCreate", "TodoWrite"]);

/** A user entry's text: a string, or its text parts; none for a tool result. */
function userText(v: Obj): string | undefined {
  const content = obj(v.message)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((p) => obj(p)?.type === "tool_result")) return undefined;
  const text = content.map((p) => (obj(p)?.type === "text" ? String(obj(p)!.text ?? "") : "")).join("\n");
  return text || undefined;
}

/**
 * What an entry that puts text in front of the agent is: a request, `"agent"` for one that starts a
 * turn nobody asked for (a notification, another agent's message), or undefined for one that changes
 * nothing (a tool result, a slash command's output, an interruption, a notification mid-turn).
 */
function classify(v: Obj): Omit<Request, "id" | "at"> | "agent" | undefined {
  let text: string | undefined;
  let origin: string | undefined;
  let midTurn = false;
  if (v.type === "attachment") {
    const a = obj(v.attachment);
    if (a?.type !== "queued_command" || typeof a.prompt !== "string") return undefined;
    text = a.prompt;
    origin = typeof obj(a.origin)?.kind === "string" ? String(obj(a.origin)!.kind) : undefined;
    midTurn = true;
  } else if (v.type === "user" && !v.isMeta) {
    text = userText(v);
    origin = typeof obj(v.origin)?.kind === "string" ? String(obj(v.origin)!.kind) : undefined;
  }
  if (!text?.trim()) return undefined;
  const review = text.match(REVIEW)?.[1];
  if (review) return { kind: "review", text: (text.split("\n").find((l) => REVIEW.test(l)) ?? text).slice(0, TEXT_MAX), review };
  const ref = text.match(REF)?.[1];
  if (ref) return { kind: "change", text: "Changes from the Work page", ref };
  // Older transcripts mark no origin: a person's prompt is then plain text, not a tag or a note.
  const person = origin === "human" || (origin === undefined && !/^\s*[<[]/.test(text));
  if (person) return { kind: "prompt", text: text.trim().slice(0, TEXT_MAX) };
  return midTurn ? undefined : "agent";
}

type Scan = { pos: number; partial: string; requests: Request[]; current: string | null; calls: Map<string, string | null> };
const scans = new Map<string, Scan>();

/**
 * A transcript's requests, oldest first, and the request each todo-creating tool call answered. The
 * scan reads each byte once: the next call goes on from where the last stopped. A first scan of a
 * very long transcript starts 64 MB from its end. Undefined when the file can't be read.
 */
export function transcriptRequests(path: string): Scan | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    let scan = scans.get(path);
    if (!scan || scan.pos > size) {
      const start = Math.max(0, size - SCAN_MAX);
      scan = { pos: start, partial: start > 0 ? "\u0000" : "", requests: [], current: null, calls: new Map() };
    }
    const buf = Buffer.alloc(size - scan.pos);
    const n = buf.length ? readSync(fd, buf, 0, buf.length, scan.pos) : 0;
    const lines = (scan.partial + buf.subarray(0, n).toString("utf8")).split("\n");
    scan.partial = lines.pop() ?? "";
    scan.pos += n;
    // A scan that starts mid-file starts mid-line.
    if (lines[0]?.startsWith("\u0000")) lines.shift();
    for (const line of lines) read(scan, line);
    if (scans.size > 200) scans.clear();
    scans.set(path, scan);
    return scan;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function read(scan: Scan, line: string) {
  if (!line.trim()) return;
  let v: Obj | undefined;
  try {
    v = obj(JSON.parse(line));
  } catch {
    return;
  }
  const at = typeof v?.timestamp === "string" ? v.timestamp : undefined;
  if (!v || !at) return;
  if (v.type === "assistant") {
    const content = obj(v.message)?.content;
    for (const p of Array.isArray(content) ? content : []) {
      const use = obj(p);
      if (use?.type === "tool_use" && typeof use.id === "string" && CREATES.has(String(use.name))) {
        scan.calls.set(use.id, scan.current);
        if (scan.calls.size > CALLS_MAX) scan.calls.delete(scan.calls.keys().next().value!);
      }
    }
    return;
  }
  const what = classify(v);
  if (what === "agent") scan.current = null;
  else if (what) {
    const id = typeof v.uuid === "string" ? v.uuid : `${at}:${scan.requests.length}`;
    scan.requests.push({ id, at, ...what });
    if (scan.requests.length > REQUESTS_MAX) scan.requests.shift();
    scan.current = id;
  }
}

/**
 * The source of a todo a tool call created: the request its turn answered, by the call's ID when the
 * transcript holds it, else the latest; `agent` when no request started that turn. Undefined when the
 * transcript can't be read, so the source stays unknown.
 */
export function sourceOf(path: string | undefined, call: string | undefined, now: string): Source | undefined {
  const scan = path ? transcriptRequests(path) : undefined;
  if (!scan) return undefined;
  const id = call && scan.calls.has(call) ? scan.calls.get(call)! : scan.current;
  const r = id ? scan.requests.find((x) => x.id === id) : undefined;
  if (!r) return { kind: "agent", at: now };
  const { id: request, ...rest } = r;
  return { ...rest, request, text: rest.text.replace(/\s+/g, " ").slice(0, 200) };
}
