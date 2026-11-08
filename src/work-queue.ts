// A session's todo queue: the person's order, which todos are queued, parked, removed or blocked,
// and moving one before another. src/work.ts keeps the record these read and change.
import { toldIn } from "./told.js";
import type { WorkChange, WorkRecord, WorkTodo } from "./work.js";

/** Whether a change may still reach the agent or be overridden. */
export const isOpen = (c: WorkChange) => c.delivery !== "seen" && c.delivery !== "overridden" && c.delivery !== "withdrawn";

/** The person's queue kept to the record's todos: deleted ones leave it, new ones join at the end. */
export function syncQueue(r: WorkRecord) {
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

/** The todos a todo starts after, as the person said; anything unreadable counts as none. */
export const startsAfter = (r: Pick<WorkRecord, "starts_after">, id: string): string[] => {
  const ids = r.starts_after && typeof r.starts_after === "object" ? r.starts_after[id] : undefined;
  return Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : [];
};

/** A todo's blocked-by links: the agent's own, and those the person added. */
export const blockedBy = (r: Pick<WorkRecord, "starts_after">, t: WorkTodo) => [...new Set([...(t.blocked_by ?? []), ...startsAfter(r, t.id)])];

/**
 * The todos that block a todo, as the page's `blockers`: those it is blocked by that are still in
 * the list, not done, and neither removed nor parked by the person, so none waits on a todo that
 * won't start.
 */
export function blockersOf(r: Pick<WorkRecord, "todos" | "starts_after" | "changes" | "parked">, t: WorkTodo): WorkTodo[] {
  return blockedBy(r, t).flatMap(
    (id) => r.todos.find((x) => x.id === id && x.id !== t.id && x.status !== "done" && !removedTodo(r, id) && !parkedTodo(r, id)) ?? [],
  );
}

/** Whether `from` waits on `to`, through blocked-by links of the todos in the list, done or not. */
export function waitsFor(r: Pick<WorkRecord, "todos" | "starts_after">, from: string, to: string): boolean {
  const seen = new Set<string>();
  const next = [from];
  while (next.length) {
    const id = next.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = r.todos.find((x) => x.id === id);
    if (t) next.push(...blockedBy(r, t));
  }
  return false;
}

/**
 * The todo the person put first: the first queued todo in their order that isn't blocked, as the
 * page's Up next, or undefined when they set none.
 */
export function firstQueued(r: WorkRecord): WorkTodo | undefined {
  if (!hasQueue(r)) return undefined;
  return ordered(r).find((t) => inQueue(r, t) && !blockersOf(r, t).length);
}

/** The queued todos the gate still refuses to start once: blocked by a todo it hasn't told the agent about; a parked one's park speaks for it. */
export function untoldBlocked(r: WorkRecord): WorkTodo[] {
  const told = toldIn(r, "blocked_told");
  return r.todos.filter(
    (t) => t.status === "queued" && !removedTodo(r, t.id) && !parkedTodo(r, t.id) && blockersOf(r, t).some((b) => !told.includes(`${t.id}<${b.id}`)),
  );
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
