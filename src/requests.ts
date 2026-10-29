import { statSync } from "node:fs";
import { follow } from "./transcript.js";
import { REVIEW_ID_PATTERN } from "./ids.js";

// What the person asked a session for, from its transcript: their prompts, the hoop reviews that woke
// it, and the Work-page changes hoop sent it. Claude Code gives every turn a prompt ID, on the user
// entry that starts it and in each hook input of that turn; a todo takes the request of the turn
// that created it (#209).

/**
 * One request: a person's `prompt` (in their own words; `mid` for one that arrived while the agent
 * worked), a hoop `review` that woke the session, a Work-page `change` hoop sent it, or an `action`
 * item the person closed. `id` is the transcript entry's. `changed` says its turn edited files, and
 * `created` that it created or updated todos.
 */
export type Request = {
  id: string;
  kind: "prompt" | "review" | "change" | "action";
  text: string;
  at: string;
  review?: string;
  ref?: string;
  action?: string;
  mid?: true;
  changed?: true;
  created?: true;
};

/** Where a todo came from: a request, or the agent, when no request started the turn it was created in. */
export type Source = (Pick<Request, "kind" | "at" | "review" | "ref" | "action"> & { request: string; text: string }) | { kind: "agent"; at: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);

/** How much of a request's text the view keeps, and how many requests and turns a scan remembers. */
const TEXT_MAX = 2000,
  REQUESTS_MAX = 200,
  TURNS_MAX = 2000,
  /** How far back from the end a first scan of a long transcript starts. */
  SCAN_MAX = 64 * 1024 * 1024;

/** What a message over the session socket starts with, which hoop's own messages come after. */
const PEER = /^Another Claude session sent a message:\n/;
/** hoop's wakes (`wakeMessage`, `answerMessage`), from their first words to the review they name. */
const WAKE = new RegExp(
  `^(?:[^\\n]+ reviewed "[^\\n]*" in hoop: |Answered in hoop: |Corrected in hoop: )[\\s\\S]*?\\bRead it with hoop_feedback (${REVIEW_ID_PATTERN})`,
);
/** The reference on the last line of a Work message, and of a closed action item's message. */
const REF = /\n\(hoop-ref (st_[a-z0-9]+)\)\s*$/;
/** How a Work message goes on after "From <person>": requests know a person's changes by it. */
export const WORK_VIA = "via hoop's Work view: changes to your own todo list and agents.";
const ACTION = /^(?:Done|Won't do): [\s\S]*\n\(hoop-action (ac_[a-z0-9]+)\)\s*$/;
const COMMAND = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;
const ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
/** Tools that edit files: a turn with one and no todo may have needed one. */
const CHANGES = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** Tools that create or move todos: a turn with one registered its work. */
const TODOS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);

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
 * One of hoop's own messages in hoop's format: a review wake, a Work message from the person (opened
 * as `steerMessage` opens it, its reference on the last line) or a closed action item. Anything else
 * a peer sends, such as another agent repeating one, is the agent's.
 */
function hoopMessage(raw: string): Omit<Request, "id" | "at"> | undefined {
  const text = raw.replace(PEER, "");
  const review = text.match(WAKE)?.[1];
  if (review) return { kind: "review", text: text.split("\n")[0]!.slice(0, TEXT_MAX), review };
  const ref = text.match(REF)?.[1];
  const head = text.split("\n")[0]!;
  if (ref && head.startsWith("From ") && head.includes(` ${WORK_VIA}`)) return { kind: "change", text: "Changes from the Work page", ref };
  const action = text.match(ACTION)?.[1];
  if (action) return { kind: "action", text: text.split("\n")[0]!.slice(0, TEXT_MAX), action };
  return undefined;
}

/**
 * What an entry asks, by who sent it: a person's message is a prompt, a peer's is a request only in
 * hoop's own format, and a notification or continuation is the agent's (`"agent"`). An entry with no
 * origin is a slash command, a request in an older transcript, or nothing (a meta note).
 */
function classify(text: string | undefined, origin: string | undefined, meta: boolean): Omit<Request, "id" | "at"> | "agent" | undefined {
  if (!text?.trim()) return undefined;
  if (origin === "human") return { kind: "prompt", text: text.trim().slice(0, TEXT_MAX) };
  if (origin === "peer") return hoopMessage(text) ?? "agent";
  if (origin !== undefined) return "agent";
  if (meta) return undefined;
  const command = text.match(COMMAND)?.[1];
  if (command) return { kind: "prompt", text: `/${command} ${text.match(ARGS)?.[1]?.trim() ?? ""}`.trim().slice(0, TEXT_MAX) };
  // An older transcript: hoop's messages came as plain user messages, and plain text is a prompt.
  return hoopMessage(text) ?? (/^\s*[<[]/.test(text) ? undefined : { kind: "prompt", text: text.trim().slice(0, TEXT_MAX) });
}

/**
 * A transcript's requests, oldest first; `turns` maps each prompt ID to its request, or null for a
 * turn nobody asked for; `current` is the latest turn's.
 */
export type Requests = {
  requests: Request[];
  turns: Map<string, string | null>;
  prompt?: string;
  current: string | null;
  /** Whether the transcript has prompt IDs, so an entry without one is a local command's. */
  ids?: true;
  /** Whether its entries say who sent them (`origin`); a headless run's don't. */
  origins?: true;
  /** The slash command the last entry was, which a local command's output takes back. */
  command?: { id: string; prompt?: string };
  /** Claude Code's queue as the transcript tells it: what waits, in order. */
  queue?: Queued[];
  /** The queued messages that may be the person's, oldest first, waiting or picked up. */
  queued?: Queued[];
  /** When each dequeue not yet followed by the entry it took happened. */
  taken?: string[];
  /** The request each todo tool call came after, by its `tool_use` ID, or null for none (#269). */
  uses?: Map<string, string | null>;
};

/**
 * A message queued while the agent worked: when Claude Code queued it, when the agent picked it up
 * (`picked`), mid-turn or at the turn's end, and the request it became (`request`). Until it is
 * picked up nothing says whose it is: a peer's is queued as bare text too. `passed` says a turn the
 * person started went ahead of it, so it no longer reads as waiting.
 */
export type Queued = { text: string; at: string; picked?: string; request?: string; passed?: true };

/** How many of the person's queued messages a scan remembers, and how many queue entries. */
const QUEUED_MAX = 50,
  QUEUE_MAX = 200,
  /** How long before the entry it took a dequeue can be. */
  DEQUEUE_MS = 5_000;

/** Text Claude Code or another agent wraps in a tag of its own: not the person's message. */
const WRAPPED = /^\s*<(?:task-notification|agent-message|local-command-[a-z]+|command-[a-z]+|system-reminder|bash-[a-z]+|user-prompt-submit-hook)\b/;

/**
 * Whether queued text may be the person's own: not a notification or another agent's message, which
 * come in a known tag, nor a message over the session socket or one of hoop's, which ends with its
 * reference. A peer's message is queued as bare text; the entry that delivers it says it was a peer's.
 */
export const personQueued = (text: string) => !WRAPPED.test(text) && !PEER.test(text) && !/\n\(hoop-(?:ref|action) [a-z]+_[a-z0-9]+\)\s*$/.test(text);

/**
 * One queue operation, in place: an enqueue waits; a removal takes the entry with its text (the
 * agent took it mid-turn); a dequeue takes the entry the next user entry holds, and popAll takes them
 * all back to the prompt.
 */
function queueOp(s: Requests, v: Obj, at: string) {
  const queue = (s.queue ??= []);
  if (v.operation === "enqueue" && typeof v.content === "string") {
    const q: Queued = { text: v.content, at };
    queue.push(q);
    if (queue.length > QUEUE_MAX) queue.shift();
    if (personQueued(q.text)) {
      (s.queued ??= []).push(q);
      if (s.queued.length > QUEUED_MAX) s.queued.shift();
    }
  } else if (v.operation === "remove") {
    const n = queue.findIndex((q) => q.text === v.content);
    if (n >= 0) {
      const q = queue.splice(n, 1)[0]!;
      q.picked = at;
      delete q.passed;
    }
  } else if (v.operation === "dequeue") {
    (s.taken ??= []).push(at);
    if (s.taken.length > QUEUED_MAX) s.taken.shift();
  } else if (v.operation === "popAll") {
    const back = new Set(queue);
    s.queued = (s.queued ?? []).filter((q) => !back.has(q));
    s.queue = [];
    s.taken = [];
  }
}

/**
 * Text as a queued message and the entry that delivers it can both be compared: without the socket
 * message's opening line, and a slash command as `/name args`.
 */
function comparable(text: string): string {
  const t = text.replace(PEER, "").trim();
  const command = t.match(COMMAND)?.[1];
  return command ? `/${command} ${t.match(ARGS)?.[1]?.trim() ?? ""}`.trim() : t;
}

/** The queued message an entry with `text` delivers: the one it reads as, else the one it opens with (a peer's gains a note). */
function delivered(list: Queued[], text: string): number {
  const t = comparable(text);
  const n = list.findIndex((q) => comparable(q.text) === t);
  return n >= 0 ? n : list.findIndex((q) => comparable(q.text) && t.startsWith(comparable(q.text)));
}

/**
 * Whether an entry is a message the person typed: its origin says so, or, in a transcript with no
 * origins (a headless run's), it is plain text and no meta note, as `classify` reads it.
 */
const typedBy = (s: Requests, text: string, origin: string | undefined, meta: boolean) =>
  origin === "human" || (origin === undefined && !s.origins && !meta && !/^\s*[<[]/.test(text) && !hoopMessage(text));

/**
 * A user entry or mid-turn attachment that delivers a queued message: it is picked up, at the
 * dequeue before the entry when there is one, and becomes the entry's request. The entry's origin
 * says whose it was, which the queue doesn't: one that isn't a person's (a peer's message, an
 * automatic continuation) leaves the person's list. A meta note or a local command's output delivers
 * nothing; a slash command, which has no origin, does, and so does plain text where no entry has one.
 */
function pickUp(s: Requests, v: Obj, text: string, origin: string | undefined, attachment: boolean) {
  const id = typeof v.uuid === "string" ? v.uuid : "";
  const mine = typedBy(s, text, origin, !attachment && Boolean(v.isMeta)) || (origin === undefined && COMMAND.test(text));
  const settle = (q: Queued) => {
    if (mine) q.request = id;
    else s.queued = (s.queued ?? []).filter((x) => x !== q);
  };
  if (attachment) {
    const list = (s.queued ?? []).filter((x) => x.picked && !x.request);
    const n = delivered(list, text);
    if (n >= 0) settle(list[n]!);
    return;
  }
  if (origin === undefined && !mine) return;
  const queue = s.queue ?? [];
  const n = delivered(queue, text);
  if (n < 0) return;
  const q = queue.splice(n, 1)[0]!;
  // A dequeue comes right before the entry it took; an older one took an entry from before the read.
  const at = typeof v.timestamp === "string" ? v.timestamp : q.at;
  s.taken = (s.taken ?? []).filter((x) => Date.parse(at) - Date.parse(x) <= DEQUEUE_MS);
  q.picked = s.taken.shift() ?? at;
  delete q.passed;
  settle(q);
}

function readLine(s: Requests, line: string) {
  let v: Obj | undefined;
  try {
    v = obj(JSON.parse(line));
  } catch {
    return;
  }
  const at = typeof v?.timestamp === "string" ? v.timestamp : undefined;
  if (!v || !at) return;
  if (v.type === "queue-operation") return queueOp(s, v, at);
  // Stopping background agents queues Claude Code's notice of it as bare text, with this entry at
  // the same time: the notice isn't the person's message.
  if (v.type === "system" && v.subtype === "agents_killed") {
    if (s.queued) s.queued = s.queued.filter((q) => q.picked || q.at !== at);
    return;
  }
  // A compaction summary, and what only the transcript view shows, change no turn.
  if (v.isCompactSummary || v.isVisibleInTranscriptOnly) return;
  const command = s.command;
  delete s.command;
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
      if (TODOS.has(name)) {
        if (r) r.created = true;
        // A todo's request is the one before its call, whatever was taken mid-turn by its hook.
        const id = obj(p)!.id;
        if (typeof id === "string") {
          const uses = (s.uses ??= new Map());
          uses.set(id, r?.id ?? null);
          if (uses.size > TURNS_MAX) uses.delete(uses.keys().next().value!);
        }
      }
    }
    return;
  }
  if (v.type === "attachment") {
    // A request taken mid-turn is the turn's request from then on: the todos the agent creates after
    // reading it are its.
    const a = obj(v.attachment);
    if (a?.type !== "queued_command" || typeof a.prompt !== "string") return;
    const origin = typeof obj(a.origin)?.kind === "string" ? String(obj(a.origin)!.kind) : undefined;
    if (origin) s.origins = true;
    pickUp(s, v, a.prompt, origin, true);
    const what = classify(a.prompt, origin, false);
    if (!what || what === "agent") return;
    s.current = add({ ...what, mid: true }).id;
    if (s.prompt) s.turns.set(s.prompt, s.current);
    return;
  }
  if (v.type !== "user") return;
  const text = textOf(obj(v.message)?.content);
  const prompt = typeof v.promptId === "string" ? v.promptId : undefined;
  const origin = typeof obj(v.origin)?.kind === "string" ? String(obj(v.origin)!.kind) : undefined;
  if (origin) s.origins = true;
  if (text) pickUp(s, v, text, origin, false);
  // A turn the person starts goes ahead of what still waits in the queue; one a notification, a peer
  // or an interrupt starts doesn't, and the person's message stays queued behind it.
  const passes = Boolean(text && typedBy(s, text, origin, Boolean(v.isMeta))) && (prompt ? !s.turns.has(prompt) : true);
  if (passes) for (const q of s.queue ?? []) q.passed = true;
  // A local slash command (/clear, /model) asks the agent nothing: it has no prompt ID where the
  // transcript has them, and its output follows it.
  if (command && text?.trimStart().startsWith("<local-command-stdout>")) {
    s.requests = s.requests.filter((r) => r.id !== command.id);
    if (command.prompt) s.turns.set(command.prompt, null);
    if (s.current === command.id) s.current = null;
    return;
  }
  if (!prompt && s.ids && text && COMMAND.test(text)) return;
  const what = classify(text, origin, Boolean(v.isMeta));
  if (prompt) s.ids = true;
  if (prompt) {
    // A turn starts at the first entry with its prompt ID; one nobody asked for may still turn out
    // to be the person's (a slash command after its caveat note).
    const known = s.turns.get(prompt);
    if (known === undefined || (known === null && what && what !== "agent")) {
      const r = what && what !== "agent" ? add(what).id : null;
      if (r && text && COMMAND.test(text)) s.command = { id: r, prompt };
      s.turns.set(prompt, r);
      if (s.turns.size > TURNS_MAX) s.turns.delete(s.turns.keys().next().value!);
    }
    s.prompt = prompt;
    s.current = s.turns.get(prompt) ?? null;
    return;
  }
  // Older transcripts have no prompt IDs: each request, or each turn nobody asked for, starts one.
  if (what === "agent") s.current = null;
  else if (what) {
    s.current = add(what).id;
    if (text && COMMAND.test(text)) s.command = { id: s.current };
  }
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
 * The source of a todo created by the tool call `use` (the hook's `tool_use_id`) in the turn with
 * `prompt` (its `prompt_id`; a subagent's turn has its session's): the request the call came after in
 * the transcript, since the hook may land after a later one was taken mid-turn. A call the transcript
 * doesn't hold (a subagent's) takes its turn's latest request, else `agent`; without a prompt ID, the
 * latest turn's. Undefined when the transcript can't be read, or doesn't hold that turn, so the
 * source stays unknown.
 */
export function sourceOf(path: string | undefined, prompt: string | undefined, now: string, use?: string): Source | undefined {
  const scan = path ? transcriptRequests(path) : undefined;
  if (!scan) return undefined;
  const at = use !== undefined ? scan.uses?.get(use) : undefined;
  if (at === undefined && prompt && !scan.turns.has(prompt)) return undefined;
  const id = at !== undefined ? at : prompt ? scan.turns.get(prompt)! : scan.current;
  const r = id ? scan.requests.find((x) => x.id === id) : undefined;
  if (!r) return id ? undefined : { kind: "agent", at: now };
  return {
    kind: r.kind,
    at: r.at,
    ...(r.review ? { review: r.review } : {}),
    ...(r.ref ? { ref: r.ref } : {}),
    ...(r.action ? { action: r.action } : {}),
    request: r.id,
    text: firstLine(r.text),
  };
}
