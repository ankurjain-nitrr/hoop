import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Activity, recentSteps, type Step, transcriptActivity, transcriptReads, waitsOn } from "./activity.js";
import { claudeDir, type Owner, type OwnerProcess, sessionName, transcriptOf, validSession } from "./owner.js";
import { processStarts, START_MARGIN_MS } from "./sessions.js";
import { type AgentLink, type AgentMeta, agentEnd, agentMeta, failReason, isRealAgent, outcomeOf, plainStep, reportLinks } from "./subagents.js";
import { parsePrUrl, type PrState } from "./prs.js";
import { type Request, type Source, sourceOf, transcriptRequests } from "./requests.js";
import { writeAtomic } from "./util.js";

/**
 * A todo as the Work page shows it. `active` is the text Claude Code shows while it runs, and
 * `description` the full task as TaskCreate or TaskUpdate last gave it.
 */
export type WorkTodo = {
  id: string;
  text: string;
  active?: string;
  description?: string;
  status: "queued" | "running" | "done";
  order: number;
  updated: string;
  /** When its status last changed: an edit to its text or description leaves this as it was. */
  since?: string;
  /** When it first started running; it stays once the todo is done. */
  started?: string;
  /** When hoop first saw it, for one that appeared after hoop began keeping this. */
  created?: string;
  /** The todos that must be done before it starts, as the agent's task list says. */
  blocked_by?: string[];
  /** The request it came from, recorded when it was created; none for a todo from before hoop kept this. */
  source?: Source;
  /** Titles of the hoop reviews its description links to, by review ID; the Work API adds them. */
  reviews?: Record<string, string>;
  /** While it runs, the reviews and pull requests that say what it waits on; the Work API adds them. */
  links?: TodoLink[];
  /** The states it went through, oldest first, at most HISTORY_MAX. */
  history?: StateEntry[];
};

/** A state a todo was in, from `at`: a status the hooks saw, or a state the Work page read from evidence. */
export type StateEntry = { state: string; at: string };

/** How many states a todo's history keeps. */
export const HISTORY_MAX = 20;

/** A todo's history with `state` from `at` added, unless it is in that state already. */
export function withState(history: StateEntry[] | undefined, state: string, at: string): StateEntry[] {
  const list = Array.isArray(history) ? history : [];
  const last = list[list.length - 1];
  if (last?.state === state) return list;
  // States can be read late: one never starts before the one it follows.
  return [...list, { state, at: last && last.at > at ? last.at : at }].slice(-HISTORY_MAX);
}

/**
 * A review or pull request a running todo is linked to, by a link in its description or, for a pull
 * request, by its session opening it while the todo ran (`opened`). A review's `at` is when its latest
 * revision came. A pull request's state is "unknown" until it is read.
 */
export type TodoLink =
  | { kind: "review"; id: string; title?: string; status: string; at: string; approved_at?: string }
  | ({ kind: "pr"; url: string; number: number; state: "open" | "merged" | "unknown"; opened?: true } & Pick<
      PrState,
      "checks" | "review_requested" | "ready" | "draft" | "opened_at" | "merged_at"
    >);

/** A subagent a session started. `last` is its last step as hoop last saw it. */
export type WorkAgent = {
  id: string;
  description?: string;
  type?: string;
  status: "running" | "done" | "stopped";
  started: string;
  ended?: string;
  transcript?: string;
  last?: string;
  /** The Agent tool call that started it, when known. */
  call?: string;
};

/** An Agent tool call seen before its subagent started, waiting to be paired with it. */
type PendingCall = { call: string; description?: string; type: string; at: string };

/** One session's work, as `<hoop home>/work/<session>.json` keeps it. */
export type WorkRecord = {
  session: string;
  cwd?: string;
  transcript?: string;
  updated: string;
  todos: WorkTodo[];
  agents: WorkAgent[];
  pending: PendingCall[];
  /** Tasks deleted, so a late hook doesn't bring one back. */
  deleted?: string[];
  /** What people changed from the Work page, oldest first. */
  changes?: WorkChange[];
  /**
   * The person's order of the todos, by ID, once they move one on the Work page. Until then the
   * agent's own order stands. Todos the agent adds later go at the end; deleted ones leave it.
   */
  queue?: string[];
  /** Out-of-order starts the gate already refused, as `<todo>><first>`, so a start the person agreed to goes on. */
  queue_told?: string[];
  /** Queued todos the person parked: kept in the list, out of the queue, not to be started. */
  parked?: string[];
  /** When hoop began recording sources for this session: a request before then can't be told unregistered. */
  sources_from?: string;
  /** The requests the person said need no todos, by ID. */
  dismissed?: string[];
  /** When the agent's latest turn ended, by the Stop hook. */
  turn_ended?: string;
  /** When the session ended, by the SessionEnd hook; any later hook means it was resumed. */
  ended?: string;
};

/**
 * How a person's change reached the agent: `pending` while it waits to go out with the session's
 * next message, `sent` in one, `read` once the session's transcript shows the message reached the
 * agent, `waiting` for the gate when the session takes no messages, and in the end `seen` (the hooks
 * saw the agent act on it, or the gate told it), `overridden` (it went ahead) or, for an add,
 * `withdrawn` (the person took it back).
 */
export type Delivery = "pending" | "sent" | "read" | "waiting" | "seen" | "overridden" | "withdrawn";

/** One change a person made to a session's work from the Work page. */
export type WorkChange = {
  id: string;
  kind: "remove" | "edit" | "move" | "comment" | "stop" | "add" | "park" | "unpark" | "withdraw";
  /** A withdraw: the add it takes back. */
  of?: string;
  /** The todo or agent it is about; an add's, once the agent created it. */
  todo?: string;
  agent?: string;
  /** What the todo said, or the agent's description, when the change was made. */
  subject: string;
  /** The todo's state then, so a comment counts as seen once the agent moves the todo on. */
  was?: WorkTodo["status"];
  /** An edit's new text (the subject as it was when only the description changed), a comment, or an added todo's subject. */
  text?: string;
  /** An edit's new description, when it changes the description (empty to clear it), or an added todo's. */
  description?: string;
  /** A move: the todo this one now goes before, or after. */
  before?: string;
  after?: string;
  /** A move: the todo's place among the queued todos before and after it, from 0. */
  from?: number;
  to?: number;
  by: string;
  at: string;
  delivery: Delivery;
  sent_at?: string;
  /** The reference of the message it went in, which the transcript shows once the agent read it. */
  ref?: string;
  /** The session transcript's size just before that message went out, where a scan for it starts. */
  sent_offset?: number;
  /** When the agent read that message: the time of the transcript entry that holds it. */
  read_at?: string;
  /** In the Work view only: the transcript was read whole since it went out, and doesn't hold it. */
  unread?: true;
  /** When the gate refused a tool call to tell the agent about it. */
  gated_at?: string;
  settled_at?: string;
  /** A comment about a request with no todos, asking the agent to register it: the request's ID. */
  request?: string;
};

/** What one hook call changes in a session's work. */
export type WorkEvent =
  | { kind: "todos"; todos: { id?: string; text: string; active?: string; status: string; blocked_by?: string[] }[] }
  | {
      kind: "todo";
      id: string;
      text?: string;
      active?: string;
      description?: string;
      status?: string;
      created?: true;
      blocked_by?: string[];
      /** Todos this one blocks, from TaskUpdate's `addBlocks`. */
      blocks?: string[];
    }
  | { kind: "call"; call: string; description?: string; type: string }
  | { kind: "turn-end" | "session-end" }
  | { kind: "agent-start"; id: string; type?: string; transcript?: string }
  | {
      kind: "agent-end";
      id?: string;
      call?: string;
      description?: string;
      type?: string;
      status: "running" | "done" | "stopped";
      transcript?: string;
      last?: string;
    };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : undefined);
/** A tool's response as an object: Claude Code passes some as JSON text. */
const response = (v: unknown): Obj | undefined => {
  if (typeof v !== "string") return obj(v);
  try {
    return obj(JSON.parse(v));
  } catch {
    return undefined;
  }
};

/** A list of task IDs, as `blockedBy` and `addBlockedBy` give them. */
const ids = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.flatMap((x) => str(x) ?? []) : undefined);

/** The subagent type Claude Code uses when the Agent tool names none. */
const DEFAULT_TYPE = "general-purpose";

/** One line of text, at most `max` characters. */
const oneLine = (text: string, max = 200) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * The work events in one Claude Code hook input: PreToolUse and PostToolUse on the task tools
 * (TaskCreate, TaskUpdate, TaskList, legacy TodoWrite) and the Agent tool (once Task), TaskStop,
 * and SubagentStart and SubagentStop. Anything else gives none.
 */
export function workEvents(input: unknown): WorkEvent[] {
  const i = obj(input);
  if (!i) return [];
  const event = i.hook_event_name;
  if (event === "Stop") return [{ kind: "turn-end" }];
  if (event === "SessionEnd") return [{ kind: "session-end" }];
  if (event === "SubagentStart" || event === "SubagentStop") {
    const id = str(i.agent_id);
    if (!id) return [];
    const type = str(i.agent_type);
    const transcript = str(i.agent_transcript_path);
    if (event === "SubagentStart") return [{ kind: "agent-start", id, ...(type ? { type } : {}), ...(transcript ? { transcript } : {}) }];
    const last = str(i.last_assistant_message);
    return [
      { kind: "agent-end", id, status: "done", ...(type ? { type } : {}), ...(transcript ? { transcript } : {}), ...(last ? { last: oneLine(last) } : {}) },
    ];
  }
  const tool = i.tool_name,
    input_ = obj(i.tool_input) ?? {},
    out = response(i.tool_response),
    call = str(i.tool_use_id);
  if (event === "PreToolUse") {
    if ((tool === "Agent" || tool === "Task") && call && !input_.taskId)
      return [
        { kind: "call", call, type: str(input_.subagent_type) ?? DEFAULT_TYPE, ...(str(input_.description) ? { description: str(input_.description) } : {}) },
      ];
    return [];
  }
  if (event !== "PostToolUse") return [];
  switch (tool) {
    case "TodoWrite": {
      const todos = Array.isArray(input_.todos) ? input_.todos : [];
      return [
        {
          kind: "todos",
          todos: todos.flatMap((t) => {
            const o = obj(t);
            const text = str(o?.content) ?? str(o?.subject);
            return o && text ? [{ ...(str(o.id) ? { id: str(o.id) } : {}), text, active: str(o.activeForm), status: str(o.status) ?? "pending" }] : [];
          }),
        },
      ];
    }
    case "TaskCreate": {
      const task = obj(out?.task) ?? out;
      const id = str(task?.id) ?? str(task?.taskId) ?? str(task?.task_id);
      const text = str(input_.subject) ?? str(task?.subject);
      const description = str(input_.description) ?? str(task?.description);
      return id && text
        ? [
            {
              kind: "todo",
              id,
              text,
              status: "pending",
              created: true,
              ...(str(input_.activeForm) ? { active: str(input_.activeForm) } : {}),
              ...(description ? { description } : {}),
            },
          ]
        : [];
    }
    case "TaskUpdate": {
      const id = str(input_.taskId) ?? str(input_.task_id) ?? str(input_.id) ?? str(out?.taskId);
      if (!id || out?.success === false) return [];
      const e: WorkEvent = { kind: "todo", id };
      if (str(input_.subject)) e.text = str(input_.subject);
      if (str(input_.activeForm)) e.active = str(input_.activeForm);
      if (typeof input_.description === "string") e.description = input_.description;
      if (str(input_.status)) e.status = str(input_.status);
      if (ids(input_.addBlockedBy)?.length) e.blocked_by = ids(input_.addBlockedBy);
      if (ids(input_.addBlocks)?.length) e.blocks = ids(input_.addBlocks);
      return [e];
    }
    case "TaskList": {
      const tasks = Array.isArray(out?.tasks) ? out.tasks : undefined;
      if (!tasks) return [];
      return [
        {
          kind: "todos",
          todos: tasks.flatMap((t) => {
            const o = obj(t);
            const id = str(o?.id),
              text = str(o?.subject);
            const blocked = ids(o?.blockedBy);
            return o && id && text ? [{ id, text, status: str(o.status) ?? "pending", ...(blocked ? { blocked_by: blocked } : {}) }] : [];
          }),
        },
      ];
    }
    case "TaskGet": {
      const task = obj(out?.task);
      const id = str(task?.id);
      return task && id
        ? [
            {
              kind: "todo",
              id,
              ...(str(task.subject) ? { text: str(task.subject) } : {}),
              ...(typeof task.description === "string" ? { description: task.description } : {}),
              ...(str(task.status) ? { status: str(task.status) } : {}),
            },
          ]
        : [];
    }
    case "TaskStop": {
      const id = str(input_.task_id) ?? str(input_.shell_id) ?? str(out?.task_id);
      return id ? [{ kind: "agent-end", id, status: "stopped" }] : [];
    }
    case "Agent":
    case "Task": {
      // Before the task tools, "Task" was the subagent tool; a "Task" call with a taskId is neither.
      if (input_.taskId) return [];
      const id = str(out?.agentId) ?? str(out?.agent_id);
      const launched = out?.status === "async_launched";
      const text = Array.isArray(out?.content) ? out.content.map((c) => str(obj(c)?.text) ?? "").join(" ") : str(out?.content);
      return [
        {
          kind: "agent-end",
          ...(id ? { id } : {}),
          ...(call ? { call } : {}),
          ...(str(input_.description) ? { description: str(input_.description) } : {}),
          type: str(input_.subagent_type) ?? DEFAULT_TYPE,
          status: launched ? "running" : out?.status === "completed" || !out?.status ? "done" : "stopped",
          ...(str(out?.outputFile) ? { transcript: str(out?.outputFile) } : {}),
          ...(!launched && text?.trim() ? { last: oneLine(text) } : {}),
        },
      ];
    }
    default:
      return [];
  }
}

const STATUS: Record<string, WorkTodo["status"]> = { pending: "queued", in_progress: "running", completed: "done" };

const dir = (home: string) => join(home, "work");
const file = (home: string, session: string) => join(dir(home), `${session}.json`);

/** A session's work record, or undefined when there is none or it can't be read. */
export function readWork(home: string, session: string): WorkRecord | undefined {
  if (!validSession(session)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file(home, session), "utf8")) as WorkRecord;
    if (v?.session !== session || !Array.isArray(v.todos) || !Array.isArray(v.agents)) return undefined;
    return { ...v, pending: Array.isArray(v.pending) ? v.pending : [] };
  } catch {
    return undefined;
  }
}

/** A session's transcript: the one its hooks named while it exists, else the one Claude Code's folder holds for it. */
export const sessionTranscript = (r: Pick<WorkRecord, "session" | "transcript">) =>
  r.transcript && existsSync(r.transcript) ? r.transcript : transcriptOf(r.session);

/** How many Agent calls a session keeps waiting for their subagents, and for how long. */
const PENDING_MAX = 20,
  DELETED_MAX = 200,
  PENDING_MS = 10 * 60_000,
  RESUME_MS = 5_000;

/**
 * The todos a TodoWrite added, without a source yet: those past as many with their text as the list
 * had before it, so a new todo with an old one's text counts too.
 */
function addedByText(todos: WorkTodo[], before: string[]): WorkTodo[] {
  const left = new Map<string, number>();
  for (const text of before) left.set(text, (left.get(text) ?? 0) + 1);
  return todos.filter((t) => {
    const n = left.get(t.text) ?? 0;
    left.set(t.text, n - 1);
    return n <= 0 && !t.source;
  });
}

/** Applies one event to a record, in place. */
export function applyEvent(r: WorkRecord, e: WorkEvent, now: string, sessionTranscript?: string) {
  applyOne(r, e, now, sessionTranscript);
  if (e.kind === "todos" || e.kind === "todo") syncQueue(r);
}

/** The person's queue kept to the record's todos: deleted ones leave it, new ones join at the end. */
function syncQueue(r: WorkRecord) {
  if (r.queue === undefined) return;
  if (!hasQueue(r)) {
    delete r.queue;
    return;
  }
  const ids = new Set(r.todos.map((t) => t.id));
  const kept = [...new Set(r.queue.filter((id) => ids.has(id)))];
  const known = new Set(kept);
  r.queue = [...kept, ...r.todos.filter((t) => !known.has(t.id)).map((t) => t.id)];
}

/** Whether the person set an order: a list of todo IDs. Anything else in the record counts as none. */
export const hasQueue = (r: Pick<WorkRecord, "queue">): r is { queue: string[] } => Array.isArray(r.queue) && r.queue.every((id) => typeof id === "string");

/** The todos in the person's order when they set one, else in the agent's. */
export function ordered(r: Pick<WorkRecord, "todos" | "queue">): WorkTodo[] {
  if (!hasQueue(r)) return [...r.todos];
  const at = new Map<unknown, number>();
  r.queue.forEach((id, n) => at.has(id) || at.set(id, n));
  const end = r.queue.length;
  return r.todos
    .map((t, n) => ({ t, k: at.get(t.id) ?? end + n }))
    .sort((a, b) => a.k - b.k)
    .map(({ t }) => t);
}

/** Whether a person removed the todo and the removal is still open. */
export const removedTodo = (r: Pick<WorkRecord, "changes">, id: string) => (r.changes ?? []).some((c) => c.kind === "remove" && c.todo === id && isOpen(c));

/** Whether a person parked the todo. */
export const parkedTodo = (r: Pick<WorkRecord, "parked">, id: string) => Array.isArray(r.parked) && r.parked.includes(id);

/** Whether a todo is in the person's queue: queued, and neither removed nor parked. */
export const inQueue = (r: WorkRecord, t: WorkTodo) => t.status === "queued" && !removedTodo(r, t.id) && !parkedTodo(r, t.id);

/** The todo the person put first: the first queued todo in their order, or undefined when they set none. */
export function firstQueued(r: WorkRecord): WorkTodo | undefined {
  if (!hasQueue(r)) return undefined;
  return ordered(r).find((t) => inQueue(r, t));
}

/**
 * Moves a todo before or after another in the person's order, in place, starting the order from what
 * the page shows when there is none. Returns its place among the queued todos before and after.
 */
export function moveInQueue(r: WorkRecord, id: string, where: "before" | "after", other: string): { from: number; to: number } {
  const queued = () =>
    ordered(r)
      .filter((t) => inQueue(r, t))
      .map((t) => t.id);
  const from = queued().indexOf(id);
  const ids = ordered(r)
    .map((t) => t.id)
    .filter((x) => x !== id);
  const at = ids.indexOf(other);
  ids.splice(where === "before" ? at : at + 1, 0, id);
  r.queue = ids;
  return { from, to: queued().indexOf(id) };
}

function applyOne(r: WorkRecord, e: WorkEvent, now: string, sessionTranscript?: string) {
  // A hook after its end means the session was resumed; one within RESUME_MS is an async hook that ran late.
  if (e.kind !== "session-end" && r.ended && Date.parse(now) - Date.parse(r.ended) >= RESUME_MS) delete r.ended;
  // A subagent's transcript sits beside its session's: `<folder>/<session>/subagents/agent-<id>.jsonl`.
  const agentTranscript = (id: string) => (sessionTranscript ? join(dirname(sessionTranscript), r.session, "subagents", `agent-${id}.jsonl`) : undefined);
  switch (e.kind) {
    case "todos": {
      const known = new Map(r.todos.map((t) => [t.id, t]));
      const claimed = new Set<WorkTodo>();
      r.deleted = [];
      r.todos = e.todos.flatMap((t, n) => {
        if (t.status === "deleted") return [];
        const id = t.id ?? String(n + 1);
        const was = known.get(id);
        const status = STATUS[t.status] ?? "queued";
        const same = was && was.text === t.text && was.status === status;
        const blocked = t.blocked_by ?? was?.blocked_by;
        // A legacy list has no IDs, only places: a todo keeps its source by its text, each old todo's
        // once, so a new todo with an old one's text gets its own; a todo renamed in its place keeps it.
        const byText = t.id ? undefined : [...known.values()].find((k) => k.text === t.text && !claimed.has(k));
        if (byText) claimed.add(byText);
        const renamed = !t.id && !byText && was && !e.todos.some((x) => x.text === was.text) ? was : undefined;
        const source = t.id ? was?.source : (byText ?? renamed)?.source;
        return [
          {
            id,
            text: t.text,
            ...(t.active ? { active: t.active } : {}),
            ...(was?.description ? { description: was.description } : {}),
            status,
            order: /^\d{1,9}$/.test(id) ? Number(id) : n + 1,
            updated: same ? was.updated : now,
            since: was?.status === status ? (was.since ?? was.updated) : now,
            ...((was?.started ?? (status === "running" ? now : undefined)) ? { started: was?.started ?? now } : {}),
            ...((was ? was.created : now) ? { created: was ? was.created : now } : {}),
            ...(blocked?.length ? { blocked_by: blocked } : {}),
            ...(source ? { source } : {}),
            history: withState(was?.history, status, was?.status === status ? (was.since ?? was.updated) : now),
          },
        ];
      });
      r.todos.sort((a, b) => a.order - b.order);
      return;
    }
    case "todo": {
      // Async hooks may arrive out of order: a deleted task stays deleted, a creation never undoes a
      // later update, and an update before its creation shows the task by number until its text comes.
      const at = r.todos.findIndex((t) => t.id === e.id);
      if (e.status === "deleted") {
        if (at >= 0) r.todos.splice(at, 1);
        r.deleted = [...(r.deleted ?? []).filter((d) => d !== e.id), e.id].slice(-DELETED_MAX);
        return;
      }
      if (r.deleted?.includes(e.id)) return;
      const was = r.todos[at];
      const status = e.status && !(was && e.created) ? (STATUS[e.status] ?? was?.status ?? "queued") : (was?.status ?? "queued");
      const active = e.active ?? was?.active;
      // A creation that arrives after an update keeps the update's description.
      const description = (e.created && was ? was.description : undefined) ?? e.description ?? was?.description;
      const blocked = [...new Set([...(was?.blocked_by ?? []), ...(e.blocked_by ?? [])])];
      const todo: WorkTodo = {
        id: e.id,
        text: e.text ?? was?.text ?? `Task #${e.id}`,
        ...(active ? { active } : {}),
        ...(description?.trim() ? { description } : {}),
        status,
        order: was?.order ?? (/^\d{1,9}$/.test(e.id) ? Number(e.id) : Math.max(0, ...r.todos.map((t) => t.order)) + 1),
        updated: now,
        since: was?.status === status ? (was.since ?? was.updated) : now,
        ...((was?.started ?? (status === "running" ? now : undefined)) ? { started: was?.started ?? now } : {}),
        ...((was ? was.created : now) ? { created: was ? was.created : now } : {}),
        ...(blocked.length ? { blocked_by: blocked } : {}),
        ...(was?.source ? { source: was.source } : {}),
        history: withState(was?.history, status, was?.status === status ? (was.since ?? was.updated) : now),
      };
      if (was) r.todos[at] = todo;
      else r.todos.push(todo);
      for (const other of r.todos.filter((x) => e.blocks?.includes(x.id) && x.id !== e.id))
        other.blocked_by = [...new Set([...(other.blocked_by ?? []), e.id])];
      r.todos.sort((a, b) => a.order - b.order);
      return;
    }
    case "call": {
      // Async hooks may run out of order: a subagent that started first takes its call now.
      const early = r.agents.find((a) => !a.call && !a.description && a.type === e.type && Date.parse(now) - Date.parse(a.started) < PENDING_MS);
      if (early) {
        early.call = e.call;
        if (e.description) early.description = e.description;
        return;
      }
      r.pending = [
        ...r.pending.filter((p) => p.call !== e.call && Date.parse(now) - Date.parse(p.at) < PENDING_MS),
        { call: e.call, type: e.type, at: now, ...(e.description ? { description: e.description } : {}) },
      ].slice(-PENDING_MAX);
      return;
    }
    case "agent-start": {
      // A subagent's start names no description, so it takes the oldest Agent call of its type that has none yet.
      const p = r.pending.findIndex((c) => !e.type || c.type === e.type);
      const pending = p >= 0 ? r.pending.splice(p, 1)[0] : undefined;
      const was = r.agents.find((a) => a.id === e.id);
      // An agent that starts again after it ended (SendMessage resumes it) runs again; a start within
      // RESUME_MS of its end is an async hook that ran late, and leaves it ended.
      const resumed = was?.ended !== undefined && Date.parse(now) - Date.parse(was.ended) >= RESUME_MS;
      if (resumed) delete was.ended;
      const agent: WorkAgent = {
        ...was,
        id: e.id,
        status: resumed ? "running" : (was?.status ?? "running"),
        started: was?.started ?? now,
        ...((e.type ?? pending?.type) ? { type: e.type ?? pending?.type } : {}),
        ...((was?.description ?? pending?.description) ? { description: was?.description ?? pending?.description } : {}),
        ...(pending ? { call: pending.call } : {}),
      };
      const transcript = e.transcript ?? was?.transcript ?? agentTranscript(e.id);
      if (transcript) agent.transcript = transcript;
      if (was) Object.assign(was, agent);
      else r.agents.push(agent);
      return;
    }
    case "turn-end":
      r.turn_ended = now;
      return;
    case "session-end":
      // Its subagents ended with it: one hoop still saw running stops now.
      r.ended = now;
      for (const a of r.agents)
        if (a.status === "running") {
          a.status = "stopped";
          a.ended = now;
        }
      return;
    case "agent-end": {
      let a = r.agents.find((x) => (e.id && x.id === e.id) || (e.call && x.call === e.call));
      if (!a && !e.id) return;
      if (!a) {
        // An agent hoop didn't see start (its hook was off, or an Agent result came first).
        const p = e.call ? r.pending.findIndex((c) => c.call === e.call) : -1;
        const pending = p >= 0 ? r.pending.splice(p, 1)[0] : undefined;
        a = { id: e.id!, status: "running", started: pending?.at ?? now };
        r.agents.push(a);
      }
      if (e.call) a.call = e.call;
      if (e.description) a.description = e.description;
      if (e.type && !a.type) a.type = e.type;
      if (e.last) a.last = e.last;
      const transcript = e.transcript && !e.transcript.endsWith(".output") ? e.transcript : undefined;
      if (transcript) a.transcript = transcript;
      else if (!a.transcript && e.id) a.transcript = agentTranscript(e.id);
      // A finished or stopped agent stays so: a background agent's launch result can arrive after its end.
      if (a.status === "running" && e.status !== "running") {
        a.status = e.status;
        a.ended = now;
      }
      return;
    }
  }
}

/** Whether a change may still reach the agent or be overridden. */
export const isOpen = (c: WorkChange) => c.delivery !== "seen" && c.delivery !== "overridden" && c.delivery !== "withdrawn";

/** A todo's subject as an add compares it: case, spaces and punctuation aside. */
export const sameSubject = (a: string, b: string) => {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return norm(a) === norm(b);
};

/** The todo an add became: one with its subject that appeared after it, not done. */
export const addedTodo = (r: Pick<WorkRecord, "todos">, c: WorkChange) =>
  r.todos.find((t) => t.created !== undefined && t.created >= c.at && t.status !== "done" && sameSubject(t.text, c.text!));

/** Whether a todo reads as an edit asked: its new subject, and its new description when the edit changed it. */
export const editTaken = (t: Pick<WorkTodo, "text" | "description">, c: WorkChange) =>
  t.text === c.text && (c.description === undefined || (t.description ?? "").trim() === c.description);

/** A move as the order it asks for: `first` before `second`. */
export const moveOrder = (c: WorkChange) => (c.before ? { first: c.todo!, second: c.before } : { first: c.after!, second: c.todo! });

/**
 * Marks each open change seen or overridden from the session's todos and agents as the hooks last saw
 * them, in place: a removed todo deleted is seen and one started is overridden; an edit is seen once
 * the todo reads the new text or the gate told the agent, and overridden if the todo started without
 * either (a running todo's, if it was done without it); a move is seen when its first todo starts
 * first; a comment on a todo once the todo moves on or the gate told the agent; a stop once the agent
 * stopped or the gate refused it; an add once a todo with its subject appears, which it then names; a
 * park once unparked, and overridden if the todo starts; an unpark once the todo starts.
 */
export function settle(r: WorkRecord, now: string) {
  const todo = (id?: string) => r.todos.find((t) => t.id === id);
  const started = (t?: WorkTodo) => t?.status === "running" || t?.status === "done";
  for (const c of r.changes ?? []) {
    if (!isOpen(c)) continue;
    let to: Delivery | undefined;
    if (c.kind === "remove") {
      const t = todo(c.todo);
      to = !t ? "seen" : started(t) ? "overridden" : undefined;
    } else if (c.kind === "edit") {
      const t = todo(c.todo);
      // A running todo's edit is overridden once the todo is done without it.
      const went = c.was === "running" ? t?.status === "done" : started(t);
      to = !t || editTaken(t, c) || c.gated_at ? "seen" : went ? "overridden" : undefined;
    } else if (c.kind === "add") {
      // Told by message or by the gate, it stays open until the todo appears.
      const t = c.todo ? todo(c.todo) : addedTodo(r, c);
      if (t) c.todo = t.id;
      to = t ? "seen" : undefined;
    } else if (c.kind === "withdraw") {
      const add = (r.changes ?? []).find((x) => x.id === c.of);
      // The agent created it anyway, after it was taken back.
      to = add && addedTodo(r, add) ? "overridden" : undefined;
    } else if (c.kind === "park") {
      const t = todo(c.todo);
      // A park holds while the todo stays parked; starting it anyway, after the gate said so, overrides it.
      to = started(t) ? "overridden" : !t || !parkedTodo(r, c.todo!) ? "seen" : undefined;
    } else if (c.kind === "unpark") {
      const t = todo(c.todo);
      to = !t || started(t) ? "seen" : undefined;
    } else if (c.kind === "move") {
      const { first, second } = moveOrder(c);
      const a = todo(first),
        b = todo(second);
      // A park of its first todo since stands in for it.
      to = parkedTodo(r, first)
        ? "seen"
        : started(b) && a?.status === "queued"
          ? c.gated_at
            ? "seen"
            : "overridden"
          : started(a) || !a || !b
            ? "seen"
            : undefined;
    } else if (c.kind === "comment" && c.request) {
      // A request the agent was asked to register is seen once a todo comes from it.
      if (c.gated_at || r.todos.some((t) => requestOf(t, r.changes ?? []) === c.request)) to = "seen";
    } else if (c.kind === "comment") {
      if (c.gated_at) to = "seen";
      else if (c.todo) {
        const t = todo(c.todo);
        to = !t || t.status !== c.was || t.text !== c.subject ? "seen" : undefined;
      }
    } else if (c.kind === "stop") {
      const a = r.agents.find((x) => x.id === c.agent);
      to = a?.status !== "running" || c.gated_at ? "seen" : undefined;
    }
    if (to) {
      c.delivery = to;
      c.settled_at = now;
    }
  }
  // A parked todo that started, or left the list, is parked no more.
  if (r.parked !== undefined) {
    const kept = Array.isArray(r.parked) ? r.parked.filter((id) => todo(id)?.status === "queued") : [];
    if (kept.length) r.parked = kept;
    else delete r.parked;
  }
}

/** How many changes a record keeps besides its stops, which it keeps for good so a stopped agent stays stopped. */
const CHANGES_MAX = 200;

/**
 * The gate's small files beside a record, which its shell script reads before it starts hoop:
 * `<session>.gate` exists while a change may stop a todo tool call, `<session>.agents` lists each
 * agent the gate must act on as `id<TAB>stop|note<TAB>person` lines, and `<session>.order` names the
 * todo the person put first, while they have set an order.
 */
function writeGateFiles(home: string, r: WorkRecord) {
  const changes = r.changes ?? [];
  const gate = changes.filter(
    (c) =>
      isOpen(c) &&
      c.todo &&
      (c.kind === "remove" ||
        ((c.kind === "edit" || c.kind === "park") && !c.gated_at) ||
        ((c.kind === "move" || c.kind === "comment") && c.delivery === "waiting" && !c.gated_at)),
  );
  // An add the session never got by message is told at its next todo tool call.
  gate.push(...changes.filter((c) => (c.kind === "add" || c.kind === "withdraw" || c.request) && c.delivery === "waiting" && !c.gated_at));
  const agents = changes.filter((c) => c.agent && (c.kind === "stop" || (c.kind === "comment" && c.delivery === "waiting" && !c.gated_at)));
  const base = file(home, r.session).slice(0, -".json".length);
  const put = (path: string, text: string) => {
    if (text) writeAtomic(path, text);
    else if (existsSync(path)) rmSync(path, { force: true });
  };
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ");
  put(`${base}.gate`, gate.map((c) => `${c.id}\n`).join(""));
  put(`${base}.agents`, agents.map((c) => `${c.agent}\t${c.kind === "stop" ? "stop" : "note"}\t${clean(c.by)}\n`).join(""));
  const first = firstQueued(r);
  put(`${base}.order`, first ? `${first.id}\n` : "");
}

/** Writes a record and its gate files. */
function saveWork(home: string, r: WorkRecord) {
  if (r.changes && r.changes.length > CHANGES_MAX) {
    const drop = r.changes.length - CHANGES_MAX;
    let n = 0;
    r.changes = r.changes.filter((c) => c.kind === "stop" || isOpen(c) || n++ >= drop);
  }
  writeAtomic(file(home, r.session), `${JSON.stringify(r, null, 2)}\n`);
  writeGateFiles(home, r);
}

/**
 * Runs `fn` on a session's record, and saves the record when `fn` changed it. Returns
 * undefined when the session has no record.
 */
export function editWork<T>(home: string, session: string, fn: (r: WorkRecord) => T): T | undefined {
  if (!validSession(session)) return undefined;
  mkdirSync(dir(home), { recursive: true });
  const r = readWork(home, session);
  if (!r) return undefined;
  const before = JSON.stringify(r);
  const out = fn(r);
  if (JSON.stringify(r) !== before) saveWork(home, r);
  return out;
}

/**
 * Runs the work hook on one Claude Code hook input: updates the session's work record. Never throws,
 * and writes nothing for an input that holds no work.
 */
export function workHook(home: string, input: unknown, now = new Date().toISOString()): WorkRecord | undefined {
  try {
    const events = workEvents(input);
    const i = obj(input);
    const session = validSession(i?.session_id);
    if (!events.length || !session) return undefined;
    // A turn or a session that ends changes only a session with work.
    if (events.every((e) => e.kind === "turn-end" || e.kind === "session-end") && !readWork(home, session)) return undefined;
    mkdirSync(dir(home), { recursive: true });
    const r: WorkRecord = readWork(home, session) ?? { session, updated: now, todos: [], agents: [], pending: [] };
    const transcript = str(i?.transcript_path);
    if (str(i?.cwd)) r.cwd = str(i?.cwd);
    if (transcript) r.transcript = transcript;
    const texts = r.todos.map((t) => t.text);
    for (const e of events) applyEvent(r, e, now, r.transcript);
    // A todo the agent creates takes the request of the turn it was created in, once: TaskCreate's by
    // its ID (an update that came first may have made it already), TodoWrite's by text, since its
    // list has no IDs. TaskList and TaskGet only list todos that already were.
    r.sources_from ??= now;
    const tool = i?.tool_name;
    const created =
      tool === "TaskCreate"
        ? r.todos.filter((t) => !t.source && events.some((e) => e.kind === "todo" && e.created && e.id === t.id))
        : tool === "TodoWrite"
          ? addedByText(r.todos, texts)
          : [];
    // A subagent's hook gives its session's prompt ID, so its todos take the main turn's request.
    const source = created.length ? sourceOf(sessionTranscript(r), str(i?.prompt_id), now) : undefined;
    if (source) for (const t of created) t.source = source;
    settle(r, now);
    r.updated = now;
    saveWork(home, r);
    return r;
  } catch {
    return undefined;
  }
}

/** A Claude Code session as `<claude dir>/sessions/<pid>.json` describes it. */
export type ClaudeSession = {
  session: string;
  pid: number;
  status?: string;
  name?: string;
  cwd?: string;
  updatedAt?: number;
  /** The Unix socket the session takes messages on (`messagingSocketPath`), when it has one. */
  socket?: string;
  /** When its process started (`procStart`), which stays the same while the session ID changes. */
  start?: string;
};
/** Reads the Claude Code sessions running now. Injectable, so tests need no real Claude Code. */
export type SessionReader = () => ClaudeSession[];

/** Whether a process runs (one owned by another user counts). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * When `procStart` says a process started, in milliseconds: Claude Code writes it as `ps -o lstart`
 * prints it in UTC ("Fri Oct 23 17:11:53 2026"), and local time is allowed for too. Empty when it
 * can't be read.
 */
export function procStartTimes(text: string): number[] {
  return [Date.parse(`${text} UTC`), Date.parse(text)].filter((t) => Number.isFinite(t));
}

/** How long a process's start, checked against its `procStart`, is trusted before `ps` is asked again. */
const START_CHECK_MS = 30_000;
const startChecks = new Map<string, { at: number; ok: boolean }>();

/**
 * The sessions whose process started when their file says (`procStart`), so a file left by a killed
 * process doesn't count once its process ID is reused. A session without a readable `procStart`, or
 * when `ps` can't say, is kept as it was.
 */
function startedWhenRecorded(sessions: ClaudeSession[], now = Date.now()): ClaudeSession[] {
  const key = (s: ClaudeSession) => `${s.pid}:${s.start}`;
  const unchecked = sessions.filter((s) => {
    if (!s.start || !procStartTimes(s.start).length) return false;
    const c = startChecks.get(key(s));
    return !c || now - c.at > START_CHECK_MS;
  });
  if (unchecked.length) {
    const { ran, starts } = processStarts(unchecked.map((s) => s.pid));
    if (ran)
      for (const s of unchecked) {
        const started = starts.get(s.pid);
        const ok = started !== undefined && procStartTimes(s.start!).some((t) => Math.abs(t - started) <= START_MARGIN_MS);
        startChecks.set(key(s), { at: now, ok });
      }
  }
  return sessions.filter((s) => startChecks.get(key(s))?.ok !== false);
}

/**
 * The running Claude Code sessions, from `<claude dir>/sessions/<pid>.json`, skipping files whose
 * process is gone or started at another time than the file says.
 */
export const claudeSessions: SessionReader = () => {
  const folder = join(claudeDir(), "sessions");
  let names: string[];
  try {
    names = readdirSync(folder).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  return startedWhenRecorded(readSessionFiles(folder, names));
};

function readSessionFiles(folder: string, names: string[]): ClaudeSession[] {
  return names.flatMap((n) => {
    try {
      const v = JSON.parse(readFileSync(join(folder, n), "utf8"));
      const session = validSession(v?.sessionId);
      const pid = Number(v?.pid);
      if (!session || !Number.isInteger(pid) || pid <= 0 || !alive(pid)) return [];
      return [
        {
          session,
          pid,
          ...(typeof v.status === "string" ? { status: v.status } : {}),
          ...(typeof v.name === "string" && v.name.trim() ? { name: v.name.trim() } : {}),
          ...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
          ...(typeof v.updatedAt === "number" ? { updatedAt: v.updatedAt } : {}),
          ...(typeof v.messagingSocketPath === "string" && v.messagingSocketPath ? { socket: v.messagingSocketPath } : {}),
          ...(typeof v.procStart === "string" && v.procStart ? { start: v.procStart } : {}),
        },
      ];
    } catch {
      return [];
    }
  });
}

/** The Claude Code process a running session runs in, for its owner record, or undefined. */
export function processOf(session: string, sessions: SessionReader = claudeSessions): OwnerProcess | undefined {
  try {
    const s = sessions().find((x) => x.session === session);
    return s?.start ? { pid: s.pid, start: s.start } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The running Claude Code session of an owner: the one with its session ID, else the one now running
 * in the process it ran in. `/clear` gives a running process a new session ID; the process ID and its
 * start time stay, and a reused process ID starts at another time.
 */
export function ownerSession(owner: Pick<Owner, "session" | "process">, sessions: ClaudeSession[]): ClaudeSession | undefined {
  const p = owner.process;
  return sessions.find((s) => s.session === owner.session) ?? (p ? sessions.find((s) => s.pid === p.pid && s.start === p.start) : undefined);
}

/**
 * Whether `session` acts as `owner`: it is the owner's session, or the Claude Code session running
 * now in the process the owner record names, as after `/clear`. The caller's process is looked up in
 * Claude Code's session files, never taken from the caller.
 */
export function actsAs(owner: Owner | undefined, session: string | null | undefined, sessions: SessionReader = claudeSessions): boolean {
  if (!owner || !session) return false;
  if (owner.session === session) return true;
  const p = owner.claude === false ? undefined : owner.process;
  if (!p) return false;
  const now = processOf(session, sessions);
  return Boolean(now && now.pid === p.pid && now.start === p.start);
}

/** How much of a subagent's transcript is read for its last step. */
const STEP_BYTES = 64 * 1024;
const steps = new Map<string, { key: string; step?: string }>();

/** The last thing a subagent did, from the end of its transcript: its last tool call, else its last text. */
export function lastStep(path: string): string | undefined {
  let key: string;
  try {
    const st = statSync(path);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return undefined;
  }
  const cached = steps.get(path);
  if (cached?.key === key) return cached.step;
  let step: string | undefined;
  try {
    const fd = openSync(path, "r");
    let text: string;
    try {
      const size = statSync(path).size;
      const start = Math.max(0, size - STEP_BYTES);
      const buf = Buffer.alloc(size - start);
      const n = readSync(fd, buf, 0, buf.length, start);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
    for (const line of text.split("\n").reverse()) {
      if (!line.includes('"assistant"')) continue;
      let v: { type?: string; message?: { content?: unknown } };
      try {
        v = JSON.parse(line);
      } catch {
        continue;
      }
      if (v.type !== "assistant" || !Array.isArray(v.message?.content)) continue;
      const parts = v.message.content as { type?: string; name?: string; input?: Obj; text?: string }[];
      const use = [...parts].reverse().find((p) => p.type === "tool_use" && p.name);
      if (use) {
        const what = str(use.input?.description) ?? str(use.input?.command) ?? str(use.input?.file_path) ?? str(use.input?.pattern) ?? str(use.input?.url);
        step = oneLine(what ? `${use.name}: ${what}` : use.name!);
        break;
      }
      const said = [...parts].reverse().find((p) => p.type === "text" && str(p.text));
      if (said) {
        step = oneLine(said.text!);
        break;
      }
    }
  } catch {
    /* unreadable */
  }
  steps.set(path, { key, step });
  return step;
}

/** A session on the Work page. `state` is busy or idle while it runs, and ended once its process is gone. */
export type WorkSession = {
  id: string;
  name?: string;
  state: "busy" | "idle" | "ended";
  folder?: string;
  updated: string;
  /** Whether the session takes messages now: it runs and has a messaging socket. */
  reachable: boolean;
  /** In the person's order once they moved one, else the agent's. */
  todos: WorkTodo[];
  /** The todos the person parked. */
  parked: string[];
  agents: ViewAgent[];
  changes: WorkChange[];
  /** The session's last sign of life: its transcript's newest entry, when it can be read. */
  activity?: string;
  /** What it does now, while it runs: its running tool call (`open`), else its latest one. */
  doing?: Doing;
  /** When its latest turn ended, and when it ended, as its hooks said. */
  turn_ended?: string;
  ended?: string;
  /** Its tool calls in the last five minutes, newest first, at most ten. */
  recent?: Omit<Step, "tool">[];
  /** What the person asked for, oldest first, with the todos each became. */
  requests?: ViewRequest[];
};

/**
 * A request on the Work page: the todos that came from it, and whether it's `unregistered`, a prompt
 * no todo came from that the person hasn't dismissed, made once hoop recorded sources and answered.
 */
export type ViewRequest = Request & { todos: string[]; dismissed?: true; unregistered?: true; title?: string };

/**
 * The request a todo came from: its source's, or, for a todo from a Work-page message that asked the
 * agent to register an earlier request, that request.
 */
export function requestOf(t: WorkTodo, changes: WorkChange[]): string | undefined {
  const s = t.source;
  if (!s || s.kind === "agent") return undefined;
  return (s.ref && changes.find((c) => c.ref === s.ref && c.request)?.request) || s.request;
}

/** How many requests the Work page lists for a session, the latest ones, and how many dismissals a record keeps. */
export const REQUESTS_SHOWN = 30,
  DISMISSED_MAX = 500;

/** Words a question starts with, asked with or without its question mark. */
const QUESTION = /^(?:what|how|is|are|did|can|why|should|do|does)\b/i;

/**
 * Whether a prompt reads as asking for work no todo came from: its turn edited files and neither
 * created nor updated a todo, and it is no question or short reply ("thanks", "yes").
 */
export const asksForWork = (q: Pick<Request, "text" | "changed" | "created">) => {
  const text = q.text.trim();
  return Boolean(q.changed && !q.created) && !text.endsWith("?") && !QUESTION.test(text) && text.split(/\s+/).length >= 5;
};

/** A session's latest requests with the todos each became, from its transcript; none when it can't be read. */
export function viewRequests(r: WorkRecord, transcript: string | undefined, state: WorkSession["state"]): ViewRequest[] {
  const scan = transcript ? transcriptRequests(transcript) : undefined;
  if (!scan) return [];
  const all = scan.requests.slice(-REQUESTS_SHOWN);
  const dismissed = new Set(Array.isArray(r.dismissed) ? r.dismissed : []);
  return all.map((q, n) => {
    const todos = r.todos.filter((t) => requestOf(t, r.changes ?? []) === q.id).map((t) => t.id);
    // The latest request of a busy session is still being worked on.
    const answered = n < all.length - 1 || state !== "busy";
    const open = q.kind === "prompt" && asksForWork(q) && !todos.length && answered && Boolean(r.sources_from && q.at >= r.sources_from);
    return { ...q, todos, ...(dismissed.has(q.id) ? { dismissed: true as const } : open ? { unregistered: true as const } : {}) };
  });
}

/**
 * A subagent on the Work page: `activity` is its transcript's last sign of life, `doing` its running
 * tool call. In plain words, `step` is what it does now, `outcome` what its report says it came to,
 * `reason` why it stopped or failed, and `links` the pull requests, issues and reviews its report names.
 */
export type ViewAgent = Omit<WorkAgent, "call" | "status"> & {
  status: WorkAgent["status"] | "failed";
  activity?: string;
  doing?: Doing;
  step?: string;
  outcome?: string;
  reason?: string;
  links?: AgentLink[];
};

/** One line on what a session or subagent does, since `at`; `open` while that call still runs. */
export type Doing = {
  what: string;
  at: string;
  open: boolean;
  /** While the call waits on the person: a hoop review or ask (`review`), or AskUserQuestion (`question`). */
  waiting?: "review" | "question";
};

/** What an open call does, as a Doing. */
const openDoing = (step: Step): Doing => {
  const waiting = waitsOn(step.tool);
  return { what: asRunning(step.what), at: step.at, open: true, ...(waiting ? { waiting } : {}) };
};

/** A step's words while it still runs: a subagent started is a subagent running. */
const asRunning = (what: string) => what.replace(/^started a subagent/, "a subagent is running");

/**
 * What a session does now, from its transcript's activity: its running tool call, else its latest
 * one while it is busy; an idle session with a subagent running says so. Nothing for an idle or
 * ended session otherwise.
 */
export function doingNow(
  state: WorkSession["state"],
  a: Activity | undefined,
  agents: Pick<ViewAgent, "status" | "description" | "started">[],
): Doing | undefined {
  const live = agents.filter((x) => x.status === "running");
  const agentLine = (): Doing | undefined => {
    if (!live.length) return undefined;
    const first = live[0]!;
    const what = live.length > 1 ? `${live.length} subagents are running` : `a subagent is running${first.description ? `: ${first.description}` : ""}`;
    return { what, at: first.started, open: true };
  };
  if (state === "ended") return undefined;
  if (state === "idle") return agentLine();
  if (a?.open) return openDoing(a.open);
  const latest = a?.steps[a.steps.length - 1];
  return latest ? { what: latest.what, at: latest.at, open: false } : agentLine();
}

/** A session's queued todos in the order the Work view shows, for the agent; none when it has no work. */
export function workQueue(home: string, session: string) {
  const r = readWork(home, session);
  const todos = r
    ? ordered(r)
        .filter((t) => inQueue(r, t))
        .map((t) => ({ id: t.id, text: t.text, ...(t.description ? { description: t.description } : {}) }))
    : [];
  const parked = r ? ordered(r).filter((t) => t.status === "queued" && parkedTodo(r, t.id) && !removedTodo(r, t.id)) : [];
  return {
    session,
    person_order: Boolean(r && hasQueue(r)),
    todos,
    ...(parked.length
      ? {
          parked: parked.map((t) => ({ id: t.id, text: t.text })),
          parked_note: "The person parked these: keep them in your list, but don't start one until they unpark it.",
        }
      : {}),
  };
}

/** A hoop review page link, on this machine: `http://localhost:4747/r/<review ID>`. */
export const REVIEW_LINK = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/r\/(rv_[a-z0-9]+)\/?$/;
const LINKS = /https?:\/\/[^\s<>()\]]+/g;

/** What the Work API knows of reviews and pull requests, to link todos to them. */
export type Evidence = {
  /** A review by ID: its title, status (as `reviewStatus` gives it), when its latest revision came, and when it was approved. */
  review: (id: string) => { title?: string; status: string; at: string; approved_at?: string } | undefined;
  /** A pull request's state as last read, or undefined when it isn't known yet. */
  pr: (url: string) => PrState | undefined;
  /** The pull requests each session opened, and when. */
  tracked: { url: string; session: string; added: string }[];
};

/** How long after an ended session's last sign of life its work still counts, and its pull requests are read. */
export const ENDED_MS = 60 * 60_000;

const sinceOf = (t: WorkTodo) => t.since ?? t.updated;
/** When a todo started: its first start, else, while it runs, when it was last marked running. */
const startOf = (t: WorkTodo) => t.started ?? (t.status === "running" ? sinceOf(t) : undefined);

/**
 * The view with each todo's linked reviews titled, and each running todo's links: the reviews its
 * description names; the pull requests it names that are open or not read yet (a merged or closed one
 * it names is context, such as what it builds on); and the pull requests its session opened while it
 * was the latest todo started. Pull requests of a session that ended over ENDED_MS ago aren't read.
 */
export function linkTodos(view: WorkSession[], look: Evidence, now = Date.now()): WorkSession[] {
  for (const s of view) {
    const old = s.state === "ended" && !(now - Date.parse(s.activity ?? s.updated) <= ENDED_MS);
    // A pull request the session opened belongs to the todo started last before it, done or not.
    const byStart = s.todos.filter((t) => startOf(t)).sort((a, b) => startOf(a)!.localeCompare(startOf(b)!));
    const opened = new Map<WorkTodo, Set<string>>();
    for (const p of look.tracked.filter((x) => x.session === s.id)) {
      const t = byStart.filter((x) => startOf(x)! <= p.added).at(-1);
      if (t?.status === "running") opened.set(t, (opened.get(t) ?? new Set()).add(p.url));
    }
    for (const t of s.todos) {
      const reviews: Record<string, string> = {};
      const links: TodoLink[] = [];
      const urls = (t.description?.match(LINKS) ?? []).map((u) => u.replace(/[.,;:!?'"*_`]+$/, ""));
      const running = t.status === "running";
      for (const url of urls) {
        const id = url.match(REVIEW_LINK)?.[1];
        const r = id && !reviews[id] ? look.review(id) : undefined;
        if (!id || !r) continue;
        if (r.title) reviews[id] = r.title;
        if (running) links.push({ kind: "review", id, ...r });
      }
      const mine = opened.get(t) ?? new Set<string>();
      if (running && !old)
        for (const url of new Set([...urls.filter((u) => parsePrUrl(u)), ...mine])) {
          const p = look.pr(url);
          const known = p && p.state !== "unknown" && p.state !== "gone";
          if (known && p.state !== "open" && !(p.state === "merged" && mine.has(url))) continue;
          const extra = known
            ? {
                ...(p.checks ? { checks: p.checks } : {}),
                ...(p.review_requested ? { review_requested: true } : {}),
                ...(p.ready ? { ready: true } : {}),
                ...(p.draft ? { draft: true } : {}),
                ...(p.opened_at ? { opened_at: p.opened_at } : {}),
                ...(p.merged_at ? { merged_at: p.merged_at } : {}),
              }
            : {};
          const state = known ? (p.state as "open" | "merged") : "unknown";
          links.push({ kind: "pr", url, number: parsePrUrl(url)!.number, state, ...(mine.has(url) ? { opened: true as const } : {}), ...extra });
        }
      if (Object.keys(reviews).length) t.reviews = reviews;
      if (links.length) t.links = links;
    }
    for (const q of s.requests ?? []) {
      const title = q.review ? look.review(q.review)?.title : undefined;
      if (title) q.title = title;
    }
  }
  return view;
}

/**
 * An Agent-started subagent as the Work page shows it. A running agent of a session that ended shows
 * as stopped; one whose transcript ends in an API error, as failed.
 */
function viewAgent({ call: _call, ...a }: WorkAgent, meta: AgentMeta | undefined, state: WorkSession["state"], cwd?: string): ViewAgent {
  const description = a.description ?? meta?.description;
  const type = a.type ?? meta?.type;
  const last = (a.status === "running" && a.transcript ? lastStep(a.transcript) : undefined) ?? a.last ?? (a.transcript ? lastStep(a.transcript) : undefined);
  const base = { ...a, ...(description ? { description } : {}), ...(type ? { type } : {}), ...(last ? { last } : {}) };
  if (a.status === "running" && state !== "ended") {
    const own = a.transcript ? transcriptActivity(a.transcript, cwd) : undefined;
    const step = plainStep(own?.open?.what ?? own?.steps[own.steps.length - 1]?.what);
    return {
      ...base,
      ...(own?.last ? { activity: own.last } : {}),
      ...(own?.open ? { doing: openDoing(own.open) } : {}),
      ...(step ? { step } : {}),
    };
  }
  const end = agentEnd(a.transcript);
  const report = end?.report ?? a.last;
  const links = report ? reportLinks(report) : [];
  const outcome = report ? outcomeOf(report) : undefined;
  const linked = links.length ? { links } : {};
  if (end?.error && !end.report) return { ...base, ...linked, status: "failed", reason: failReason(end.error) };
  if (a.status === "done") return { ...base, ...linked, ...(outcome ? { outcome } : {}) };
  const reason =
    a.status === "running" ? "Stopped: its session ended" : end?.interrupted ? "Stopped: the person interrupted it" : "Stopped before it reported back";
  return { ...base, ...linked, status: "stopped", reason, ...(outcome ? { outcome } : {}) };
}

/**
 * The changes as the Work view shows them: each sent one the transcript holds marked `read`, with
 * when, and each it was read whole for but doesn't hold marked `unread`. `fresh` lists those newly
 * read, for the pages process to record.
 */
export function readChanges(changes: WorkChange[], transcript: string | undefined): { changes: WorkChange[]; fresh: WorkChange[] } {
  const sent = changes.filter((c) => c.delivery === "sent" && c.ref && typeof c.sent_offset === "number");
  const reads = sent.length && transcript ? transcriptReads(transcript, Math.min(...sent.map((c) => c.sent_offset!))) : undefined;
  const fresh: WorkChange[] = [];
  const out = changes.map((c): WorkChange => {
    if (!reads || !sent.includes(c)) return c;
    const at = reads[c.ref!];
    if (!at) return { ...c, unread: true };
    const read: WorkChange = { ...c, delivery: "read", read_at: at };
    fresh.push(read);
    return read;
  });
  return { changes: out, fresh };
}

/** The changes each Work view session newly found read, which the pages process records. */
const freshReads = new WeakMap<WorkSession, WorkChange[]>();
export const newlyRead = (s: WorkSession) => freshReads.get(s) ?? [];

/** How many sessions the Work page shows, newest first. */
export const WORK_SESSIONS_MAX = 30;

/**
 * Every session with work, newest first: running ones by their Claude Code record (busy or idle,
 * name, folder), each subagent with its last step. A running subagent of a session that ended shows
 * as stopped.
 */
export function workView(home: string, readSessions: SessionReader = claudeSessions, now = Date.now()): WorkSession[] {
  let names: string[];
  try {
    names = readdirSync(dir(home)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const running = new Map(readSessions().map((s) => [s.session, s]));
  const records = names.flatMap((n) => readWork(home, n.slice(0, -5)) ?? []).filter((r) => r.todos.length || r.agents.length);
  return records
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, WORK_SESSIONS_MAX)
    .map((r) => {
      const live = running.get(r.session);
      const state: WorkSession["state"] = !live || r.ended ? "ended" : live.status === "busy" ? "busy" : "idle";
      const name = sessionName(r.session, home) ?? live?.name;
      const cwd = live?.cwd ?? r.cwd;
      const transcript = sessionTranscript(r);
      const activity = transcript ? transcriptActivity(transcript, cwd) : undefined;
      const lastSeen = activity?.last ?? (live?.updatedAt ? new Date(live.updatedAt).toISOString() : undefined);
      const agents = r.agents.flatMap((a) => {
        const meta = a.description ? undefined : agentMeta(a.transcript);
        return isRealAgent(a, meta) ? [viewAgent(a, meta, state, cwd)] : [];
      });
      const doing = doingNow(state, activity, agents);
      const recent = recentSteps(activity, now).map(({ tool: _tool, ...s }) => s);
      const { changes, fresh } = readChanges(r.changes ?? [], transcript);
      const requests = viewRequests(r, transcript, state);
      const view: WorkSession = {
        id: r.session,
        ...(name ? { name } : {}),
        state,
        ...(cwd ? { folder: basename(cwd) } : {}),
        updated: r.updated,
        reachable: Boolean(live?.socket),
        todos: ordered(r),
        parked: Array.isArray(r.parked) ? r.parked : [],
        changes,
        agents,
        ...(lastSeen ? { activity: lastSeen } : {}),
        ...(doing ? { doing } : {}),
        ...(recent.length ? { recent } : {}),
        ...(requests.length ? { requests } : {}),
        ...(r.turn_ended ? { turn_ended: r.turn_ended } : {}),
        ...(r.ended ? { ended: r.ended } : {}),
      };
      if (fresh.length) freshReads.set(view, fresh);
      return view;
    });
}
