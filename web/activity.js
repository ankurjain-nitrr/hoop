// How the Work page reads what runs: what comes first, how long things ran, and which "running"
// todos and subagents show no sign of life. It reads the work as the server sends it and changes
// nothing; a todo left in progress stays so in the record.

/** How long a running todo or subagent may show no activity before the page calls it stalled. */
export const STALE_MS = 10 * 60_000;

/** A span of time as people read it: 45 s, 3 m, 2 h 14 m. */
export function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m`;
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}

const SESSION_RANK = { busy: 0, idle: 1, ended: 2 };
const TODO_RANK = { running: 0, queued: 1, done: 2 };
const AGENT_RANK = { running: 0 };

/** Sorts by `rank`, keeping the given order among equals. */
const byRank = (list, rank) =>
  list
    .map((x, n) => ({ x, n, k: rank(x) }))
    .sort((a, b) => a.k - b.k || a.n - b.n)
    .map(({ x }) => x);

/** Sessions as the page lists them: working ones first, then idle, then ended, newest first within each. */
export const sortSessions = (sessions) => byRank(sessions, (s) => SESSION_RANK[s.state] ?? 3);

/** A session's todos: running ones, then queued ones in the person's order, then done ones. */
export const sortTodos = (todos) => byRank(todos, (t) => TODO_RANK[t.status] ?? 3);

/** A session's subagents: running ones first, the rest as they came. */
export const sortAgents = (agents) => byRank(agents, (a) => AGENT_RANK[a.status] ?? 1);

const since = (at, now) => (at ? now - Date.parse(at) : undefined);

/**
 * How a running todo reads: `{ state, note }`, where state is running, stalled or idle (not running).
 * A todo of an ended session, or of an idle one with no subagent running, was left in progress; one
 * whose session shows no activity for STALE_MS, and runs no tool call, has stalled. Undefined for a
 * todo that isn't running.
 */
export function todoHealth(s, t, now) {
  if (t.status !== "running") return undefined;
  if (s.state === "ended") return { state: "notrunning", note: "Not running: the session ended; this todo was left in progress" };
  const agentLive = s.agents.some((a) => a.status === "running" && agentHealth(a, now)?.state === "running");
  if (s.state === "idle" && !agentLive) return { state: "notrunning", note: "Not running: the session is idle; this todo was left in progress" };
  const quiet = since(s.activity, now);
  if (quiet !== undefined && quiet >= STALE_MS && !s.doing?.open && !agentLive) return { state: "stalled", note: `Stalled: no activity for ${span(quiet)}` };
  return { state: "running" };
}

/** How a running subagent reads: stalled once its transcript shows no activity for STALE_MS and no tool call runs. */
export function agentHealth(a, now) {
  if (a.status !== "running") return undefined;
  const quiet = since(a.activity, now);
  if (quiet !== undefined && quiet >= STALE_MS && !a.doing?.open) return { state: "stalled", note: `Stalled: no activity for ${span(quiet)}` };
  return { state: "running" };
}

/**
 * "running for 2 h 14 m · last activity 3 m ago", for a running todo or subagent; "marked running
 * for" one that isn't running (`left`).
 */
export function clockText(started, activity, now, left = false) {
  const parts = [];
  if (started) parts.push(`${left ? "marked running" : "running"} for ${span(now - Date.parse(started))}`);
  if (activity) parts.push(`last activity ${span(now - Date.parse(activity))} ago`);
  return parts.join(" · ");
}

/**
 * The page's counts: how many todos and subagents run, and the ones that stalled or were left in
 * progress, as `{ running, stalled: [{ session, kind, id }] }`, in the order the page shows them.
 */
export function counts(sessions, now) {
  let running = 0;
  const stalled = [];
  for (const s of sortSessions(sessions)) {
    for (const t of sortTodos(s.todos)) {
      const h = todoHealth(s, t, now);
      if (h?.state === "running") running++;
      else if (h) stalled.push({ session: s.id, kind: "todo", id: t.id });
    }
    for (const a of sortAgents(s.agents)) {
      const h = agentHealth(a, now);
      if (h?.state === "running") running++;
      else if (h) stalled.push({ session: s.id, kind: "agent", id: a.id });
    }
  }
  return { running, stalled };
}
