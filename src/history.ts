import { todoState } from "../web/activity.js";
import { editWork, withState, type WorkSession, type WorkTodo } from "./work.js";

// Each todo's state history: the hooks add each status they see (queued, running, done), and the
// pages process adds each state the Work page reads from evidence (waiting on you, in review,
// blocked, stalled, not running) as it answers the page, from when that state began.

/**
 * The state a todo reads as now: what its evidence says, else its status. A todo left in progress
 * while its session idles between turns keeps its status: each turn's end and start would otherwise
 * fill the history with not running and running.
 */
export function stateNow(s: WorkSession, t: WorkTodo, now: number): { state: string; at?: string } {
  const st = todoState(s, t, now);
  if (st?.state === "notrunning" && s.state === "idle") return { state: t.status };
  return st ? { state: st.state, ...(st.since ? { at: st.since } : {}) } : { state: t.status };
}

/**
 * When a state read at `now` began: its own start (`since`), when that comes after the last state in
 * the history. One that started earlier began with the last state when that is the status it refines
 * (a todo the hooks saw start, waiting on a review submitted before), else when the last state ended,
 * which the page saw only now: a running todo's clock counts from when it was marked running, not
 * from when its review was approved.
 */
function startOf(t: WorkTodo, since: string | undefined, now: string): string {
  const last = t.history?.at(-1);
  if (!since || since > now) return now;
  if (!last || since >= last.at) return since;
  return last.state === t.status ? last.at : now;
}

/**
 * Adds to each todo's history the state the view reads it in, when it changed, and writes the
 * records that changed. The view's todos get the new history too.
 */
export function recordStates(home: string, view: WorkSession[], now = Date.now()) {
  const at = new Date(now).toISOString();
  for (const s of view) {
    const states = new Map<string, { state: string; at: string }>();
    for (const t of s.todos) {
      const { state, at: since } = stateNow(s, t, now);
      const from = startOf(t, since, at);
      if (withState(t.history, state, from) !== t.history) states.set(t.id, { state, at: from });
    }
    if (!states.size) continue;
    const add = (t: WorkTodo) => {
      const st = states.get(t.id);
      if (st) t.history = withState(t.history, st.state, st.at);
    };
    // The record may have changed since the view was read: the state goes onto its history as it is now.
    editWork(home, s.id, (r) => r.todos.forEach(add));
    s.todos.forEach(add);
  }
}
