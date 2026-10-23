import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { validSession } from "./owner.js";
import { currentUser, HoopError } from "./util.js";
import {
  claudeSessions,
  editWork,
  isOpen,
  moveOrder,
  readWork,
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
export type ChangeInput = { kind?: unknown; todo?: unknown; agent?: unknown; text?: unknown; before?: unknown; after?: unknown };

const TEXT_MAX = 2000,
  BATCH_MAX = 20;

const text = (v: unknown, what: string, max = TEXT_MAX) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new HoopError(`${what} needs text`);
  if (s.length > max) throw new HoopError(`${what} is longer than ${max} characters`);
  return s;
};
const newId = () => `ch_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

/** Checks one change against the session's work, and returns it as recorded. */
function makeChange(r: WorkRecord, input: ChangeInput, by: string, at: string, delivery: WorkChange["delivery"]): WorkChange {
  const kind = input?.kind;
  const todo = typeof input?.todo === "string" ? r.todos.find((t) => t.id === input.todo) : undefined;
  const agent = typeof input?.agent === "string" ? r.agents.find((a) => a.id === input.agent) : undefined;
  const base = { id: newId(), by, at, delivery };
  const removed = (id: string) => (r.changes ?? []).some((c) => c.kind === "remove" && c.todo === id && isOpen(c));
  const queued = () => {
    if (!todo) throw new HoopError(`no todo ${String(input?.todo)} in this session`);
    if (todo.status !== "queued") throw new HoopError(`todo #${todo.id} isn't queued any more`);
    if (removed(todo.id)) throw new HoopError(`todo #${todo.id} is already removed`);
    return todo;
  };
  switch (kind) {
    case "remove": {
      const t = queued();
      return { ...base, kind, todo: t.id, subject: t.text };
    }
    case "edit": {
      const t = queued();
      const to = text(input.text, "An edit", 500);
      if (to === t.text) throw new HoopError(`todo #${t.id} already says that`);
      return { ...base, kind, todo: t.id, subject: t.text, text: to };
    }
    case "move": {
      const t = queued();
      const where = typeof input.before === "string" ? "before" : typeof input.after === "string" ? "after" : undefined;
      if (!where) throw new HoopError("a move needs before or after");
      const other = r.todos.find((x) => x.id === input[where]);
      if (other?.status !== "queued" || other.id === t.id || removed(other.id))
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
      throw new HoopError('a change\'s kind is one of "remove", "edit", "move", "comment" or "stop"');
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
    const draft = { ...r, changes: [...(r.changes ?? [])] };
    // Each change is checked against the ones before it, so a batch can't remove a todo twice.
    for (const input of inputs) {
      const c = makeChange(draft, input as ChangeInput, by, at, opts.reachable ? "pending" : "waiting");
      draft.changes.push(c);
      added.push(c);
    }
    r.changes = draft.changes;
    return added;
  });
}

const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim()}"`;

/** One change in plain words, with what the agent should do about it. */
export function changeLine(c: WorkChange): string {
  switch (c.kind) {
    case "remove":
      return `Removed todo #${c.todo} ${quote(c.subject)}. Don't do it: delete it with TaskUpdate (status "deleted").`;
    case "edit":
      return `Edited todo #${c.todo} to ${quote(c.text!)} (it said ${quote(c.subject)}). Do the edited version: set its subject to the new text with TaskUpdate.`;
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
  }
}

/**
 * The one message a batch of changes becomes, a paragraph per person: who made them, where, and that
 * they are about the agent's own work, not approvals.
 */
export function steerMessage(changes: WorkChange[]): string {
  const people = [...new Set(changes.map((c) => c.by))];
  return people
    .map((by) => {
      const lines = changes.filter((c) => c.by === by).map((c) => `- ${changeLine(c)}`);
      return `From ${by} via hoop's Work view: changes to your own todo list and agents. They are instructions about your work, not approvals of anything.\n${lines.join("\n")}`;
    })
    .join("\n\n");
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
    let sent = false;
    if (socket) {
      try {
        await (this.opts.send ?? sendToSession)(socket, steerMessage(batch));
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
            if (sent) c.sent_at = now;
            out.push(c);
          }
        return out;
      }) ?? []
    );
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

/** Whether a todo tool call starts the todo or marks it done. */
const starts = (status?: string) => status === "in_progress" || status === "completed";

/** The gate on one todo: what it refuses when the agent starts it or marks it done, marking the change it told about. */
function gateTodo(r: WorkRecord, id: string, status: string | undefined, subject: string | undefined, now: string): string | undefined {
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
  const edit = open.find((c) => c.kind === "edit" && c.todo === id && !c.gated_at);
  if (edit && subject !== edit.text)
    return tell(
      edit,
      `${edit.by} edited todo #${id} in hoop's Work view to ${quote(edit.text!)}. Do that instead of ${quote(edit.subject)}: set the todo's subject to the new text with TaskUpdate, then start it.`,
    );
  // A move or a comment the session never got a message about: tell the agent once, here.
  const status_ = (tid?: string) => r.todos.find((t) => t.id === tid)?.status;
  const move = open.find(
    (c) => c.kind === "move" && c.delivery === "waiting" && !c.gated_at && moveOrder(c).second === id && status_(moveOrder(c).first) === "queued",
  );
  if (move) {
    const { first } = moveOrder(move);
    return tell(move, `${move.by} asked in hoop's Work view for todo #${first} to come before #${id}. Start #${first} first.`);
  }
  const note = open.find((c) => c.kind === "comment" && c.todo === id && c.delivery === "waiting" && !c.gated_at);
  if (note) return tell(note, `${note.by} commented on todo #${id} in hoop's Work view: ${quote(note.text!)}. Take it into account, then start it again.`);
  return undefined;
}

/**
 * The gate: Claude Code's PreToolUse hook. It refuses every tool call of an agent a person stopped,
 * once tells a waiting comment to the agent it is about, and refuses a todo tool call that starts (or
 * marks done) a todo a person removed, or edited until the agent takes the new text; a move or comment
 * the session never got by message is told once the same way. Anything else passes.
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
      return id ? gateTodo(r, id, str(args.status), str(args.subject), now) : undefined;
    }
    if (tool === "TodoWrite" && Array.isArray(args.todos)) {
      // The legacy list has no IDs: a todo is known by its text, or its place.
      for (const [n, t] of args.todos.entries()) {
        const o = obj(t);
        const text = str(o?.content);
        const known = r.todos.find((x) => x.status === "queued" && x.text === text) ?? r.todos.find((x) => x.id === String(n + 1) && x.status === "queued");
        const why = known ? gateTodo(r, known.id, str(o?.status), text, now) : undefined;
        if (why) return why;
      }
    }
    return undefined;
  }
}

/** The gate's decision as Claude Code's PreToolUse hook output: a refusal, or `{}` to let the call go on. */
export const gateOutput = (d: GateDecision) =>
  d ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.deny } } : {};
