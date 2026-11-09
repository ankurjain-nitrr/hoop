import { statSync } from "node:fs";
import { channel, type Sender, sendText } from "./deliver.js";
import { type OwnerProcess, transcriptOf } from "./owner.js";
import { firstLine, transcriptRequests, WORK_VIA } from "./requests.js";
import { currentUser, HoopError, isList, isRecord, quote } from "./util.js";
import { todoState } from "../web/activity.js";
import { editWork, readWork, sessionTranscript, type WorkChange, workRecords, type WorkReply, type WorkRecord, type WorkTodo } from "./work.js";
import { newlyRead, type WorkSession } from "./work-view.js";
import { moveOrder, sameSubject, settle, addedTodo } from "./work-settle.js";
import { isOpen, moveInQueue, parkedTodo, startsAfter, waitsFor } from "./work-queue.js";
import { actsAs, claudeSessions, processOf, type SessionReader } from "./claude-sessions.js";
import { newId } from "./ids.js";
import { isOff } from "./off.js";

// People steer a session's own todo list and subagents from the Work page. Each change reaches the
// agent two ways: in one message over the session's messaging socket, a few seconds after the last
// change, and through the gate, a PreToolUse hook that refuses to start a changed todo and refuses
// every tool call of a stopped agent. hoop never plans, reorders or starts anything itself.

/** A change as the Work page sends it. */
type ChangeInput = {
  kind?: unknown;
  todo?: unknown;
  agent?: unknown;
  text?: unknown;
  description?: unknown;
  before?: unknown;
  after?: unknown;
  /** A withdraw: the add it takes back. */
  of?: unknown;
  /** A comment about a request no todo came from: the request's ID. */
  request?: unknown;
};

const TEXT_MAX = 2000,
  DESCRIPTION_MAX = 8000,
  BATCH_MAX = 20;

const text = (v: unknown, what: string, max = TEXT_MAX) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new HoopError(`${what} needs text`);
  if (s.length > max) throw new HoopError(`${what} is longer than ${max} characters`);
  return s;
};

/** One change as it is checked: the session's work, the person's input, the fields every change has, and the todo and agent it names. */
type ChangeAt = {
  r: WorkRecord;
  input: ChangeInput;
  base: Pick<WorkChange, "id" | "by" | "at" | "delivery">;
  todo: WorkTodo | undefined;
  agent: WorkRecord["agents"][number] | undefined;
};

/** Whether a removal of todo `id` is still open. */
const removedTodo = (r: WorkRecord, id: string) => (r.changes ?? []).some((c) => c.kind === "remove" && c.todo === id && isOpen(c));

/** The change's todo, which must be queued (or running, with `running`) and not removed already. */
function queuedTodo({ r, input, todo }: ChangeAt, running = false): WorkTodo {
  if (!todo) throw new HoopError(`no todo ${String(input?.todo)} in this session`);
  if (todo.status !== "queued" && !(running && todo.status === "running")) throw new HoopError(`todo #${todo.id} isn't queued any more`);
  if (removedTodo(r, todo.id)) throw new HoopError(`todo #${todo.id} is already removed`);
  return todo;
}

/** The change's new description, or undefined when it gives none or the same as `was`. */
function newDescription(input: ChangeInput, what: string, was = ""): string | undefined {
  if (input.description === undefined) return undefined;
  if (typeof input.description !== "string") throw new HoopError(`${what} description is text`);
  const d = input.description.trim();
  if (d.length > DESCRIPTION_MAX) throw new HoopError(`a description is longer than ${DESCRIPTION_MAX} characters`);
  return d === was.trim() ? undefined : d;
}

function removeChange(c: ChangeAt): WorkChange {
  const t = queuedTodo(c);
  return { ...c.base, kind: "remove", todo: t.id, subject: t.text };
}

function editChange(c: ChangeAt): WorkChange {
  // A running todo takes an edit too: it reaches the agent between steps, as every message does.
  const t = queuedTodo(c, true);
  const to = text(c.input.text, "An edit", 500);
  const d = newDescription(c.input, "an edit's", t.description);
  if (to === t.text && d === undefined) throw new HoopError(`todo #${t.id} already says that`);
  return { ...c.base, kind: "edit", todo: t.id, subject: t.text, was: t.status, text: to, ...(d !== undefined ? { description: d } : {}) };
}

function addChange({ r, input, base }: ChangeAt): WorkChange {
  const to = text(input.text, "A new todo", 500);
  const d = newDescription(input, "a new todo's");
  const open = (r.changes ?? []).some((c) => c.kind === "add" && !c.todo && isOpen(c) && sameSubject(c.text!, to));
  if (open || r.todos.some((x) => x.status !== "done" && sameSubject(x.text, to))) throw new HoopError(`the list already has a todo ${quote(to)}`);
  return { ...base, kind: "add", subject: to, text: to, ...(d ? { description: d } : {}) };
}

function withdrawChange({ r, input, base }: ChangeAt): WorkChange {
  const dep = (r.changes ?? []).find((c) => c.id === input.of && c.kind === "depend");
  if (dep) {
    if (dep.delivery === "withdrawn" || !startsAfter(r, dep.todo!).includes(dep.after!))
      throw new HoopError(`todo #${dep.todo} no longer starts after #${dep.after}`);
    return { ...base, kind: "withdraw", of: dep.id, todo: dep.todo, after: dep.after, subject: dep.subject };
  }
  const add = (r.changes ?? []).find((c) => c.id === input.of && c.kind === "add");
  if (!add || add.todo || !isOpen(add)) throw new HoopError("only an added todo Claude hasn't created yet can be withdrawn");
  return { ...base, kind: "withdraw", of: add.id, subject: add.text!, text: add.text! };
}

function parkChange(c: ChangeAt, kind: "park" | "unpark"): WorkChange {
  const t = queuedTodo(c);
  if ((kind === "park") === parkedTodo(c.r, t.id)) throw new HoopError(`todo #${t.id} is ${kind === "park" ? "already" : "not"} parked`);
  return { ...c.base, kind, todo: t.id, subject: t.text };
}

function moveChange(c: ChangeAt): WorkChange {
  const { r, input } = c;
  const t = queuedTodo(c);
  if (parkedTodo(r, t.id)) throw new HoopError(`todo #${t.id} is parked: unpark it first`);
  const where = (["before", "after"] as const).find((w) => typeof input[w] === "string");
  if (!where) throw new HoopError("a move needs before or after");
  const other = r.todos.find((x) => x.id === input[where]);
  if (other?.status !== "queued" || other.id === t.id || removedTodo(r, other.id) || parkedTodo(r, other.id))
    throw new HoopError(`todo #${String(input[where])} isn't a queued todo to move around`);
  return { ...c.base, kind: "move", todo: t.id, subject: t.text, [where]: other.id };
}

function dependChange(c: ChangeAt): WorkChange {
  const { r, input } = c;
  const t = queuedTodo(c);
  const other = r.todos.find((x) => x.id === input.after);
  if (!other || other.status === "done" || other.id === t.id || removedTodo(r, other.id))
    throw new HoopError(`todo #${String(input.after)} isn't a todo to wait for: it must be in the list and not done`);
  if (parkedTodo(r, other.id)) throw new HoopError(`todo #${other.id} is parked: unpark it first`);
  if (t.blocked_by?.includes(other.id) || startsAfter(r, t.id).includes(other.id)) throw new HoopError(`todo #${t.id} already starts after #${other.id}`);
  if (waitsFor(r, other.id, t.id)) throw new HoopError(`todo #${other.id} already waits for #${t.id}, so #${t.id} can't start after it: that would be a cycle`);
  return { ...c.base, kind: "depend", todo: t.id, subject: t.text, after: other.id };
}

function commentChange({ r, input, base, todo, agent }: ChangeAt): WorkChange {
  const body = text(input.text, "A comment");
  if (input.request !== undefined) {
    const q = transcriptRequests(sessionTranscript(r) ?? "")?.requests.find((x) => x.id === input.request);
    if (!q) throw new HoopError(`no request ${String(input.request)} in this session`);
    return { ...base, kind: "comment", request: q.id, subject: firstLine(q.text), text: body };
  }
  if (todo && todo.status !== "done") return { ...base, kind: "comment", todo: todo.id, subject: todo.text, was: todo.status, text: body };
  if (agent && agent.status === "running") return { ...base, kind: "comment", agent: agent.id, subject: agent.description ?? "Subagent", text: body };
  throw new HoopError("a comment needs a queued or running todo, or a running subagent");
}

/** A subagent as an error names it: by its description when it has one, else by its ID. */
const subagentName = (agent: { id: string; description?: string } | undefined, id: unknown) =>
  agent?.description ? quote(agent.description) : String(agent?.id ?? id);

function stopChange({ r, input, base, agent }: ChangeAt): WorkChange {
  if (agent?.status !== "running") throw new HoopError(`no running subagent ${subagentName(agent, input?.agent)} in this session`);
  if ((r.changes ?? []).some((c) => c.kind === "stop" && c.agent === agent.id))
    throw new HoopError(`subagent ${subagentName(agent, agent.id)} is already stopped`);
  return { ...base, kind: "stop", agent: agent.id, subject: agent.description ?? "Subagent" };
}

/** How each kind of change is checked and recorded. */
const CHANGE_KINDS = new Map<unknown, (c: ChangeAt) => WorkChange>([
  ["remove", removeChange],
  ["edit", editChange],
  ["add", addChange],
  ["withdraw", withdrawChange],
  ["park", (c) => parkChange(c, "park")],
  ["unpark", (c) => parkChange(c, "unpark")],
  ["move", moveChange],
  ["depend", dependChange],
  ["comment", commentChange],
  ["stop", stopChange],
]);

/** Checks one change against the session's work, and returns it as recorded. */
function makeChange(r: WorkRecord, input: ChangeInput, by: string, at: string, delivery: WorkChange["delivery"]): WorkChange {
  const todo = typeof input?.todo === "string" ? r.todos.find((t) => t.id === input.todo) : undefined;
  const agent = typeof input?.agent === "string" ? r.agents.find((a) => a.id === input.agent) : undefined;
  const base = { id: newId("ch"), by, at, delivery };
  const make = CHANGE_KINDS.get(input?.kind);
  if (!make) throw new HoopError('a change\'s kind is one of "add", "withdraw", "remove", "edit", "move", "park", "unpark", "depend", "comment" or "stop"');
  return make({ r, input, base, todo, agent });
}

/**
 * Records a person's changes to a session's work, all or none. They are `pending` when the session
 * takes messages, else `waiting` for the gate. Returns undefined when the session has no work.
 */
export function addChanges(
  home: string,
  session: string,
  inputs: unknown,
  opts: { by?: string; reachable: boolean; now?: string; process?: OwnerProcess },
): WorkChange[] | undefined {
  if (!isList(inputs) || !inputs.length) throw new HoopError("expected { changes: [ ... ] } with at least one change");
  if (inputs.length > BATCH_MAX) throw new HoopError(`at most ${BATCH_MAX} changes at once`);
  const at = opts.now ?? new Date().toISOString();
  const by = opts.by ?? currentUser();
  return editWork(home, session, (r) => {
    const draft: Draft = {
      ...r,
      changes: [...(r.changes ?? [])],
      parked: Array.isArray(r.parked) ? [...r.parked] : [],
      starts_after: Object.fromEntries(r.todos.flatMap((t) => (startsAfter(r, t.id).length ? [[t.id, startsAfter(r, t.id)]] : []))) as Record<string, string[]>,
    };
    // Each change is checked against the ones before it, so a batch can't remove a todo twice.
    const added = inputs.map((input) => {
      const c = makeChange(draft, isRecord(input) ? input : {}, by, at, opts.reachable ? "pending" : "waiting");
      // A comment or an added todo keeps its session's process, so the session that takes it over after `/clear` may answer it.
      if ((c.kind === "comment" || c.kind === "add") && opts.process) c.process = opts.process;
      applyAtOnce(draft, c, at);
      draft.changes.push(c);
      return c;
    });
    r.changes = draft.changes;
    if (draft.queue) r.queue = draft.queue;
    if (draft.parked.length) r.parked = draft.parked;
    else delete r.parked;
    if (Object.keys(draft.starts_after).length) r.starts_after = draft.starts_after;
    else delete r.starts_after;
    return added;
  });
}

/** A session's work as a batch of changes edits it, before it is saved. */
type Draft = WorkRecord & { changes: WorkChange[]; parked: string[]; starts_after: Record<string, string[]> };

/** The part of a change that takes effect at once, before the agent hears of it. */
function applyAtOnce(draft: Draft, c: WorkChange, at: string) {
  // A move changes the person's order at once, so the page, the record and the gate agree.
  if (c.kind === "move") Object.assign(c, moveInQueue(draft, c.todo!, c.before ? "before" : "after", (c.before ?? c.after)!));
  // So does a park: the todo leaves the queue, and comes back to its place when unparked.
  if (c.kind === "park") draft.parked.push(c.todo!);
  if (c.kind === "unpark") draft.parked = draft.parked.filter((id) => id !== c.todo);
  // And a depend: the todo is blocked from now on, until the blocker is done.
  if (c.kind === "depend") draft.starts_after[c.todo!] = [...(draft.starts_after[c.todo!] ?? []), c.after!];
  if (c.kind === "withdraw") withdrawAtOnce(draft, c, at);
}

/** A withdraw takes its add or depend back at once; one that never reached the agent needs no message. */
function withdrawAtOnce(draft: Draft, c: WorkChange, at: string) {
  if (c.after) {
    const left = draft.starts_after[c.todo!]!.filter((id) => id !== c.after);
    if (left.length) draft.starts_after[c.todo!] = left;
    else delete draft.starts_after[c.todo!];
  }
  const add = draft.changes.find((x) => x.id === c.of)!;
  const told = add.sent_at !== undefined || add.gated_at;
  Object.assign(add, { delivery: "withdrawn", settled_at: at });
  if (!told) Object.assign(c, { delivery: "seen", settled_at: at });
}

/** What an edit changed, in plain words: the subject, the description, or both. */
function editWords(c: WorkChange): string {
  const subject = c.text !== c.subject;
  const said = subject ? `Edited todo #${c.todo} to ${quote(c.text!)} (it said ${quote(c.subject)}).` : `Edited todo #${c.todo} ${quote(c.subject)}.`;
  if (c.description === undefined) return said;
  return `${said} ${c.description ? `New description: ${quoteBlock(c.description)}.` : "Its description is now empty."}`;
}

/** A todo a person added, in plain words. */
export const addWords = (c: WorkChange) => `Added a todo ${quote(c.text!)}${c.description ? ` with the description ${quoteBlock(c.description)}` : ""}.`;

/** A withdrawn add or depend, in plain words. */
export const withdrawWords = (c: WorkChange) =>
  c.after
    ? `Todo #${c.todo} ${quote(c.subject)} no longer has to start after #${c.after}: start it in its turn.`
    : `Withdrew the todo ${quote(c.text!)} added earlier: don't create it, or delete it with TaskUpdate (status "deleted") if you already did.`;

/** What TaskUpdate should set for an edit. */
export const editTask = (c: WorkChange) =>
  c.description === undefined
    ? "set its subject to the new text"
    : c.text !== c.subject
      ? "set its subject and description to the new text"
      : "set its description to the new text";

/** A description quoted whole, its line breaks kept so lists and links read as written. */
export const quoteBlock = (s: string) => `"${s.trim()}"`;

/** One change in plain words, with what the agent should do about it. */
export function changeLine(c: WorkChange): string {
  switch (c.kind) {
    case "remove":
      return `Removed todo #${c.todo} ${quote(c.subject)}. Don't do it: delete it with TaskUpdate (status "deleted").`;
    case "edit":
      return c.was === "running"
        ? `${editWords(c)} It is in progress: carry on with the edited version, and ${editTask(c)} with TaskUpdate.`
        : `${editWords(c)} Do the edited version: ${editTask(c)} with TaskUpdate.`;
    case "add":
      return `${addWords(c)} Create it with TaskCreate, ${c.description ? "with that subject and description" : "with that subject"}, after the todos already queued. ${answerAdd(c)}`;
    case "park":
      return `Parked todo #${c.todo} ${quote(c.subject)}. Keep it in your list, but don't start it until it is unparked.`;
    case "unpark":
      return `Unparked todo #${c.todo} ${quote(c.subject)}. It is back in the queue: do it in its turn.`;
    case "withdraw":
      return withdrawWords(c);
    case "move": {
      const { first, second } = moveOrder(c);
      return c.before ? `Moved todo #${first} before #${second}. Do #${first} first.` : `Moved todo #${second} after #${first}. Do #${first} first.`;
    }
    case "depend":
      return `Todo #${c.todo} ${quote(c.subject)} starts after #${c.after}: don't start it until #${c.after} is done. Record it with TaskUpdate (taskId "${c.todo}", addBlockedBy ["${c.after}"]); if you keep your list with TodoWrite, hoop keeps the link for you.`;
    case "comment":
      if (c.request) return `About your request ${quote(c.subject)}, which no todo came from: ${quote(c.text!)}`;
      return c.todo
        ? `Comment ${c.id} on todo #${c.todo} ${quote(c.subject)}: ${quote(c.text!)}. ${answerIt(c)}`
        : `Comment ${c.id} on agent ${quote(c.subject)} (ID ${c.agent}): ${quote(c.text!)}. Pass it on to the agent if it should act on it. ${answerIt(c)}`;
    case "stop":
      return `Stop agent ${quote(c.subject)} (ID ${c.agent}): stop it now with TaskStop (task_id "${c.agent}"). hoop already refuses its tool calls.`;
    case "done":
      return `hoop sees ${c.text}; if that finishes todo #${c.todo} ${quote(c.subject)}, mark it completed (with TaskUpdate, or TodoWrite if you keep your list with it), or say what's left.`;
  }
}

/** How the agent answers a person's comment: in hoop, on the comment's ID, and in chat. */
export const answerIt = (c: WorkChange) => `Answer it with hoop_reply on ${c.id}, as well as in chat.`;

/** How the agent answers a todo the person added, often a question: under the todo, before marking it completed. */
export const answerAdd = (c: WorkChange) =>
  `If it asks something, answer it with hoop_reply on ${c.id}, as well as in chat, before you mark it completed: the reply shows under the todo.`;

/** The changes with each run of consecutive moves of one todo as its last move, where the todo ended up. */
function collapseMoves(changes: WorkChange[]): WorkChange[] {
  const out: WorkChange[] = [];
  for (const c of changes) {
    const last = out[out.length - 1];
    if (c.kind === "move" && last?.kind === "move" && last.todo === c.todo && last.by === c.by) out[out.length - 1] = c;
    else out.push(c);
  }
  return out;
}

/**
 * The one message a batch of changes becomes, a paragraph per person: who made them, where, and that
 * they are about the agent's own work, not approvals. Repeated moves of one todo read as one. What
 * hoop itself found (`done`) comes last, in a paragraph of its own.
 */
export function steerMessage(changes: WorkChange[]): string {
  const theirs = changes.filter((c) => c.kind !== "done");
  const found = changes.filter((c) => c.kind === "done").map((c) => `- ${changeLine(c)}`);
  const people = [...new Set(theirs.map((c) => c.by))];
  return [
    ...people.map((by) => {
      const lines = collapseMoves(theirs.filter((c) => c.by === by)).map((c) => `- ${changeLine(c)}`);
      return `From ${by} ${WORK_VIA} They are instructions about your work, not approvals of anything.\n${lines.join("\n")}`;
    }),
    ...(found.length ? [`From hoop's Work view: what hoop checked about your own todos. It reports evidence and approves nothing.\n${found.join("\n")}`] : []),
  ].join("\n\n");
}

/** The size of a session's transcript, as its record or Claude Code's folder names it, or undefined. */
function transcriptSize(home: string, session: string): number | undefined {
  const r = readWork(home, session);
  for (const path of [r?.transcript, transcriptOf(session)])
    try {
      if (path) return statSync(path).size;
    } catch {
      /* try the next */
    }
  return undefined;
}

/** How long an idle session's turn must have ended before an add it didn't create counts as overridden. */
export const ADD_GRACE_MS = 15_000;

/** How long the Work page's changes to a session wait for more before they go out as one message. */
const STEER_DELAY_MS = 3000;

/**
 * Batches each session's pending changes into one message, sent `delayMs` after the last change, and
 * records whether it went out (`sent`) or waits for the gate (`waiting`).
 */
export class Steer {
  private timers = new Map<string, NodeJS.Timeout>();
  private flushing = new Map<string, Promise<unknown>>();
  constructor(
    private home: string,
    private sessions: SessionReader = claudeSessions,
    private opts: { delayMs?: number; send?: Sender } = {},
  ) {}

  private get delay() {
    return this.opts.delayMs ?? STEER_DELAY_MS;
  }

  /**
   * The session's messaging socket, when it runs, has one and uses this hoop home (`channel`): a
   * session that keeps its work in another home never reads these changes, so nothing is sent to it.
   */
  socket(session: string): string | undefined {
    // With messages off in hoop's off list, no session takes them: changes wait for the gate.
    if (isOff(this.home, "messages")) return undefined;
    try {
      const to = channel(
        this.home,
        this.sessions().find((x) => x.session === session),
      );
      return "socket" in to ? to.socket : undefined;
    } catch {
      return undefined;
    }
  }

  /** Records a person's changes and schedules the session's message. Undefined when it has no work. */
  record(session: string, inputs: unknown, by?: string): WorkChange[] | undefined {
    const reachable = Boolean(this.socket(session));
    const process = processOf(session, this.sessions);
    const added = addChanges(this.home, session, inputs, { reachable, ...(by ? { by } : {}), ...(process ? { process } : {}) });
    if (added && reachable) this.schedule(session);
    return added;
  }

  private schedule(session: string) {
    clearTimeout(this.timers.get(session));
    const t = setTimeout(() => {
      this.timers.delete(session);
      void this.flush(session);
    }, this.delay);
    t.unref();
    this.timers.set(session, t);
  }

  /** Sends the session's pending changes now, as one message, one flush at a time. */
  flush(session: string): Promise<WorkChange[]> {
    const run = (this.flushing.get(session) ?? Promise.resolve()).then(() => this.send(session));
    const done = run.catch(() => undefined);
    this.flushing.set(session, done);
    void done.then(() => this.flushing.get(session) === done && this.flushing.delete(session));
    return run;
  }

  private async send(session: string): Promise<WorkChange[]> {
    const batch = editWork(this.home, session, (r) => (r.changes ?? []).filter((c) => c.delivery === "pending").map((c) => ({ ...c }))) ?? [];
    if (!batch.length) return [];
    const socket = this.socket(session);
    // The reference lets the page tell, from the session's transcript, when the agent read it; the
    // transcript's size now is where a scan for it starts.
    const ref = newId("st");
    const offset = transcriptSize(this.home, session);
    let sent = false;
    // A message that doesn't go leaves the changes to the gate.
    if (socket) sent = (await sendText(socket, `${steerMessage(batch)}\n\n(hoop-ref ${ref})`, this.opts.send)).sent;
    const now = new Date().toISOString();
    const ids = new Set(batch.map((c) => c.id));
    return editWork(this.home, session, (r) => markSent(r, ids, sent ? { now, ref, offset } : undefined)) ?? [];
  }

  /** Records the changes the Work view newly found read, so they stay read; a session with none isn't touched. */
  markRead(view: WorkSession[]) {
    for (const s of view) {
      const read = new Map(newlyRead(s).map((c) => [c.id, c.read_at!]));
      if (!read.size) continue;
      editWork(this.home, s.id, (r) => {
        for (const c of r.changes ?? []) if (c.delivery === "sent" && read.has(c.id)) Object.assign(c, { delivery: "read", read_at: read.get(c.id) });
      });
    }
  }

  /**
   * Marks overridden each add the agent's turn or session ended without: its session ended, or idles
   * after activity later than when the add reached it (by message or the gate), for ADD_GRACE_MS, so a
   * TaskCreate hook still on its way lands first. Writes only records that have one.
   */
  settleAdds(view: WorkSession[], now = Date.now()) {
    const missed = (s: WorkSession, c: WorkChange) => {
      if (c.kind !== "add" || c.todo || !isOpen(c)) return false;
      if (s.state === "ended") return true;
      const told = c.sent_at ?? c.gated_at;
      return s.state === "idle" && Boolean(told && s.activity && s.activity > told) && now - Date.parse(s.activity!) >= ADD_GRACE_MS;
    };
    for (const s of view) {
      const ids = new Set(s.changes.filter((c) => missed(s, c)).map((c) => c.id));
      if (!ids.size) continue;
      const at = new Date(now).toISOString();
      editWork(this.home, s.id, (r) => {
        settle(r, at);
        for (const c of r.changes ?? []) if (ids.has(c.id) && isOpen(c) && !c.todo) Object.assign(c, { delivery: "overridden", settled_at: at });
      });
      for (const c of s.changes) if (ids.has(c.id)) Object.assign(c, { delivery: "overridden", settled_at: at });
    }
  }

  /**
   * Tells the agent, once per todo, when the Work view reads a todo it still has in progress as done
   * from evidence its own description names (a pull request merged, a review approved): a `done`
   * change by hoop that goes out like a person's and is seen once the agent marks the todo done. A
   * todo is known by its ID and subject, so a TodoWrite list that reuses a place is a new todo. Only
   * a session that takes messages and whose turn ended is told; the page shows Done either way.
   */
  noteDone(view: WorkSession[], now = Date.now()) {
    for (const s of view) {
      if (s.state !== "idle" || !s.reachable) continue;
      const told = new Set(s.changes.filter((c) => c.kind === "done").map((c) => doneKey(c.todo!, c.subject)));
      const found = s.todos.flatMap((t) => {
        const st = t.status === "running" && !told.has(doneKey(t.id, t.text)) ? todoState(s, t, now) : undefined;
        const named = st?.link && t.description?.includes(st.link.href);
        return st?.state === "done" && named ? [{ t, text: st.note.replace(/^Done: /, "").replace(/ \(hoop checked\)$/, "") }] : [];
      });
      if (!found.length) continue;
      const at = new Date(now).toISOString();
      const added = editWork(this.home, s.id, (r) => {
        const out: WorkChange[] = [];
        for (const { t, text } of found) {
          const current = r.todos.find((x) => x.id === t.id);
          if (
            (r.changes ?? []).some((c) => c.kind === "done" && doneKey(c.todo!, c.subject) === doneKey(t.id, t.text)) ||
            current?.status !== "running" ||
            current.text !== t.text
          )
            continue;
          const c: WorkChange = { id: newId("ch"), kind: "done", todo: t.id, subject: t.text, text, by: "hoop", at, delivery: "pending" };
          r.changes = [...(r.changes ?? []), c];
          out.push(c);
        }
        return out;
      });
      if (!added?.length) continue;
      s.changes.push(...added);
      this.schedule(s.id);
    }
  }

  /** Sends the changes a restart of the pages process left pending, for the sessions on the Work page. */
  catchUp(view: WorkSession[]) {
    const old = Date.now() - 2 * this.delay;
    for (const s of view)
      if (!this.timers.has(s.id) && !this.flushing.has(s.id) && s.changes.some((c) => c.delivery === "pending" && Date.parse(c.at) < old))
        void this.flush(s.id);
  }
}

/**
 * Marks a batch's changes still pending as sent, with the message's reference and the transcript's
 * size when it went (`message`), or as waiting for the gate when no message went.
 */
function markSent(r: WorkRecord, ids: Set<string>, message: { now: string; ref: string; offset: number | undefined } | undefined): WorkChange[] {
  const out: WorkChange[] = [];
  for (const c of r.changes ?? []) {
    if (!ids.has(c.id) || c.delivery !== "pending") continue;
    c.delivery = message ? "sent" : "waiting";
    if (message) Object.assign(c, { sent_at: message.now, ref: message.ref, ...(message.offset !== undefined ? { sent_offset: message.offset } : {}) });
    out.push(c);
  }
  return out;
}

/** A todo as a `done` note knows it: its ID and subject. */
const doneKey = (id: string, subject: string) => `${id}\n${subject}`;

/** How many replies a comment keeps: the newest. */
export const REPLIES_MAX = 20;

/**
 * Whether the todo at a comment's ID is still the one commented on: it has the comment's subject, or
 * the text of a later edit of it by a person. A TodoWrite place holding another todo is not.
 */
function sameTodo(r: WorkRecord, c: WorkChange, t: WorkTodo): boolean {
  const edits = (r.changes ?? []).filter((x) => x.kind === "edit" && x.todo === c.todo && x.at >= c.at).map((x) => x.text!);
  return [c.subject, ...edits].some((s) => sameSubject(t.text, s));
}

/**
 * Links an add not yet matched to the todo Claude created from it, which may already be in the
 * record; otherwise why it takes no reply yet. TaskCreate's hook runs after the tool call, so a
 * reply right after it can come first.
 */
function matchAdd(r: WorkRecord, c: WorkChange): string | undefined {
  if (c.delivery === "withdrawn") return `the todo ${quote(c.text!)} was withdrawn, so it takes no replies: answer in chat instead`;
  const t = addedTodo(r, c);
  if (t) return void (c.todo = t.id);
  return `hoop hasn't seen the todo ${quote(c.text!)} created yet: if you just created it, reply again in a moment; otherwise create it with TaskCreate first`;
}

/**
 * Why a reply to a person's comment or added todo is refused: a todo's conversation is closed once it
 * isn't queued or running, and an added todo takes replies only once Claude created it. A comment on
 * an agent stays open after the agent finishes, for the session that owns it.
 */
function closedFor(r: WorkRecord, c: WorkChange): string | undefined {
  if (c.kind === "add" && !c.todo) {
    const missing = matchAdd(r, c);
    if (missing) return missing;
  }
  if (c.todo) {
    const found = r.todos.find((x) => x.id === c.todo);
    const t = found && sameTodo(r, c, found) ? found : undefined;
    if (t?.status === "queued" || t?.status === "running") return undefined;
    return `todo #${c.todo} is ${t ? "done" : "gone"}, so its ${c.kind === "add" ? "replies" : "comments"} are closed: answer in chat instead`;
  }
  return undefined;
}

/**
 * The agent's reply to a person's comment, or to a todo they added, on the Work page (`hoop_reply` on
 * its `ch_` ID). It is in the caller's own work, or in the work of the session it took over after
 * `/clear` (the same Claude Code process). The reply settles it as seen. A todo's conversation stays
 * open only while the todo is queued or running; an agent's stays open after the agent finishes.
 */
export function replyToComment(
  home: string,
  session: string,
  id: string,
  body: string,
  opts: { by: string; now?: string; sessions?: SessionReader },
): { comment: string; session: string; reply: WorkReply } {
  const text_ = text(body, "A reply");
  const own = readWork(home, session);
  const found = own?.changes?.some((c) => c.id === id) ? own : workRecords(home).find((r) => r.changes?.some((c) => c.id === id));
  if (!found) throw new HoopError(`no comment ${id} in this session's work`);
  const theirs = found.changes!.find((c) => c.id === id)!;
  const tookOver = Boolean(theirs.process) && actsAs({ session: found.session, process: theirs.process }, session, opts.sessions);
  if (found.session !== session && !tookOver) throw new HoopError(`${id} is in another session's work: only the session it was made in replies to it`);
  const at = opts.now ?? new Date().toISOString();
  const reply = editWork(home, found.session, (r) => {
    const c = r.changes?.find((x) => x.id === id);
    if (!c) throw new HoopError(`no comment ${id} in this session's work`);
    if (c.kind !== "comment" && c.kind !== "add") throw new HoopError(`${id} is a ${c.kind}: only a comment or an added todo takes a reply`);
    const closed = closedFor(r, c);
    if (closed) throw new HoopError(closed);
    const out: WorkReply = { by: opts.by, body: text_, at };
    c.replies = [...(c.replies ?? []), out].slice(-REPLIES_MAX);
    if (c.delivery !== "seen") Object.assign(c, { delivery: "seen", settled_at: at });
    return out;
  });
  if (!reply) throw new HoopError(`no comment ${id} in this session's work`);
  return { comment: id, session: found.session, reply };
}
