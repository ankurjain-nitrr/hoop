import { statSync } from "node:fs";
import { sep } from "node:path";
import { tailLines } from "./activity.js";
import { transcriptOf, validSession } from "./owner.js";
import { changeLine } from "./steer.js";
import { receiptKey, receivedBy, type Store } from "./store.js";
import { isWaiting } from "./wait.js";
import { editWork, readChanges, readWork, sessionTranscript, unreadChange, type WorkRecord } from "./work.js";

// The Stop gate: Claude Code's Stop hook, run before the session's turn ends. It blocks the end of a
// turn once per cause, with one line on what to do, for feedback that arrived during the turn and
// that the agent hasn't read: a review, a quick question's answer or a Work change. Every rule reads
// hoop's records and the session's transcript; anything unreadable lets the turn end.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isList = (v: unknown): v is unknown[] => Array.isArray(v);
const obj = (v: unknown): Obj | undefined => (isObj(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim()}"`;

/** How much of the transcript's end the gate reads for the turn, as the Work page reads activity. */
const TAIL_BYTES = 256 * 1024;
/** How many causes a record remembers it told. */
const TOLD_MAX = 50;

/**
 * The transcript's latest turn, as the Stop hook ends it: `start`, the time of the entry that opened
 * it, and `last`, the time of the agent's last entry. The opener is the first user message (not a
 * tool result) after the previous turn's end (an assistant entry with `stop_reason` "end_turn", a
 * `turn_duration` note or an interruption), or after the transcript's start when `complete`. A later
 * message that isn't a meta note, before any assistant entry, takes its place (a local command's notes
 * come before the prompt). A message taken mid-turn opens nothing. Undefined without an opener in the lines.
 */
export function readTurn(lines: string[], complete: boolean): { start: string; last?: string } | undefined {
  const turn: TurnState = { ended: complete, seen: false };
  for (const line of lines) {
    const v = parseLine(line);
    if (v) readEntry(turn, v);
  }
  return turn.start ? { start: turn.start, ...(turn.last ? { last: turn.last } : {}) } : undefined;
}

/** What `readTurn` knows so far: whether the previous turn ended, whether the agent spoke since the opener, the opener's time and the agent's last time. */
type TurnState = { ended: boolean; seen: boolean; start?: string; last?: string };

/** A transcript line as an object, or undefined when it isn't one. */
function parseLine(line: string): Obj | undefined {
  try {
    return obj(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** Reads one transcript entry into the turn. */
function readEntry(turn: TurnState, v: Obj) {
  const at = str(v.timestamp);
  if (v.type === "assistant") readAgent(turn, v, at);
  else if (v.type === "system" && v.subtype === "turn_duration") turn.ended = true;
  else if (v.type === "user") readUser(turn, v, at);
}

/** An assistant entry: the agent's last time, and the turn's end when it stopped with `end_turn`. */
function readAgent(turn: TurnState, v: Obj, at: string | undefined) {
  if (at) turn.last = at;
  turn.seen = true;
  if (obj(v.message)?.stop_reason === "end_turn") turn.ended = true;
}

/** A user entry: an interruption ends the turn, and a message after an end, or a later prompt before the agent spoke, opens it. */
function readUser(turn: TurnState, v: Obj, at: string | undefined) {
  const text = userText(v);
  if (text === undefined) return;
  if (text.startsWith("[Request interrupted")) {
    turn.ended = true;
    return;
  }
  if (!at || !text.trim()) return;
  if (turn.ended || (!turn.seen && turn.start && !v.isMeta)) {
    turn.start = at;
    turn.ended = turn.seen = false;
  }
}

/** A user entry's text, or undefined for a tool result. */
function userText(v: Obj): string | undefined {
  const content = obj(v.message)?.content;
  const parts = isList(content) ? content.map(obj) : [];
  if (parts.some((p) => p?.type === "tool_result")) return undefined;
  return typeof content === "string" ? content : parts.map((p) => (p?.type === "text" ? String(p.text ?? "") : "")).join("");
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
      // A question Claude withdrew, or a review a person closed, needs no reading.
      if (meta.ask?.withdrawn || meta.closed || isWaiting(store.home, id)) continue;
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

/** The Work changes since `start` that the session hasn't read. */
function unreadChanges(r: WorkRecord, transcript: string, start: string): Cause[] {
  return readChanges(r.changes ?? [], transcript)
    .changes.filter((c) => c.at >= start && unreadChange(c) && (c.delivery === "waiting" || c.unread))
    .map((c) => ({ key: `change:${c.id}`, line: `${c.by} changed your work in hoop's Work view, and you haven't read it: ${changeLine(c)}` }));
}

/**
 * The Stop gate's decision on one Stop hook input: a reason to block the turn's end, or undefined to
 * let it end. It never blocks a subagent's stop or a stop the hook already blocked once
 * (`stop_hook_active`), and each cause blocks once: the record's `stop_told` keeps what it told.
 */
export function stopGate(store: Store, input: unknown, now = new Date().toISOString()): { block: string } | undefined {
  try {
    const i = obj(input);
    const session = isGateable(i) && !i.agent_id ? validSession(i.session_id) : undefined;
    if (!i || !session) return undefined;
    const record = readWork(store.home, session);
    const transcript = str(i.transcript_path) ?? (record ? sessionTranscript(record) : transcriptOf(session));
    if (!transcript) return undefined;
    const start = turnStart(transcript, record?.turn_ended);
    // A turn whose start the lines don't hold lets the turn end.
    if (!start || start > now) return undefined;
    const feedback = unreadFeedback(store, session, start);
    const reason = editWork(store.home, session, (r) => tellOnce(r, [...unreadChanges(r, transcript, start), ...feedback]), {
      create: feedback.length > 0,
    });
    return reason ? { block: reason } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a Stop hook input is one the gate reads: a Stop the hook hasn't blocked yet, from a valid session. */
export function isGateable(input: unknown): input is Obj {
  return isObj(input) && input.hook_event_name === "Stop" && input.stop_hook_active !== true && validSession(input.session_id) !== undefined;
}

/** When the turn ending started, from the transcript's end and the previous Stop (`ended`); undefined when the lines don't hold it. */
function turnStart(transcript: string, ended: string | undefined): string | undefined {
  const lines = tailLines(transcript, TAIL_BYTES);
  const turn = readTurn(lines, statSync(transcript).size <= TAIL_BYTES);
  // The previous Stop counts as the turn's start when it came later than the opener the lines
  // show (and before the agent's last words, so it isn't this turn's own Stop).
  const first = firstTime(lines);
  const previous = ended && turn?.last && ended < turn.last && first && ended >= first ? ended : undefined;
  if (!turn) return previous;
  return previous && previous > turn.start ? previous : turn.start;
}

/** The block reason for the causes the record hasn't told yet, which it then remembers in `stop_told`; undefined when it told them all. */
function tellOnce(r: WorkRecord, all: Cause[]): string | undefined {
  const told = Array.isArray(r.stop_told) ? r.stop_told : [];
  const causes = all.filter((c) => !c.key.split(" ").every((k) => told.includes(k)));
  if (!causes.length) return undefined;
  r.stop_told = [...told, ...causes.flatMap((c) => c.key.split(" "))].slice(-TOLD_MAX);
  return `Before you end your turn (hoop says this once): ${causes.map((c) => c.line).join(" ")}`;
}

/** The gate's decision as Claude Code's Stop hook output: a block with its reason, or `{}` to let the turn end. */
export const stopOutput = (d: { block: string } | undefined) => (d ? { decision: "block", reason: d.block } : {});
