import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { createConnection } from "node:net";
import { transcriptOf, validSession } from "./owner.js";
import { currentUser, HoopError } from "./util.js";
import { todoState } from "../web/activity.js";
import {
  claudeSessions,
  editTaken,
  editWork,
  firstQueued,
  isOpen,
  moveInQueue,
  moveOrder,
  newlyRead,
  parkedTodo,
  readWork,
  sameSubject,
  type SessionReader,
  settle,
  type WorkChange,
  type WorkRecord,
  type WorkSession,
} from "./work.js";

// People steer a session's own todo list and subagents from the Work page. Each change reaches the
// agent two ways: in one message over the session's messaging socket, a few seconds after the last
// change, and through the gate, a PreToolUse hook that refuses to start a changed todo and refuses
// every tool call of a stopped agent. hoop never plans, reorders or starts anything itself.

/** A change as the Work page sends it. */
export type ChangeInput = {
  kind?: unknown;
  todo?: unknown;
  agent?: unknown;
  text?: unknown;
  description?: unknown;
  before?: unknown;
  after?: unknown;
  /** A withdraw: the add it takes back. */
  of?: unknown;
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
const newId = (prefix = "ch") => `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

/** Checks one change against the session's work, and returns it as recorded. */
function makeChange(r: WorkRecord, input: ChangeInput, by: string, at: string, delivery: WorkChange["delivery"]): WorkChange {
  const kind = input?.kind;
  const todo = typeof input?.todo === "string" ? r.todos.find((t) => t.id === input.todo) : undefined;
  const agent = typeof input?.agent === "string" ? r.agents.find((a) => a.id === input.agent) : undefined;
  const base = { id: newId(), by, at, delivery };
  const removed = (id: string) => (r.changes ?? []).some((c) => c.kind === "remove" && c.todo === id && isOpen(c));
  const queued = (running = false) => {
    if (!todo) throw new HoopError(`no todo ${String(input?.todo)} in this session`);
    if (todo.status !== "queued" && !(running && todo.status === "running")) throw new HoopError(`todo #${todo.id} isn't queued any more`);
    if (removed(todo.id)) throw new HoopError(`todo #${todo.id} is already removed`);
    return todo;
  };
  const description = (what: string, was = "") => {
    if (input.description === undefined) return undefined;
    if (typeof input.description !== "string") throw new HoopError(`${what} description is text`);
    const d = input.description.trim();
    if (d.length > DESCRIPTION_MAX) throw new HoopError(`a description is longer than ${DESCRIPTION_MAX} characters`);
    return d === was.trim() ? undefined : d;
  };
  switch (kind) {
    case "remove": {
      const t = queued();
      return { ...base, kind, todo: t.id, subject: t.text };
    }
    case "edit": {
      // A running todo takes an edit too: it reaches the agent between steps, as every message does.
      const t = queued(true);
      const to = text(input.text, "An edit", 500);
      const d = description("an edit's", t.description);
      if (to === t.text && d === undefined) throw new HoopError(`todo #${t.id} already says that`);
      return { ...base, kind, todo: t.id, subject: t.text, was: t.status, text: to, ...(d !== undefined ? { description: d } : {}) };
    }
    case "add": {
      const to = text(input.text, "A new todo", 500);
      const d = description("a new todo's");
      const open = (r.changes ?? []).some((c) => c.kind === "add" && !c.todo && isOpen(c) && sameSubject(c.text!, to));
      if (open || r.todos.some((x) => x.status !== "done" && sameSubject(x.text, to))) throw new HoopError(`the list already has a todo ${quote(to)}`);
      return { ...base, kind, subject: to, text: to, ...(d ? { description: d } : {}) };
    }
    case "withdraw": {
      const add = (r.changes ?? []).find((c) => c.id === input.of && c.kind === "add");
      if (!add || add.todo || !isOpen(add)) throw new HoopError("only an added todo the agent hasn't created yet can be withdrawn");
      return { ...base, kind, of: add.id, subject: add.text!, text: add.text! };
    }
    case "park":
    case "unpark": {
      const t = queued();
      if ((kind === "park") === parkedTodo(r, t.id)) throw new HoopError(`todo #${t.id} is ${kind === "park" ? "already" : "not"} parked`);
      return { ...base, kind, todo: t.id, subject: t.text };
    }
    case "move": {
      const t = queued();
      if (parkedTodo(r, t.id)) throw new HoopError(`todo #${t.id} is parked: unpark it first`);
      const where = typeof input.before === "string" ? "before" : typeof input.after === "string" ? "after" : undefined;
      if (!where) throw new HoopError("a move needs before or after");
      const other = r.todos.find((x) => x.id === input[where]);
      if (other?.status !== "queued" || other.id === t.id || removed(other.id) || parkedTodo(r, other.id))
        throw new HoopError(`todo #${String(input[where])} isn't a queued todo to move around`);
      return { ...base, kind, todo: t.id, subject: t.text, [where]: other.id };
    }
    case "comment": {
      const body = text(input.text, "A comment");
      if (todo && todo.status !== "done") return { ...base, kind, todo: todo.id, subject: todo.text, was: todo.status, text: body };
      if (agent && agent.status === "running") return { ...base, kind, agent: agent.id, subject: agent.description ?? "Subagent", text: body };
      throw new HoopError("a comment needs a queued or running todo, or a running agent");
    }
    case "stop": {
      if (agent?.status !== "running") throw new HoopError(`no running agent ${String(input?.agent)} in this session`);
      if ((r.changes ?? []).some((c) => c.kind === "stop" && c.agent === agent!.id)) throw new HoopError("that agent is already stopped");
      return { ...base, kind, agent: agent!.id, subject: agent!.description ?? "Subagent" };
    }
    default:
      throw new HoopError('a change\'s kind is one of "add", "withdraw", "remove", "edit", "move", "park", "unpark", "comment" or "stop"');
  }
}

/**
 * Records a person's changes to a session's work, all or none. They are `pending` when the session
 * takes messages, else `waiting` for the gate. Returns undefined when the session has no work.
 */
export function addChanges(home: string, session: string, inputs: unknown, opts: { by?: string; reachable: boolean; now?: string }): WorkChange[] | undefined {
  if (!Array.isArray(inputs) || !inputs.length) throw new HoopError("expected { changes: [ ... ] } with at least one change");
  if (inputs.length > BATCH_MAX) throw new HoopError(`at most ${BATCH_MAX} changes at once`);
  const at = opts.now ?? new Date().toISOString();
  const by = opts.by ?? currentUser();
  return editWork(home, session, (r) => {
    const added: WorkChange[] = [];
    const draft = { ...r, changes: [...(r.changes ?? [])], parked: Array.isArray(r.parked) ? [...r.parked] : [] };
    // Each change is checked against the ones before it, so a batch can't remove a todo twice.
    for (const input of inputs) {
      const c = makeChange(draft, input as ChangeInput, by, at, opts.reachable ? "pending" : "waiting");
      // A move changes the person's order at once, so the page, the record and the gate agree.
      if (c.kind === "move") Object.assign(c, moveInQueue(draft, c.todo!, c.before ? "before" : "after", (c.before ?? c.after)!));
      // So does a park: the todo leaves the queue, and comes back to its place when unparked.
      if (c.kind === "park") draft.parked.push(c.todo!);
      if (c.kind === "unpark") draft.parked = draft.parked.filter((id) => id !== c.todo);
      // A withdraw takes its add back at once; one that never reached the agent needs no message.
      if (c.kind === "withdraw") {
        const add = draft.changes.find((x) => x.id === c.of)!;
        const told = add.sent_at !== undefined || add.gated_at;
        Object.assign(add, { delivery: "withdrawn", settled_at: at });
        if (!told) Object.assign(c, { delivery: "seen", settled_at: at });
      }
      draft.changes.push(c);
      added.push(c);
    }
    r.changes = draft.changes;
    if (draft.queue) r.queue = draft.queue;
    if (draft.parked.length) r.parked = draft.parked;
    else delete r.parked;
    return added;
  });
}

const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim()}"`;

/** What an edit changed, in plain words: the subject, the description, or both. */
function editWords(c: WorkChange): string {
  const subject = c.text !== c.subject;
  const said = subject ? `Edited todo #${c.todo} to ${quote(c.text!)} (it said ${quote(c.subject)}).` : `Edited todo #${c.todo} ${quote(c.subject)}.`;
  if (c.description === undefined) return said;
  return `${said} ${c.description ? `New description: ${quoteBlock(c.description)}.` : "Its description is now empty."}`;
}

/** A todo a person added, in plain words. */
const addWords = (c: WorkChange) => `Added a todo ${quote(c.text!)}${c.description ? ` with the description ${quoteBlock(c.description)}` : ""}.`;

/** A withdrawn add, in plain words. */
const withdrawWords = (c: WorkChange) =>
  `Withdrew the todo ${quote(c.text!)} added earlier: don't create it, or delete it with TaskUpdate (status "deleted") if you already did.`;

/** What TaskUpdate should set for an edit. */
const editTask = (c: WorkChange) =>
  c.description === undefined
    ? "set its subject to the new text"
    : c.text !== c.subject
      ? "set its subject and description to the new text"
      : "set its description to the new text";

/** A description quoted whole, its line breaks kept so lists and links read as written. */
const quoteBlock = (s: string) => `"${s.trim()}"`;

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
      return `${addWords(c)} Create it with TaskCreate, ${c.description ? "with that subject and description" : "with that subject"}, after the todos already queued.`;
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
    case "comment":
      return c.todo
        ? `Comment on todo #${c.todo} ${quote(c.subject)}: ${quote(c.text!)}`
        : `Comment on agent ${quote(c.subject)} (ID ${c.agent}): ${quote(c.text!)}. Pass it on to the agent if it should act on it.`;
    case "stop":
      return `Stop agent ${quote(c.subject)} (ID ${c.agent}): stop it now with TaskStop (task_id "${c.agent}"). hoop already refuses its tool calls.`;
    case "done":
      return `hoop sees ${c.text}; if that finishes todo #${c.todo} ${quote(c.subject)}, mark it completed (with TaskUpdate, or TodoWrite if you keep your list with it), or say what's left.`;
  }
}

/** The changes with each run of consecutive moves of one todo as its last move, where the todo ended up. */
export function collapseMoves(changes: WorkChange[]): WorkChange[] {
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
      return `From ${by} via hoop's Work view: changes to your own todo list and agents. They are instructions about your work, not approvals of anything.\n${lines.join("\n")}`;
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

/** Sends a message into a Claude Code session over its messaging socket: one line of JSON. */
export type Sender = (socket: string, text: string) => Promise<void>;

/** How long a send may take before it counts as failed. */
const SEND_MS = 3000;

/** Writes one user message line to a session's messaging socket, and resolves once it is written. */
export const sendToSession: Sender = (socket, text) =>
  new Promise((resolve, reject) => {
    const c = createConnection(socket);
    const timer = setTimeout(() => {
      c.destroy();
      reject(new Error("the session didn't take the message in time"));
    }, SEND_MS);
    c.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    c.on("connect", () =>
      c.end(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`, () => {
        clearTimeout(timer);
        // The session may keep its end open; the line is written, so close ours.
        setTimeout(() => c.destroy(), 500).unref();
        resolve();
      }),
    );
  });

/** How long an idle session's turn must have ended before an add it didn't create counts as overridden. */
export const ADD_GRACE_MS = 15_000;

/** How long the Work page's changes to a session wait for more before they go out as one message. */
export const STEER_DELAY_MS = 3000;

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

  /** The session's messaging socket, when it runs and has one. */
  socket(session: string): string | undefined {
    try {
      return this.sessions().find((s) => s.session === session)?.socket;
    } catch {
      return undefined;
    }
  }

  /** Records a person's changes and schedules the session's message. Undefined when it has no work. */
  record(session: string, inputs: unknown, by?: string): WorkChange[] | undefined {
    const reachable = Boolean(this.socket(session));
    const added = addChanges(this.home, session, inputs, { reachable, ...(by ? { by } : {}) });
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
    if (socket) {
      try {
        await (this.opts.send ?? sendToSession)(socket, `${steerMessage(batch)}\n\n(hoop-ref ${ref})`);
        sent = true;
      } catch {
        /* the gate still has them */
      }
    }
    const now = new Date().toISOString();
    const ids = new Set(batch.map((c) => c.id));
    return (
      editWork(this.home, session, (r) => {
        const out: WorkChange[] = [];
        for (const c of r.changes ?? [])
          if (ids.has(c.id) && c.delivery === "pending") {
            c.delivery = sent ? "sent" : "waiting";
            if (sent) Object.assign(c, { sent_at: now, ref, ...(offset !== undefined ? { sent_offset: offset } : {}) });
            out.push(c);
          }
        return out;
      }) ?? []
    );
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
          const c: WorkChange = { id: newId(), kind: "done", todo: t.id, subject: t.text, text, by: "hoop", at, delivery: "pending" };
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

/** The gate's answer to one PreToolUse input: a refusal with its reason, or nothing to say. */
export type GateDecision = { deny: string } | undefined;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);

/** A todo as a `done` note knows it: its ID and subject. */
const doneKey = (id: string, subject: string) => `${id}\n${subject}`;

/** Whether a todo tool call starts the todo or marks it done. */
const starts = (status?: string) => status === "in_progress" || status === "completed";

/** The gate on one todo: what it refuses when the agent starts it or marks it done, marking the change it told about. */
function gateTodo(
  r: WorkRecord,
  id: string,
  status: string | undefined,
  subject: string | undefined,
  now: string,
  description?: string,
  main = true,
): string | undefined {
  if (!starts(status)) return undefined;
  const open = (r.changes ?? []).filter((c) => isOpen(c));
  const tell = (c: WorkChange, reason: string) => {
    c.gated_at ??= now;
    return reason;
  };
  const removed = open.find((c) => c.kind === "remove" && c.todo === id);
  if (removed)
    return tell(
      removed,
      `${removed.by} removed todo #${id} ${quote(removed.subject)} in hoop's Work view. Don't start it or mark it done: delete it with TaskUpdate (status "deleted") and go on with the rest.`,
    );
  // The one-time tells below are for the session's own agent: a subagent's call never uses them up.
  if (!main) return undefined;
  const parked = parkedTodo(r, id);
  const park = parked ? open.find((c) => c.kind === "park" && c.todo === id && !c.gated_at) : undefined;
  if (park)
    return tell(
      park,
      `${park.by} parked todo #${id} ${quote(park.subject)} in hoop's Work view: keep it, but don't start it until they unpark it. Go on with another todo, or ask them.`,
    );
  // A running todo's edit stops only marking it done: setting it in progress again goes on.
  const edit = open.find((c) => c.kind === "edit" && c.todo === id && !c.gated_at && (c.was !== "running" || status === "completed"));
  const was = r.todos.find((t) => t.id === id);
  // The call takes the edit when it sets what the edit changed, or the todo already reads so.
  const takes =
    edit &&
    editTaken(
      {
        text: edit.text === edit.subject ? edit.text! : (subject ?? ""),
        description: description ?? was?.description,
      },
      edit,
    );
  if (edit && !takes) {
    const why =
      edit.text !== edit.subject
        ? `${edit.by} edited todo #${id} in hoop's Work view to ${quote(edit.text!)}. Do that instead of ${quote(edit.subject)}`
        : `${edit.by} edited todo #${id} ${quote(edit.subject)} in hoop's Work view`;
    const desc =
      edit.description === undefined ? "" : edit.description ? `, with the new description ${quoteBlock(edit.description)}` : ", with its description cleared";
    const then = edit.was === "running" ? "then mark it done once the edited version is done" : "then start it";
    const where = edit.was === "running" ? " (in progress)" : "";
    return tell(edit, `${why.replace(`#${id}`, `#${id}${where}`)}${desc}: ${editTask(edit).replace(/^set its/, "set the todo's")} with TaskUpdate, ${then}.`);
  }
  // A move or a comment the session never got a message about: tell the agent once, here.
  const status_ = (tid?: string) => r.todos.find((t) => t.id === tid)?.status;
  const move = open.find(
    (c) =>
      c.kind === "move" &&
      c.delivery === "waiting" &&
      !c.gated_at &&
      moveOrder(c).second === id &&
      status_(moveOrder(c).first) === "queued" &&
      !parkedTodo(r, moveOrder(c).first),
  );
  if (move) {
    const { first } = moveOrder(move);
    // The person's order would say the same: it counts as told.
    if (firstQueued(r)?.id === first) r.queue_told = [...(Array.isArray(r.queue_told) ? r.queue_told : []), `${id}>${first}`].slice(-TOLD_MAX);
    return tell(move, `${move.by} asked in hoop's Work view for todo #${first} to come before #${id}. Start #${first} first.`);
  }
  const note = open.find((c) => c.kind === "comment" && c.todo === id && c.delivery === "waiting" && !c.gated_at);
  if (note) return tell(note, `${note.by} commented on todo #${id} in hoop's Work view: ${quote(note.text!)}. Take it into account, then start it again.`);
  const add = open.find((c) => c.kind === "add" && !c.todo && c.delivery === "waiting" && !c.gated_at);
  if (add) return tell(add, `${add.by} in hoop's Work view: ${addWords(add)} Create it with TaskCreate after the todos already queued, then go on.`);
  const back = open.find((c) => c.kind === "withdraw" && c.delivery === "waiting" && !c.gated_at);
  if (back) return tell(back, `${back.by} in hoop's Work view: ${withdrawWords(back)} Then go on.`);
  // A parked todo the gate already told about goes on: the person's order says nothing of it.
  return status === "in_progress" && !parked ? gateOrder(r, id) : undefined;
}

/** How many refused out-of-order starts a record remembers. */
const TOLD_MAX = 50;

/**
 * The person's order: starting a queued todo while another comes first in it is refused once, so the
 * agent starts that one or asks; starting it again goes on. Nothing is refused until the person
 * moved a todo, and anything unreadable lets the call go on.
 */
function gateOrder(r: WorkRecord, id: string): string | undefined {
  try {
    if (r.todos.find((t) => t.id === id)?.status !== "queued") return undefined;
    const first = firstQueued(r);
    if (!first || first.id === id) return undefined;
    const told = Array.isArray(r.queue_told) ? r.queue_told : [];
    const key = `${id}>${first.id}`;
    if (told.includes(key)) return undefined;
    r.queue_told = [...told, key].slice(-TOLD_MAX);
    return `The person put #${first.id} first in hoop's Work view; start #${first.id}, or ask them.`;
  } catch {
    return undefined;
  }
}

/**
 * The gate: Claude Code's PreToolUse hook. It refuses every tool call of an agent a person stopped,
 * once tells a waiting comment to the agent it is about, and refuses a todo tool call that starts (or
 * marks done) a todo a person removed, or edited until the agent takes the new text; a move or comment
 * the session never got by message is told once the same way, and so is starting a todo while the
 * person's order puts another queued todo first. Anything else passes.
 */
export function workGate(home: string, input: unknown, now = new Date().toISOString()): GateDecision {
  const i = obj(input);
  const session = validSession(i?.session_id);
  if (!i || !session || i.hook_event_name !== "PreToolUse" || !readWork(home, session)) return undefined;
  const agent = str(i.agent_id);
  const tool = i.tool_name;
  const args = obj(i.tool_input) ?? {};
  const reason = editWork(home, session, (r) => {
    const why = decide(r);
    settle(r, now);
    return why;
  });
  return reason ? { deny: reason } : undefined;

  function decide(r: WorkRecord): string | undefined {
    if (agent) {
      const stop = (r.changes ?? []).find((c) => c.kind === "stop" && c.agent === agent);
      if (stop) {
        stop.gated_at ??= now;
        return `Stopped by ${stop.by} in hoop's Work view. Don't call any more tools: end your turn now and say what you finished.`;
      }
      const note = (r.changes ?? []).find((c) => c.kind === "comment" && c.agent === agent && c.delivery === "waiting" && !c.gated_at);
      if (note) {
        note.gated_at = now;
        return `${note.by} commented on your work in hoop's Work view: ${quote(note.text!)}. Take it into account, then go on.`;
      }
    }
    if (tool === "TaskUpdate") {
      const id = str(args.taskId) ?? str(args.task_id) ?? str(args.id);
      return id
        ? gateTodo(r, id, str(args.status), str(args.subject), now, typeof args.description === "string" ? args.description : undefined, !agent)
        : undefined;
    }
    if (tool === "TodoWrite" && Array.isArray(args.todos)) {
      // The legacy list has no IDs: a todo is known by its text, or its place.
      for (const [n, t] of args.todos.entries()) {
        const o = obj(t);
        const text = str(o?.content);
        const known = r.todos.find((x) => x.status === "queued" && x.text === text) ?? r.todos.find((x) => x.id === String(n + 1) && x.status === "queued");
        const why = known ? gateTodo(r, known.id, str(o?.status), text, now, undefined, !agent) : undefined;
        if (why) return why;
      }
    }
    return undefined;
  }
}

/** The gate's decision as Claude Code's PreToolUse hook output: a refusal, or `{}` to let the call go on. */
export const gateOutput = (d: GateDecision) =>
  d ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.deny } } : {};
