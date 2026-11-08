// Settling a person's Work changes: whether each open change was seen or overridden, from the
// session's todos and agents as the hooks last saw them. src/work.ts keeps the changes in its record.
import { isOpen, parkedTodo, startsAfter } from "./work-queue.js";
import type { Delivery, WorkChange, WorkRecord, WorkTodo } from "./work.js";

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

/** A move or depend as the order it asks for: `first` before `second`. */
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
  for (const c of r.changes ?? []) {
    if (!isOpen(c)) continue;
    const to = Object.hasOwn(SETTLES, c.kind) ? SETTLES[c.kind](c, r, todo) : undefined;
    if (to) {
      c.delivery = to;
      c.settled_at = now;
    }
  }
  if (r.starts_after !== undefined) settleStartsAfter(r, todo);
  // A parked todo that started, or left the list, is parked no more.
  if (r.parked !== undefined) {
    const kept = Array.isArray(r.parked) ? r.parked.filter((id) => todo(id)?.status === "queued") : [];
    if (kept.length) r.parked = kept;
    else delete r.parked;
  }
}

/** A todo the person said starts after another keeps that only while both are in the list and it is queued. */
function settleStartsAfter(r: WorkRecord, todo: (id?: string) => WorkTodo | undefined) {
  const kept = Object.entries(r.starts_after && typeof r.starts_after === "object" ? r.starts_after : {}).flatMap(([id]) => {
    const after = todo(id)?.status === "queued" ? startsAfter(r, id).filter((b) => todo(b)) : [];
    return after.length ? [[id, after] as const] : [];
  });
  if (kept.length) r.starts_after = Object.fromEntries(kept);
  else delete r.starts_after;
}

/** Whether a todo started: it runs or is done. */
const hasStarted = (t?: WorkTodo) => t?.status === "running" || t?.status === "done";

/** What each kind of open change settles to now, if anything, from the record and its todo lookup. */
const SETTLES: Record<WorkChange["kind"], (c: WorkChange, r: WorkRecord, todo: (id?: string) => WorkTodo | undefined) => Delivery | undefined> = {
  remove: (c, _r, todo) => {
    const t = todo(c.todo);
    if (!t) return "seen";
    return hasStarted(t) ? "overridden" : undefined;
  },
  edit: (c, _r, todo) => {
    const t = todo(c.todo);
    // A running todo's edit is overridden once the todo is done without it.
    const went = c.was === "running" ? t?.status === "done" : hasStarted(t);
    if (!t || editTaken(t, c) || c.gated_at) return "seen";
    return went ? "overridden" : undefined;
  },
  add: (c, r, todo) => {
    // Told by message or by the gate, it stays open until the todo appears.
    const t = c.todo ? todo(c.todo) : addedTodo(r, c);
    if (t) c.todo = t.id;
    return t ? "seen" : undefined;
  },
  withdraw: (c, r, todo) => {
    if (c.todo) {
      // A withdrawn depend: seen once its todo starts or leaves the list.
      const t = todo(c.todo);
      return !t || hasStarted(t) ? "seen" : undefined;
    }
    const add = (r.changes ?? []).find((x) => x.id === c.of);
    // The agent created it anyway, after it was taken back.
    return add && addedTodo(r, add) ? "overridden" : undefined;
  },
  park: (c, r, todo) => {
    const t = todo(c.todo);
    // A park holds while the todo stays parked; starting it anyway, after the gate said so, overrides it.
    if (hasStarted(t)) return "overridden";
    return !t || !parkedTodo(r, c.todo!) ? "seen" : undefined;
  },
  unpark: (c, _r, todo) => {
    const t = todo(c.todo);
    return !t || hasStarted(t) ? "seen" : undefined;
  },
  depend: (c, _r, todo) => {
    const t = todo(c.todo),
      b = todo(c.after);
    // Starting it before its blocker is done overrides it; the agent's own link, the gate or the blocker's end settle it.
    if (hasStarted(t) && b && b.status !== "done") return "overridden";
    return !t || !b || b.status === "done" || t.blocked_by?.includes(b.id) || c.gated_at ? "seen" : undefined;
  },
  move: (c, r, todo) => {
    const { first, second } = moveOrder(c);
    const a = todo(first),
      b = todo(second);
    // A park of its first todo since stands in for it.
    if (parkedTodo(r, first)) return "seen";
    if (hasStarted(b) && a?.status === "queued") return c.gated_at ? "seen" : "overridden";
    return hasStarted(a) || !a || !b ? "seen" : undefined;
  },
  comment: (c, r, todo) => {
    // A request the agent was asked to register is seen once a todo comes from it.
    if (c.request) return c.gated_at || r.todos.some((t) => requestOf(t, r.changes ?? []) === c.request) ? "seen" : undefined;
    if (c.gated_at) return "seen";
    if (!c.todo) return undefined;
    const t = todo(c.todo);
    return !t || t.status !== c.was || t.text !== c.subject ? "seen" : undefined;
  },
  stop: (c, r) => {
    const a = r.agents.find((x) => x.id === c.agent);
    return a?.status !== "running" || c.gated_at ? "seen" : undefined;
  },
  done: (c, _r, todo) => {
    // Seen once the agent marks the todo done, or deletes it (its TodoWrite place now holds another todo).
    const t = todo(c.todo);
    return !t || t.status === "done" || t.text !== c.subject ? "seen" : undefined;
  },
};

/** A person's Work change that may not have reached the agent: sent and not read yet, or waiting and not told by the gate. */
export const unreadChange = (c: WorkChange) => c.kind !== "stop" && c.kind !== "done" && (c.delivery === "sent" || (c.delivery === "waiting" && !c.gated_at));

/**
 * The request a todo came from: its source's, or, for a todo from a Work-page message that asked the
 * agent to register an earlier request, that request.
 */
export function requestOf(t: WorkTodo, changes: WorkChange[]): string | undefined {
  const s = t.source;
  if (!s || s.kind === "agent") return undefined;
  return (s.ref && changes.find((c) => c.ref === s.ref && c.request)?.request) || s.request;
}
