import { statSync } from "node:fs";
import { follow } from "./transcript.js";

// What the person asked a session for, from its transcript: their prompts, the hoop reviews that woke
// it, and the Work-page changes hoop sent it. Claude Code gives every turn a prompt ID, on the user
// entry that starts it and in each hook input of that turn; a todo takes the request of the turn
// that created it (#209).

/**
 * One request: a person's `prompt` (in their own words; `mid` for one they typed while the agent
 * worked, which joined its turn), a hoop `review` that woke the session, or a Work-page `change`
 * hoop sent it. `id` is the transcript entry's. `changed` says its turn edited files or ran
 * commands, and `created` that it created todos.
 */
export type Request = {
  id: string;
  kind: "prompt" | "review" | "change";
  text: string;
  at: string;
  review?: string;
  ref?: string;
  mid?: true;
  changed?: true;
  created?: true;
};

/** Where a todo came from: a request, or the agent, when no request started the turn it was created in. */
export type Source = (Pick<Request, "kind" | "at" | "review" | "ref"> & { request: string; text: string }) | { kind: "agent"; at: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);

/** How much of a request's text the view keeps, and how many requests and turns a scan remembers. */
const TEXT_MAX = 2000,
  REQUESTS_MAX = 200,
  TURNS_MAX = 2000,
  /** How far back from the end a first scan of a long transcript starts. */
  SCAN_MAX = 64 * 1024 * 1024;

const REVIEW = /\bhoop_feedback (rv_[a-z0-9]+)/;
const REF = /\(hoop-ref (st_[a-z0-9]+)\)/;
/** The person's changes, as hoop's Work messages open; other messages with a reference are hoop's own. */
const WORK_MESSAGE = /via hoop's Work view/;
const COMMAND = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;
const ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
/** Tools whose calls change something: a turn with one and no todo may have needed one. */
const CHANGES = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]);
const CREATES = new Set(["TaskCreate", "TodoWrite"]);

/** An entry's text: a string, or its text parts; none for a tool result. */
function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((p) => obj(p)?.type === "tool_result")) return undefined;
  const text = content.map((p) => (obj(p)?.type === "text" ? String(obj(p)!.text ?? "") : "")).join("\n");
  return text || undefined;
}

/** The first line of a request's text, at most 200 characters: what hoop stores on disk. */
export const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0]!.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

/**
 * What an entry's text asks: a review wake, a Work message, a slash command or a person's prompt.
 * `"agent"` for text that isn't the person's (a notification, another agent's message, hoop's own
 * note), undefined for text that asks nothing (a meta note, an interruption).
 */
function classify(text: string | undefined, origin: string | undefined, meta: boolean): Omit<Request, "id" | "at"> | "agent" | undefined {
  if (!text?.trim()) return undefined;
  const review = text.match(REVIEW)?.[1];
  if (review)
    return {
      kind: "review",
      text: text
        .split("\n")
        .find((l) => REVIEW.test(l))!
        .slice(0, TEXT_MAX),
      review,
    };
  const ref = text.match(REF)?.[1];
  if (ref) return WORK_MESSAGE.test(text) ? { kind: "change", text: "Changes from the Work page", ref } : "agent";
  if (meta) return undefined;
  const command = text.match(COMMAND)?.[1];
  if (command) return { kind: "prompt", text: `/${command} ${text.match(ARGS)?.[1]?.trim() ?? ""}`.trim().slice(0, TEXT_MAX) };
  if (origin === "human" || (origin === undefined && !/^\s*[<[]/.test(text))) return { kind: "prompt", text: text.trim().slice(0, TEXT_MAX) };
  return origin === undefined ? undefined : "agent";
}

/**
 * A transcript's requests, oldest first; `turns` maps each prompt ID to its request, or null for a
 * turn nobody asked for; `current` is the latest turn's.
 */
export type Requests = { requests: Request[]; turns: Map<string, string | null>; prompt?: string; current: string | null };

function readLine(s: Requests, line: string) {
  let v: Obj | undefined;
  try {
    v = obj(JSON.parse(line));
  } catch {
    return;
  }
  const at = typeof v?.timestamp === "string" ? v.timestamp : undefined;
  if (!v || !at) return;
  // A compaction summary, and what only the transcript view shows, change no turn.
  if (v.isCompactSummary || v.isVisibleInTranscriptOnly) return;
  const add = (what: Omit<Request, "id" | "at">) => {
    const r: Request = { id: typeof v!.uuid === "string" ? v!.uuid : `${at}:${s.requests.length}`, at, ...what };
    s.requests.push(r);
    if (s.requests.length > REQUESTS_MAX) s.requests.shift();
    return r;
  };
  if (v.type === "assistant") {
    const r = s.current ? s.requests.find((x) => x.id === s.current) : undefined;
    const content = obj(v.message)?.content;
    for (const p of Array.isArray(content) ? content : []) {
      const name = obj(p)?.type === "tool_use" ? String(obj(p)!.name) : "";
      if (r && CHANGES.has(name)) r.changed = true;
      if (r && CREATES.has(name)) r.created = true;
    }
    return;
  }
  if (v.type === "attachment") {
    // A message taken mid-turn joins the turn: listed, but the turn's todos stay the turn's.
    const a = obj(v.attachment);
    if (a?.type !== "queued_command" || typeof a.prompt !== "string") return;
    const what = classify(a.prompt, typeof obj(a.origin)?.kind === "string" ? String(obj(a.origin)!.kind) : undefined, false);
    if (what && what !== "agent") add({ ...what, mid: true });
    return;
  }
  if (v.type !== "user") return;
  const text = textOf(obj(v.message)?.content);
  const what = classify(text, typeof obj(v.origin)?.kind === "string" ? String(obj(v.origin)!.kind) : undefined, Boolean(v.isMeta));
  const prompt = typeof v.promptId === "string" ? v.promptId : undefined;
  if (prompt) {
    // A turn starts at the first entry with its prompt ID; one nobody asked for may still turn out
    // to be the person's (a slash command after its caveat note).
    const known = s.turns.get(prompt);
    if (known === undefined || (known === null && what && what !== "agent")) {
      const r = what && what !== "agent" ? add(what).id : null;
      s.turns.set(prompt, r);
      if (s.turns.size > TURNS_MAX) s.turns.delete(s.turns.keys().next().value!);
    }
    s.prompt = prompt;
    s.current = s.turns.get(prompt) ?? null;
    return;
  }
  // Older transcripts have no prompt IDs: each request, or each turn nobody asked for, starts one.
  if (what === "agent") s.current = null;
  else if (what) s.current = add(what).id;
}

/**
 * A transcript's requests, from the shared forward reader: each byte is read once. A first scan of a
 * very long transcript starts 64 MB from its end. Undefined when the file can't be read.
 */
export function transcriptRequests(path: string): Requests | undefined {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return undefined;
  }
  return follow(path, "requests", Math.max(0, size - SCAN_MAX), () => ({ requests: [], turns: new Map(), current: null }), readLine, {
    midLine: true,
  });
}

/**
 * The source of a todo created in the turn with `prompt` (the hook's `prompt_id`; a subagent's turn
 * has its session's): that turn's request, else `agent`. Without a prompt ID, the latest turn's.
 * Undefined when the transcript can't be read, or doesn't hold that turn, so the source stays unknown.
 */
export function sourceOf(path: string | undefined, prompt: string | undefined, now: string): Source | undefined {
  const scan = path ? transcriptRequests(path) : undefined;
  if (!scan) return undefined;
  if (prompt && !scan.turns.has(prompt)) return undefined;
  const id = prompt ? scan.turns.get(prompt)! : scan.current;
  const r = id ? scan.requests.find((x) => x.id === id) : undefined;
  if (!r) return id ? undefined : { kind: "agent", at: now };
  return { kind: r.kind, at: r.at, ...(r.review ? { review: r.review } : {}), ...(r.ref ? { ref: r.ref } : {}), request: r.id, text: firstLine(r.text) };
}
