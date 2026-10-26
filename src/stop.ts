import { statSync } from "node:fs";
import { sep } from "node:path";
import { tailLines } from "./activity.js";
import { transcriptOf, validSession } from "./owner.js";
import { personQueued } from "./requests.js";
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
 * The transcript's latest turn, as the Stop hook ends it:
 * - `start`: the time of the entry that opened it. That is the first user message (not a tool
 *   result) after the previous turn's end (an assistant entry with `stop_reason` "end_turn", a
 *   `turn_duration` note or an interruption), or after the transcript's start when `complete`. A
 *   later message that isn't a meta note, before any assistant entry, takes its place (a local
 *   command's notes come before the prompt). A message taken mid-turn opens nothing.
 * - `human`: whether a person opened it (`origin.kind` "human"; in a transcript without origins, plain
 *   text that `personQueued` reads as theirs), not a peer, a wake, a task notification or a continuation.
 * - `worked`: whether the turn made a tool call or got a tool result.
 * - `background`: whether a background call (`run_in_background`, Monitor) has no task notification
 *   that it ended.
 * - `asked`: whether the last thing the agent said ends with a question.
 * Without an opener in the lines, `start` is undefined.
 */
export function readTurn(lines: string[], complete: boolean) {
  let ended = complete,
    seen = false,
    origins = false;
  let opener: Obj | undefined,
    worked = false,
    said = "",
    last: string | undefined;
  const background = new Set<string>();
  for (const line of lines) {
    let v: Obj | undefined;
    try {
      v = obj(JSON.parse(line));
    } catch {
      continue;
    }
    if (!v) continue;
    // A task notification (queued, attached or delivered) names the call it is about, and its status.
    for (const [, id, status] of line.matchAll(/<tool-use-id>([A-Za-z0-9_-]+)<\/tool-use-id>[\s\S]*?<status>([a-z_]+)<\/status>/g))
      if (status !== "running") background.delete(id!);
    if (obj(v.origin)?.kind) origins = true;
    const content = obj(v.message)?.content;
    const parts = Array.isArray(content) ? content.map(obj) : [];
    if (v.type === "assistant") {
      if (str(v.timestamp)) last = String(v.timestamp);
      seen = true;
      for (const p of parts) {
        if (p?.type === "tool_use") {
          worked = true;
          const input = obj(p.input);
          if (str(p.id) && (input?.run_in_background === true || p.name === "Monitor")) background.add(String(p.id));
        }
        if (p?.type === "text" && str(p.text)) said = String(p.text);
      }
      if (obj(v.message)?.stop_reason === "end_turn") ended = true;
      continue;
    }
    if (v.type === "system" && v.subtype === "turn_duration") ended = true;
    if (v.type !== "user") continue;
    if (parts.some((p) => p?.type === "tool_result")) {
      worked = true;
      continue;
    }
    const text = typeof content === "string" ? content : parts.map((p) => (p?.type === "text" ? String(p.text ?? "") : "")).join("");
    if (text.startsWith("[Request interrupted")) {
      ended = true;
      continue;
    }
    if (!str(v.timestamp) || !text.trim()) continue;
    if (ended || (!seen && opener && !v.isMeta)) {
      opener = v;
      ended = seen = worked = false;
      said = "";
    }
  }
  if (!opener) return undefined;
  const text = (() => {
    const c = obj(opener.message)?.content;
    return typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => String(obj(p)?.text ?? "")).join("") : "";
  })();
  const human = origins ? obj(opener.origin)?.kind === "human" : !opener.isMeta && personQueued(text);
  return {
    start: String(opener.timestamp),
    last,
    human,
    worked,
    background: background.size > 0,
    asked: /\?["'`*_)\]]*\s*$/.test(said),
  };
}

/** The time of the first entry in the lines that has one. */
function firstTime(lines: string[]): string | undefined {
  for (const line of lines) {
    const m = /"timestamp" *: *"([^"]+)"/.exec(line);
    if (m) return m[1];
  }
  return undefined;
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
function recordCauses(r: WorkRecord, transcript: string, start: string, idle: boolean): Cause[] {
  const out: Cause[] = [];
  // A running subagent may be working on the todo while the session waits for it.
  if (idle && !r.agents.some((a) => a.status === "running"))
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
    const turn = readTurn(lines, statSync(transcript).size <= TAIL_BYTES);
    // The previous Stop counts as the turn's start when it came later than the opener the lines
    // show (and before the agent's last words, so it isn't this turn's own Stop).
    const ended = record?.turn_ended;
    const first = firstTime(lines);
    const previous = ended && turn?.last && ended < turn.last && first && ended >= first ? ended : undefined;
    const start = turn && previous ? (previous > turn.start ? previous : turn.start) : (turn?.start ?? previous);
    // A turn whose start the lines don't hold lets the turn end.
    if (!start || start > now) return undefined;
    // Only a turn a person started, that did no tool work, waits on no background call and doesn't
    // end with a question to them, leaves a todo idle.
    const idle = Boolean(turn && turn.start === start && turn.human && !turn.worked && !turn.background && !turn.asked);
    const feedback = unreadFeedback(store, session, start);
    const reason = editWork(
      store.home,
      session,
      (r) => {
        const told = Array.isArray(r.stop_told) ? r.stop_told : [];
        const causes = [...recordCauses(r, transcript, start, idle), ...feedback].filter((c) => !c.key.split(" ").every((k) => told.includes(k)));
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
