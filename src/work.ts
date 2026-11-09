import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OpenStep } from "./activity.js";
import { type OwnerProcess, transcriptOf, validSession } from "./owner.js";
import { agentMeta } from "./subagents.js";
import { type PrState, trackedPrs } from "./prs.js";
import { type Source, sourceOf } from "./requests.js";
import { tryReadJson, writeAtomic, writeJson, opt } from "./util.js";
import { type ClaudeSession, claudeSessions, type SessionReader } from "./claude-sessions.js";
import { inputDigest, type WorkEvent, workEvents } from "./work-events.js";
import { firstQueued, hasQueue, isOpen, startsAfter, syncQueue, untoldBlocked } from "./work-queue.js";
import { settle, unreadChange } from "./work-settle.js";
import { REVIEW_PATH } from "../web/links.js";
import { hookFields } from "./hook-input.js";
import { toldIn } from "./told.js";

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
  /** Once done past the done gate, what it was done without; the Work API adds it. */
  done_without?: string;
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
 * A todo's history after a hook: as it was when the status stays (a hook repeating it, or an edit to
 * its text, says nothing new, and the states the page read since stand), else with the new status.
 */
function historyOf(was: WorkTodo | undefined, status: WorkTodo["status"], now: string): Pick<WorkTodo, "history"> {
  if (was?.status === status) return was.history ? { history: was.history } : {};
  return { history: withState(was?.history, status, now) };
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
  /** Set while hoop knows the agent only from its stop or result: its first SubagentStart is still to come. */
  unstarted?: true;
  /** Set once SendMessage resumed it after it ended: a late Agent call is a new subagent's, never its own. */
  resumed?: true;
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
  /** Tasks deleted, so a late hook doesn't bring one back; only a whole list that names one again does. */
  deleted?: string[];
  /** Blocks given before the blocked task came, by its ID: the tasks that block it, applied when it comes. */
  blocks?: Record<string, string[]>;
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
  /** The todos each queued todo starts after, by ID, as the person said on the Work page. */
  starts_after?: Record<string, string[]>;
  /** Blocked starts the gate already refused, as `<todo><<blocker>`, so a start the agent goes on with passes. */
  blocked_told?: string[];
  /** The latest permission prompt of the session (MAIN) and of each subagent, by agent ID. */
  prompts?: Record<string, Prompt>;
  /** When hoop began recording sources for this session: a request before then can't be told unregistered. */
  sources_from?: string;
  /** The requests the person said need no todos, by ID. */
  dismissed?: string[];
  /** When the agent's latest turn ended, by the Stop hook. */
  turn_ended?: string;
  /** What the Stop gate already blocked a turn's end for (`src/stop.ts`), so each cause blocks once. */
  stop_told?: string[];
  /** The links the done gate already refused a todo's completion for (`src/done.ts`), as `<todo>:<link>`. */
  done_told?: string[];
  /** The todos completed past the done gate, by ID, with what they were done without. */
  done_without?: Record<string, string>;
  /** When the session ended, by the SessionEnd hook; any later hook means it was resumed. */
  ended?: string;
};

/**
 * A permission prompt for a tool call: the PermissionRequest hook gives its tool and input (kept as a
 * digest per field) and `at`; the Notification hook's `permission_prompt` says a dialog showed
 * (`shown`). PermissionRequest also runs for calls a hook or a headless session decides.
 */
type Prompt = { tool: string; input: Record<string, string>; at: string; shown?: string };

/** The key of the session's own prompts, beside its subagents'. */
export const MAIN = "main";
/** How many prompts a record keeps: the session's and its latest subagents'. */
const PROMPTS_MAX = 20;

/**
 * Whether a permission prompt still waits on the person: its dialog showed, and the call still
 * running (`open`, of the session or of the subagent `agent`) is the one it is for, by tool and
 * input, and started before it. Answering it, either way, gives the call its result, so it no
 * longer runs.
 */
export function prompted(prompts: WorkRecord["prompts"], open: OpenStep | undefined, agent?: string): boolean {
  const p = prompts?.[agent ?? MAIN];
  if (!p?.shown || !open || open.tool !== p.tool || open.at > p.at) return false;
  const call = inputDigest(open.input);
  const shared = Object.keys(p.input).filter((k) => k in call);
  // The hook may pass the input with defaults filled in: the fields both have must agree.
  return (shared.length > 0 || !Object.keys(call).length) && shared.every((k) => call[k] === p.input[k]);
}

/**
 * How a person's change reached the agent: `pending` while it waits to go out with the session's
 * next message, `sent` in one, `read` once the session's transcript shows the message reached the
 * agent, `waiting` for the gate when the session takes no messages, and in the end `seen` (the hooks
 * saw the agent act on it, or the gate told it), `overridden` (it went ahead) or, for an add,
 * `withdrawn` (the person took it back).
 */
export type Delivery = "pending" | "sent" | "read" | "waiting" | "seen" | "overridden" | "withdrawn";

/**
 * One change a person made to a session's work from the Work page, or a `done`: hoop telling the
 * agent that a running todo's evidence says it is done (`text`, such as "PR #12 merged").
 */
export type WorkChange = {
  id: string;
  kind: "remove" | "edit" | "move" | "comment" | "stop" | "add" | "park" | "unpark" | "withdraw" | "done" | "depend";
  /** A withdraw: the add or depend it takes back. */
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
  /** A move: the todo this one now goes before, or after. A depend: the todo it starts after. */
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
  /** A comment: the Claude Code process its session ran in, so the session that took it over after `/clear` may reply. */
  process?: OwnerProcess;
  /** A comment: the agent's replies to it (`hoop_reply`), oldest first. */
  replies?: WorkReply[];
};

/** The agent's reply to a person's comment on the Work page. */
export type WorkReply = { by: string; body: string; at: string };

const STATUS: Record<string, WorkTodo["status"]> = { pending: "queued", in_progress: "running", completed: "done" };

const dir = (home: string) => join(home, "work");
const file = (home: string, session: string) => join(dir(home), `${session}.json`);

/** A session's work record, or undefined when there is none or it can't be read. */
export function readWork(home: string, session: string): WorkRecord | undefined {
  if (!validSession(session)) return undefined;
  const v = tryReadJson<WorkRecord | null>(file(home, session));
  if (v?.session !== session || !Array.isArray(v.todos) || !Array.isArray(v.agents)) return undefined;
  return { ...v, pending: Array.isArray(v.pending) ? v.pending : [] };
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

/** The todos a hook's tool created, without a source yet: TaskCreate's by its ID, TodoWrite's by text (`before`). */
function createdBy(tool: unknown, r: WorkRecord, events: WorkEvent[], before: string[]): WorkTodo[] {
  if (tool === "TaskCreate") return r.todos.filter((t) => !t.source && events.some((e) => e.kind === "todo" && e.created && e.id === t.id));
  return tool === "TodoWrite" ? addedByText(r.todos, before) : [];
}

/** Applies one event to a record, in place. */
function applyEvent(r: WorkRecord, e: WorkEvent, now: string, sessionTranscript?: string) {
  applyOne(r, e, now, sessionTranscript);
  if (e.kind === "todos" || e.kind === "todo") syncQueue(r);
}

function applyOne(r: WorkRecord, e: WorkEvent, now: string, sessionTranscript?: string) {
  // A hook after its end means the session was resumed; one within RESUME_MS is an async hook that ran late.
  if (e.kind !== "session-end" && r.ended && Date.parse(now) - Date.parse(r.ended) >= RESUME_MS) delete r.ended;
  // A subagent's transcript sits beside its session's: `<folder>/<session>/subagents/agent-<id>.jsonl`.
  const agentTranscript = (id: string) => (sessionTranscript ? join(dirname(sessionTranscript), r.session, "subagents", `agent-${id}.jsonl`) : undefined);
  switch (e.kind) {
    case "todos":
      return applyTodos(r, e, now);
    case "todo":
      return applyTodo(r, e, now);
    case "call":
      return applyCall(r, e, now);
    case "agent-start":
      return applyAgentStart(r, e, now, agentTranscript);
    case "turn-end":
      r.turn_ended = now;
      return;
    case "session-end":
      return applySessionEnd(r, now);
    case "prompt": {
      const kept = Object.entries(r.prompts ?? {}).filter(([k]) => k !== (e.agent ?? MAIN));
      r.prompts = Object.fromEntries([...kept.slice(-(PROMPTS_MAX - 1)), [e.agent ?? MAIN, { tool: e.tool, input: e.input, at: now }]]);
      return;
    }
    case "prompt-shown":
      // The notification names no subagent: it shows every prompt of its tool not shown yet.
      for (const p of Object.values(r.prompts ?? {})) if (!p.shown && (!e.tool || e.tool === p.tool)) p.shown = now;
      return;
    case "agent-end":
      return applyAgentEnd(r, e, now, agentTranscript);
  }
}

/** A session's end. Its subagents ended with it: one hoop still saw running stops now. */
function applySessionEnd(r: WorkRecord, now: string) {
  r.ended = now;
  for (const a of r.agents)
    if (a.status === "running") {
      a.status = "stopped";
      a.ended = now;
    }
}

type EventOf<K extends WorkEvent["kind"]> = Extract<WorkEvent, { kind: K }>;
type ListedTodo = EventOf<"todos">["todos"][number];

/** A todo's place from its ID when the ID is a number, as the task tools' are. */
const numbered = (id: string) => (/^\d{1,9}$/.test(id) ? Number(id) : undefined);

/** A todo's times after a hook: when its status last changed, when it first ran, and when hoop first saw it. */
function timesOf(was: WorkTodo | undefined, status: WorkTodo["status"], now: string): Pick<WorkTodo, "since" | "started" | "created"> {
  return {
    since: was?.status === status ? (was.since ?? was.updated) : now,
    ...opt("started", was?.started ?? (status === "running" ? now : undefined)),
    ...opt("created", was ? was.created : now),
  };
}

/** A whole list of todos, from TodoWrite or TaskList, in place of the record's. */
function applyTodos(r: WorkRecord, e: EventOf<"todos">, now: string) {
  const known = new Map(r.todos.map((t) => [t.id, t]));
  const list: TodoList = { r, todos: e.todos, known, claimed: new Set(), moves: new Map(), edited: new Map(), now };
  const legacy = e.todos.every((t) => !t.id);
  if (legacy) claimEdited(list);
  // A task the list names again is back; one it lists as deleted stays deleted.
  const named = new Set(e.todos.flatMap((t) => (t.id && t.status !== "deleted" ? [t.id] : [])));
  const gone = e.todos.flatMap((t) => (t.id && t.status === "deleted" ? [t.id] : []));
  r.deleted = [...(r.deleted ?? []).filter((d) => !named.has(d) && !gone.includes(d)), ...gone].slice(-DELETED_MAX);
  r.todos = e.todos.flatMap((t, n) => (t.status === "deleted" ? [] : [listedTodo(t, n, list)]));
  r.todos.sort((a, b) => a.order - b.order);
  laterBlocks(r, [...named]);
  if (legacy) followMoves(r, list);
}

/**
 * A whole list being applied: the record, the list's todos, the record's todos by ID before it, those
 * a listed todo took, and in a legacy list each taken todo's new ID by its old one (`moves`) and the
 * todos a person's edit names by the listed todo's place in the list (`edited`).
 */
type TodoList = {
  r: WorkRecord;
  todos: ListedTodo[];
  known: Map<string, WorkTodo>;
  claimed: Set<WorkTodo>;
  moves: Map<string, string>;
  edited: Map<number, WorkTodo>;
  now: string;
};

/** A todo of a whole list as the record keeps it, from its earlier self: by ID, or in a legacy list by text. */
function listedTodo(t: ListedTodo, n: number, list: TodoList): WorkTodo {
  const id = t.id ?? String(n + 1);
  const was = t.id ? list.known.get(id) : legacyTodo(t, n, list);
  const status = STATUS[t.status] ?? "queued";
  const same = was && was.text === t.text && was.status === status;
  const blocked = t.blocked_by ?? was?.blocked_by ?? list.r.blocks?.[id];
  return {
    id,
    text: t.text,
    ...opt("active", t.active),
    ...opt("description", was?.description),
    status,
    order: numbered(id) ?? n + 1,
    updated: same ? was.updated : list.now,
    ...timesOf(was, status, list.now),
    ...opt("blocked_by", blocked?.length ? blocked : undefined),
    ...opt("source", was?.source),
    ...historyOf(was, status, list.now),
  };
}

/**
 * A todo's earlier self in a legacy list, which has no IDs, only places: the old todo with its text,
 * each once (`claimed`), so a new todo with an old one's text starts afresh; else the todo in its
 * place renamed, when that one's text left the list and its new text wasn't on it. Any other todo is new.
 */
function legacyTodo(t: ListedTodo, n: number, list: TodoList): WorkTodo | undefined {
  const edited = list.edited.get(n);
  if (edited) return edited;
  const old = [...list.known.values()];
  const byText = old.find((k) => k.text === t.text && !list.claimed.has(k));
  const inPlace = list.known.get(String(n + 1));
  const renamed = inPlace && !list.claimed.has(inPlace) && !list.todos.some((x) => x.text === inPlace.text) && !old.some((k) => k.text === t.text);
  const was = byText ?? (renamed ? inPlace : undefined);
  if (was) claimTodo(list, was, n);
  return was;
}

/** A known todo taken by the listed todo at `n`, which moves it to that place. */
function claimTodo(list: TodoList, was: WorkTodo, n: number) {
  list.claimed.add(was);
  list.moves.set(was.id, String(n + 1));
}

/**
 * Before any other matching, a legacy list's todo with the new text of a person's open edit is the
 * todo edited, wherever it moved: the agent took the edit.
 */
function claimEdited(list: TodoList) {
  const edits = (list.r.changes ?? []).filter((c) => c.kind === "edit" && isOpen(c) && c.text !== c.subject);
  for (const [n, t] of list.todos.entries()) {
    const was = edits.flatMap((c) => (c.text === t.text && c.todo ? (list.known.get(c.todo) ?? []) : [])).find((k) => !list.claimed.has(k));
    if (!was) continue;
    claimTodo(list, was, n);
    list.edited.set(n, was);
  }
}

/**
 * A legacy list's IDs are places, so the person's state on a todo follows it to its new place: its
 * place in the queue, its park, what it starts after, what it was done without, what the gates already
 * told about it, and the changes about it. An open change about a todo that left the list is seen, as
 * when its place is empty.
 */
function followMoves(r: WorkRecord, list: TodoList) {
  const { moves } = list;
  const ids = (xs: string[]) => xs.flatMap((id) => moves.get(id) ?? []);
  const keys = <V>(o: Record<string, V>) => Object.fromEntries(Object.entries(o).flatMap(([id, v]) => (moves.has(id) ? [[moves.get(id)!, v]] : [])));
  if (hasQueue(r)) r.queue = ids(r.queue);
  if (Array.isArray(r.parked)) r.parked = ids(r.parked);
  if (r.starts_after) r.starts_after = keys(Object.fromEntries(Object.keys(r.starts_after).map((id) => [id, ids(startsAfter(r, id))])));
  if (r.done_without) r.done_without = keys(r.done_without);
  // A told pair names the same two todos after the move; one about a todo that left is forgotten.
  const pairs = (told: string[], sep: string) =>
    told.flatMap((k) => {
      const [a = "", b = ""] = k.split(sep);
      return moves.has(a) && moves.has(b) ? [`${moves.get(a)}${sep}${moves.get(b)}`] : [];
    });
  if (Array.isArray(r.queue_told)) r.queue_told = pairs(r.queue_told, ">");
  if (Array.isArray(r.blocked_told)) r.blocked_told = pairs(r.blocked_told, "<");
  followChanges(r, list);
}

/** The changes about a legacy list's todos, at their new IDs; an open one about a todo that left the list is seen. */
function followChanges(r: WorkRecord, { known, moves, now }: TodoList) {
  const left = (id?: string) => id !== undefined && known.has(id) && !moves.has(id);
  const moved = (id?: string) => (id === undefined ? undefined : (moves.get(id) ?? id));
  for (const c of r.changes ?? []) {
    if (isOpen(c) && (left(c.todo) || left(c.before) || left(c.after))) Object.assign(c, { delivery: "seen", settled_at: now });
    Object.assign(c, opt("todo", moved(c.todo)), opt("before", moved(c.before)), opt("after", moved(c.after)));
  }
}

/** How many blocks a session keeps for tasks it hasn't seen created. */
const LATER_BLOCKS_MAX = 200;

/**
 * Marks the todos a TaskUpdate's `addBlocks` names as blocked by its todo. A block on a task hoop
 * hasn't seen yet waits in `blocks` until the task comes.
 */
function blockOthers(r: WorkRecord, e: EventOf<"todo">) {
  for (const id of e.blocks ?? []) {
    if (id === e.id || r.deleted?.includes(id)) continue;
    const other = r.todos.find((x) => x.id === id);
    if (other) other.blocked_by = [...new Set([...(other.blocked_by ?? []), e.id])];
    else waitBlock(r, id, e.id);
  }
}

/** Keeps a block on a task hoop hasn't seen yet, the newest LATER_BLOCKS_MAX tasks' at most. */
function waitBlock(r: WorkRecord, id: string, by: string) {
  const kept = Object.entries(r.blocks ?? {}).filter(([k]) => k !== id);
  r.blocks = Object.fromEntries([...kept, [id, [...new Set([...(r.blocks?.[id] ?? []), by])]]].slice(-LATER_BLOCKS_MAX));
}

/** Drops the waiting blocks of the todos now on the record, `ids`, which took them. */
function laterBlocks(r: WorkRecord, ids: string[]) {
  if (!r.blocks) return;
  for (const id of ids) delete r.blocks[id];
  if (!Object.keys(r.blocks).length) delete r.blocks;
}

/** A deleted task, at `at` in the list or not there, kept among the deleted so it stays deleted. */
function deleteTodo(r: WorkRecord, id: string, at: number) {
  if (at >= 0) r.todos.splice(at, 1);
  r.deleted = [...(r.deleted ?? []).filter((d) => d !== id), id].slice(-DELETED_MAX);
}

/** A todo's status after a task tool's hook: a creation never undoes a later update. */
const todoStatus = (e: EventOf<"todo">, was: WorkTodo | undefined) =>
  e.status && !(was && e.created) ? (STATUS[e.status] ?? was?.status ?? "queued") : (was?.status ?? "queued");

/**
 * One todo, from TaskCreate, TaskUpdate or TaskGet. Async hooks may arrive out of order: a deleted
 * task stays deleted, a creation never undoes a later update, and an update before its creation
 * shows the task by number until its text comes.
 */
function applyTodo(r: WorkRecord, e: EventOf<"todo">, now: string) {
  const at = r.todos.findIndex((t) => t.id === e.id);
  if (e.status === "deleted") return deleteTodo(r, e.id, at);
  if (r.deleted?.includes(e.id)) return;
  const was = r.todos[at];
  const status = todoStatus(e, was);
  // A creation that arrives after an update keeps the update's description.
  const description = (e.created && was ? was.description : undefined) ?? e.description ?? was?.description;
  const blocked = [...new Set([...(was?.blocked_by ?? r.blocks?.[e.id] ?? []), ...(e.blocked_by ?? [])])];
  const todo: WorkTodo = {
    id: e.id,
    text: e.text ?? was?.text ?? `Task #${e.id}`,
    ...opt("active", e.active ?? was?.active),
    ...opt("description", description?.trim() ? description : undefined),
    status,
    order: was?.order ?? numbered(e.id) ?? Math.max(0, ...r.todos.map((t) => t.order)) + 1,
    updated: now,
    ...timesOf(was, status, now),
    ...opt("blocked_by", blocked.length ? blocked : undefined),
    ...opt("source", was?.source),
    ...historyOf(was, status, now),
  };
  if (was) r.todos[at] = todo;
  else r.todos.push(todo);
  laterBlocks(r, [e.id]);
  blockOthers(r, e);
  r.todos.sort((a, b) => a.order - b.order);
}

/** Whether an Agent call made at `at` and a subagent seen at `now` are close enough to be paired. */
const fresh = (at: string, now: string) => Date.parse(now) - Date.parse(at) < PENDING_MS;

/**
 * An Agent call before its subagent starts. Async hooks may run out of order: a subagent that started
 * first takes its call now, unless it was resumed, when the call is a new subagent's.
 */
function applyCall(r: WorkRecord, e: EventOf<"call">, now: string) {
  const early = r.agents.find((a) => a.status === "running" && !a.resumed && !a.call && !a.description && a.type === e.type && fresh(a.started, now));
  if (early) {
    early.call = e.call;
    if (e.description) early.description = e.description;
    return;
  }
  r.pending = [
    ...r.pending.filter((p) => p.call !== e.call && fresh(p.at, now)),
    { call: e.call, type: e.type, at: now, ...opt("description", e.description) },
  ].slice(-PENDING_MAX);
}

/**
 * The waiting Agent call a subagent takes: the one Claude Code's meta file beside its transcript
 * names, else, for a first start (`guess`), the oldest of its type made within PENDING_MS. A start
 * without a type takes a call only when one alone waits. Taken off the waiting list.
 */
function takeCall(r: WorkRecord, e: EventOf<"agent-start">, transcript: string | undefined, now: string, guess: boolean): PendingCall | undefined {
  const named = agentMeta(transcript)?.call;
  const waiting = r.pending.filter((c) => fresh(c.at, now));
  const alone = waiting.length === 1 ? waiting[0] : undefined;
  const byType = e.type ? waiting.find((c) => c.type === e.type) : alone;
  const call = (named ? r.pending.find((c) => c.call === named) : undefined) ?? (guess ? byType : undefined);
  if (call) r.pending.splice(r.pending.indexOf(call), 1);
  return call;
}

/**
 * A subagent's start. It names no description, so one without a call takes a waiting Agent call
 * (`takeCall`); one hoop already has with its call, resumed by SendMessage, keeps its own, and one
 * resumed without its call takes only a waiting call its meta file names.
 */
function applyAgentStart(r: WorkRecord, e: EventOf<"agent-start">, now: string, agentTranscript: (id: string) => string | undefined) {
  const was = r.agents.find((a) => a.id === e.id);
  const transcript = e.transcript ?? was?.transcript ?? agentTranscript(e.id);
  // A known agent without a call whose stop or result came first takes one now; one with a call keeps it.
  const pending = was?.call ? undefined : takeCall(r, e, transcript, now, !was || was.unstarted === true);
  if (was) delete was.unstarted;
  // An agent that starts again after it ended (SendMessage resumes it) runs again; a start within
  // RESUME_MS of its end is an async hook that ran late, and leaves it ended.
  const resumed = was?.ended !== undefined && Date.parse(now) - Date.parse(was.ended) >= RESUME_MS;
  if (resumed) delete was.ended;
  const agent: WorkAgent = {
    ...was,
    ...(resumed ? { resumed: true as const } : {}),
    id: e.id,
    status: resumed ? "running" : (was?.status ?? "running"),
    started: was?.started ?? now,
    ...opt("type", e.type ?? was?.type ?? pending?.type),
    ...opt("description", was?.description ?? pending?.description),
    ...opt("call", was?.call ?? pending?.call),
    ...opt("transcript", transcript),
  };
  if (was) Object.assign(was, agent);
  else r.agents.push(agent);
}

/** An agent hoop didn't see start (its hook was off, or an Agent result came first), added to the record with its waiting call. */
function addUnseenAgent(r: WorkRecord, id: string, call: string | undefined, now: string): WorkAgent {
  const p = call ? r.pending.findIndex((c) => c.call === call) : -1;
  const pending = p >= 0 ? r.pending.splice(p, 1)[0] : undefined;
  const a: WorkAgent = {
    id,
    unstarted: true,
    status: "running",
    started: pending?.at ?? now,
    ...opt("description", pending?.description),
    ...opt("type", pending?.type),
    ...opt("call", pending?.call),
  };
  r.agents.push(a);
  return a;
}

/**
 * The agent an end names: by its ID, else, with none given, by its Agent call. An Agent result
 * names both, so an agent that took another's call by guess gives it back: the other agent, which
 * holds this one's call, takes the call and description this one had.
 */
function agentOfEnd(r: WorkRecord, e: EventOf<"agent-end">, now: string): WorkAgent | undefined {
  if (!e.id) return e.call ? r.agents.find((x) => x.call === e.call) : undefined;
  const a = r.agents.find((x) => x.id === e.id) ?? addUnseenAgent(r, e.id, e.call, now);
  const other = e.call && a.call !== e.call ? r.agents.find((x) => x !== a && x.call === e.call) : undefined;
  if (other) {
    if (a.call) other.call = a.call;
    else delete other.call;
    if (a.description) other.description = a.description;
    else delete other.description;
    delete a.description;
  }
  return a;
}

/** An agent's end, or its Agent call's result. */
function applyAgentEnd(r: WorkRecord, e: EventOf<"agent-end">, now: string, agentTranscript: (id: string) => string | undefined) {
  const a = agentOfEnd(r, e, now);
  if (!a) return;
  if (e.call) {
    a.call = e.call;
    r.pending = r.pending.filter((p) => p.call !== e.call);
  }
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
}

/** How many changes a record keeps besides its stops, which it keeps for good so a stopped agent stays stopped. */
const CHANGES_MAX = 200;

/**
 * The gate's small files beside a record, which its shell script reads before it starts hoop:
 * `<session>.gate` exists while a change may stop a todo tool call, `<session>.agents` lists each
 * agent the gate must act on as `id<TAB>stop|note<TAB>person` lines, and `<session>.order` names the
 * todo the person put first, while they have set an order, and `<session>.blocked` lists the queued
 * todos whose blocked start the gate hasn't refused yet. `<session>.stop` exists while a Work change
 * the agent may not have read is one the Stop gate hasn't told it yet. `<session>.done` lists the
 * todos the done gate may refuse: not done, and naming a review, or started by the time the session
 * opened a pull request it tracked (only those can own one, `prOwners`).
 */
const GATE_FILES = [".gate", ".agents", ".order", ".blocked", ".stop", ".done"];
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
  put(
    `${base}.blocked`,
    untoldBlocked(r)
      .map((t) => `${t.id}\n`)
      .join(""),
  );
  put(
    `${base}.done`,
    doneGated(home, r)
      .map((t) => `${t.id}\n`)
      .join(""),
  );
  const told = toldIn(r, "stop_told");
  put(`${base}.stop`, changes.some((c) => unreadChange(c) && !told.includes(`change:${c.id}`)) ? "1\n" : "");
}

/** The todos the done gate may refuse a completion of, for `<session>.done`. */
function doneGated(home: string, r: WorkRecord): WorkTodo[] {
  const opened = trackedPrs(home)
    .filter((p) => p.owner.session === r.session)
    .map((p) => p.added);
  return r.todos.filter((t) => {
    if (t.status === "done") return false;
    const at = startOf(t);
    return REVIEW_PATH.test(t.description ?? "") || (at !== undefined && opened.some((a) => at <= a));
  });
}

/** Writes a record and its gate files. */
function saveWork(home: string, r: WorkRecord) {
  if (r.changes && r.changes.length > CHANGES_MAX) {
    const drop = r.changes.length - CHANGES_MAX;
    let n = 0;
    r.changes = r.changes.filter((c) => c.kind === "stop" || isOpen(c) || n++ >= drop);
  }
  writeJson(file(home, r.session), r);
  hasWorkCache.delete(home);
  writeGateFiles(home, r);
}

/**
 * Runs `fn` on a session's record, and saves the record when `fn` changed it. Returns
 * undefined when the session has no record, unless `create` starts an empty one.
 */
export function editWork<T>(home: string, session: string, fn: (r: WorkRecord) => T, opts: { create?: boolean } = {}): T | undefined {
  if (!validSession(session)) return undefined;
  mkdirSync(dir(home), { recursive: true });
  const r = readWork(home, session) ?? (opts.create ? { session, updated: new Date().toISOString(), todos: [], agents: [], pending: [] } : undefined);
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
    const f = hookFields(input);
    const session = f.session;
    if (!events.length || !session) return undefined;
    // A turn or a session that ends, or a permission prompt, changes only a session with work.
    const quiet = ["turn-end", "session-end", "prompt", "prompt-shown"];
    if (events.every((e) => quiet.includes(e.kind)) && !readWork(home, session)) return undefined;
    mkdirSync(dir(home), { recursive: true });
    const r: WorkRecord = readWork(home, session) ?? { session, updated: now, todos: [], agents: [], pending: [] };
    if (f.cwd) r.cwd = f.cwd;
    if (f.transcript) r.transcript = f.transcript;
    const texts = r.todos.map((t) => t.text);
    for (const e of events) applyEvent(r, e, now, r.transcript);
    // A todo the agent creates takes the request of the turn it was created in, once: TaskCreate's by
    // its ID (an update that came first may have made it already), TodoWrite's by text, since its
    // list has no IDs. TaskList and TaskGet only list todos that already were.
    r.sources_from ??= now;
    const created = createdBy(f.tool, r, events, texts);
    // A todo takes the request before its call in the transcript. A subagent's call isn't there, and
    // its hook gives its session's prompt ID, so its todos take the main turn's request.
    const source = created.length ? sourceOf(sessionTranscript(r), f.promptId, now, f.toolUseId) : undefined;
    if (source) for (const t of created) t.source = source;
    settle(r, now);
    r.updated = now;
    saveWork(home, r);
    return r;
  } catch {
    return undefined;
  }
}

export const sinceOf = (t: WorkTodo) => t.since ?? t.updated;
/** When a todo started: its first start, else, while it runs, when it was last marked running. */
export const startOf = (t: WorkTodo) => t.started ?? (t.status === "running" ? sinceOf(t) : undefined);

/**
 * Whether SessionEnd counts: no process runs the session, or one does that hasn't updated since. A
 * resumed session runs again, though no hook has said so yet.
 */
export const endedBy = (r: Pick<WorkRecord, "ended">, live: ClaudeSession | undefined) =>
  Boolean(r.ended && !(live?.updatedAt !== undefined && live.updatedAt > Date.parse(r.ended) + RESUME_MS));

/** How long a session with no SessionEnd must have been quiet before it can be removed. */
const QUIET_MS = 5 * 60_000;

/** Why a session's record stays: a reason for each, as the Work page says it. */
export const KEEPS = {
  running: "This session is still running. Only an ended session can be removed.",
  quiet: "hoop has no SessionEnd for this session and it was active in the last 5 minutes, so it may still be running.",
  cleared: "Its Claude Code process runs on under a new session after /clear, and may still answer this session's comments.",
} as const;

/** Whether a session's record, its last hook or its transcript changed in the last QUIET_MS. */
function activeLately(r: WorkRecord, lastHook: number, now: number): boolean {
  const transcript = sessionTranscript(r);
  let wrote = 0;
  try {
    if (transcript) wrote = statSync(transcript).mtimeMs;
  } catch {
    /* no transcript: nothing recent there */
  }
  return [Date.parse(r.updated), lastHook, wrote].some((t) => now - t < QUIET_MS);
}

/**
 * Deletes hoop's own record of an ended session, as the person asked on the Work page: its work
 * record and gate files. Claude Code's transcript and session stay. A later hook from the session
 * starts a fresh record. A session stays while it runs (busy or idle); while it has no SessionEnd
 * and was active in the last QUIET_MS (its record, its last hook `lastHook`, or its transcript), since
 * the session files can miss a running one; and while the process that commented through it runs
 * on under a new session after `/clear`.
 */
export function removeWork(
  home: string,
  session: string,
  opts: { sessions?: SessionReader; lastHook?: number; now?: number } = {},
): "removed" | "none" | keyof typeof KEEPS {
  const r = validSession(session) ? readWork(home, session) : undefined;
  if (!r) return "none";
  const running = (opts.sessions ?? claudeSessions)();
  const live = running.find((s) => s.session === session);
  if (live && !endedBy(r, live)) return "running";
  if (!r.ended && activeLately(r, opts.lastHook ?? 0, opts.now ?? Date.now())) return "quiet";
  const commented = (r.changes ?? []).flatMap((c) => (c.process ? [c.process] : []));
  if (running.some((s) => s.session !== session && commented.some((p) => p.pid === s.pid && p.start === s.start))) return "cleared";
  const base = file(home, session).slice(0, -".json".length);
  for (const ext of GATE_FILES) rmSync(`${base}${ext}`, { force: true });
  rmSync(file(home, session), { force: true });
  hasWorkCache.delete(home);
  return "removed";
}

/**
 * Whether a session on this machine has recorded todos or subagents, by hoop home. The pages process
 * is the only writer of work records (saveWork and removeWork), so each of them drops the answer, and
 * the next ask reads the records again; /api/info, the pages' liveness probe, never reads them twice.
 */
const hasWorkCache = new Map<string, boolean>();
export function hasWork(home: string): boolean {
  let known = hasWorkCache.get(home);
  if (known === undefined) {
    known = workRecords(home).some((r) => r.todos.length > 0 || r.agents.length > 0);
    hasWorkCache.set(home, known);
  }
  return known;
}

/** Every session's work record. */
export function workRecords(home: string): WorkRecord[] {
  try {
    return readdirSync(dir(home))
      .filter((n) => n.endsWith(".json"))
      .flatMap((n) => readWork(home, n.slice(0, -5)) ?? []);
  } catch {
    return [];
  }
}
