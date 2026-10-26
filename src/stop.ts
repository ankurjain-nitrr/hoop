import { sep } from "node:path";
import { activityOf, tailLines } from "./activity.js";
import { transcriptOf, validSession } from "./owner.js";
import { changeLine } from "./steer.js";
import { receiptKey, receivedBy, type Store } from "./store.js";
import { isWaiting } from "./wait.js";
import { editWork, readChanges, readWork, sessionTranscript, type WorkRecord } from "./work.js";

// The Stop gate: Claude Code's Stop hook, run before the session's turn ends. It blocks the end of a
// turn once per cause, with one line on what to do: a todo left in progress by a turn that did no
// tool work, or feedback that arrived during the turn and that the agent hasn't read. Every rule
// reads hoop's records and the session's transcript; anything unreadable lets the turn end.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim()}"`;

/** How much of the transcript's end the gate reads for the turn, as the Work page reads activity. */
const TAIL_BYTES = 256 * 1024;
/** How many causes a record remembers it told. */
const TOLD_MAX = 50;

/**
 * When the transcript's latest turn started: the first entry with the turn's prompt ID (the hook's
 * `prompt_id`, else the latest one the transcript gives), or in a transcript without prompt IDs, the
 * latest user message that isn't a tool result, a meta note or an interruption. Undefined when the
 * lines don't hold it.
 */
export function turnStart(lines: string[], prompt?: string): string | undefined {
  const first = new Map<string, string>();
  let latest: string | undefined, plain: string | undefined;
  for (const line of lines) {
    let v: Obj | undefined;
    try {
      v = obj(JSON.parse(line));
    } catch {
      continue;
    }
    const at = str(v?.timestamp);
    if (!v || !at || v.type !== "user") continue;
    const id = str(v.promptId);
    if (id) {
      if (!first.has(id)) first.set(id, at);
      latest = id;
      continue;
    }
    const content = obj(v.message)?.content;
    const parts = Array.isArray(content) ? content.map(obj) : [];
    const text = typeof content === "string" ? content : parts.map((p) => (p?.type === "text" ? String(p.text ?? "") : "")).join("");
    if (v.isMeta || parts.some((p) => p?.type === "tool_result") || !text.trim() || text.startsWith("[Request interrupted")) continue;
    plain = at;
  }
  const id = prompt && first.has(prompt) ? prompt : latest;
  return id ? first.get(id) : plain;
}

/** One reason to block: its key in `stop_told`, and its line. */
type Cause = { key: string; line: string };

/** The feedback on the session's reviews and quick questions that came after `start` and that it hasn't received. */
function unreadFeedback(store: Store, session: string, start: string): Cause[] {
  const out: Cause[] = [];
  const own = Object.entries(store.registry.all()).filter(([, folder]) => folder.endsWith(`${sep}${session}${sep}.hoop`));
  for (const [id] of own) {
    try {
      const meta = store.meta(id);
      if (meta.ask?.withdrawn || isWaiting(store.home, id)) continue;
      const receipts = store.receipts(id);
      const fresh: string[] = [];
      let who: string | undefined;
      for (let n = 1; n <= meta.revisions; n++)
        store.feedback(id, n).forEach((fb, i) => {
          if (fb.at < start || receivedBy(receipts[receiptKey(n, i)], session)) return;
          fresh.push(`feedback:${id}:${receiptKey(n, i)}`);
          who ??= fb.reviewer;
        });
      if (!fresh.length) continue;
      const what = meta.ask ? `${quote(meta.title)} got an answer in hoop` : `${who ?? "A person"} reviewed ${quote(meta.title)} in hoop`;
      out.push({ key: fresh.join(" "), line: `${what}, and you haven't read it: read it with hoop_feedback ${id}.` });
    } catch {
      /* a review removed meanwhile, or unreadable */
    }
  }
  return out;
}

/** The causes in a session's record: a todo left in progress by a turn with no tool calls, and Work changes it hasn't read. */
function recordCauses(r: WorkRecord, transcript: string, start: string, worked: boolean): Cause[] {
  const out: Cause[] = [];
  // A running subagent may be working on the todo while the session waits for it.
  if (!worked && !r.agents.some((a) => a.status === "running"))
    for (const t of r.todos.filter((x) => x.status === "running"))
      out.push({
        key: `todo:${t.id}@${t.since ?? t.started ?? ""}`,
        line: `Todo #${t.id} ${quote(t.text)} is still in progress, but this turn did no work on it: work on it, mark it completed or pending (TaskUpdate or TodoWrite), or say what it waits on.`,
      });
  for (const c of readChanges(r.changes ?? [], transcript).changes) {
    if (c.at < start || c.kind === "stop" || c.kind === "done") continue;
    if ((c.delivery === "sent" && c.unread) || (c.delivery === "waiting" && !c.gated_at))
      out.push({ key: `change:${c.id}`, line: `${c.by} changed your work in hoop's Work view, and you haven't read it: ${changeLine(c)}` });
  }
  return out;
}

/**
 * The Stop gate's decision on one Stop hook input: a reason to block the turn's end, or undefined to
 * let it end. It never blocks a subagent's stop or a stop the hook already blocked once
 * (`stop_hook_active`), and each cause blocks once: the record's `stop_told` keeps what it told.
 */
export function stopGate(store: Store, input: unknown, now = new Date().toISOString()): { block: string } | undefined {
  try {
    const i = obj(input);
    const session = validSession(i?.session_id);
    if (!i || !session || i.hook_event_name !== "Stop" || i.stop_hook_active === true || i.agent_id) return undefined;
    const record = readWork(store.home, session);
    const transcript = str(i.transcript_path) ?? (record ? sessionTranscript(record) : transcriptOf(session));
    if (!transcript) return undefined;
    const lines = tailLines(transcript, TAIL_BYTES);
    const start = turnStart(lines, str(i.prompt_id));
    if (!start || start > now) return undefined;
    const worked = activityOf(lines).steps.some((s) => s.at >= start);
    const feedback = unreadFeedback(store, session, start);
    const reason = editWork(
      store.home,
      session,
      (r) => {
        const told = Array.isArray(r.stop_told) ? r.stop_told : [];
        const causes = [...recordCauses(r, transcript, start, worked), ...feedback].filter((c) => !c.key.split(" ").every((k) => told.includes(k)));
        if (!causes.length) return undefined;
        r.stop_told = [...told, ...causes.flatMap((c) => c.key.split(" "))].slice(-TOLD_MAX);
        return `Before you end your turn (hoop says this once): ${causes.map((c) => c.line).join(" ")}`;
      },
      { create: feedback.length > 0 },
    );
    return reason ? { block: reason } : undefined;
  } catch {
    return undefined;
  }
}

/** The gate's decision as Claude Code's Stop hook output: a block with its reason, or `{}` to let the turn end. */
export const stopOutput = (d: { block: string } | undefined) => (d ? { decision: "block", reason: d.block } : {});
