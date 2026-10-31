// How the Work page reads what runs: what comes first, how long things ran, and what each todo the
// agent marked in progress really is, from evidence (its links, its session and subagents). It reads
// the work as the server sends it and changes nothing; a todo left in progress stays so in the record.

/** How long a running todo or subagent may show no activity before the page calls it stalled. */
export const STALE_MS = 10 * 60_000;

/** How long before a session's last activity its latest turn end may be and still be the end of that activity. */
const TURN_MS = 60_000;

/** How long after its last activity an ended session's todos left in progress still count as stalled. */
export const ENDED_COUNT_MS = 60 * 60_000;

/** A span of time as people read it: 45 s, 3 m, 2 h 14 m. */
export function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m`;
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}

/** A time as people read it, as every page writes it: the clock alone today, else the date and time. */
export const readAt = (iso) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};

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

/** What a session's open call waits on the person for, in words. */
const WAITS = {
  review: "a review in hoop",
  question: "a question in Claude Code",
  permission: "a permission prompt in Claude Code",
  dialog: "a dialog in Claude Code",
};

const since = (at, now) => (at ? now - Date.parse(at) : undefined);

/** Review statuses that wait on the person: a revision not reviewed yet, or a question not answered. */
const NEEDS_YOU = new Set(["awaiting_review", "question"]);
/** What an open pull request needs from the person, or "": their review, or their merge. A draft, or failing checks, waits on the agent. */
function prNeed(p) {
  if (p.draft) return "";
  if (p.review_requested) return "needs your review";
  return p.ready ? "ready for your merge" : "";
}
const prLabel = (p) => `PR #${p.number}`;
const reviewLabel = (r) => (r.title ? `review “${r.title}”` : "a review in hoop");
const sinceOf = (t) => t.since ?? t.updated;
/** When a todo first started, for what counts as its outcome. */
const startOf = (t) => t.started ?? sinceOf(t);
const CHECKS = { running: " · checks running", failing: " · checks failing", green: " · checks passed" };

/** A pull request's state in words, as a todo's link says it: open or draft, what it needs from the person, and its checks. */
export function prWords(p) {
  if (p.state !== "open") return "not read yet";
  const need = prNeed(p);
  return `${p.draft ? "draft" : "open"}${need ? ` · ${need}` : ""}${CHECKS[p.checks] ?? ""}`;
}

/**
 * What a running todo's links say, or undefined: waiting on the person (a review waits on them, or a
 * pull request needs their review or merge), in review (a pull request is open and waits on CI, others
 * or the agent), or done (none of those, no pull request still unread, and a pull request merged or a
 * review approved after the todo started).
 */
function linkState(t) {
  const links = t.links ?? [];
  const prs = links.filter((l) => l.kind === "pr");
  const reviews = links.filter((l) => l.kind === "review");
  const review = reviews.find((r) => NEEDS_YOU.has(r.status));
  if (review)
    return {
      state: "waiting",
      note: `Waiting on you: ${reviewLabel(review)}`,
      since: review.at,
      link: { href: `/r/${review.id}`, text: review.title ?? "Review" },
    };
  const open = prs.filter((p) => p.state === "open");
  const needy = open.find((p) => prNeed(p));
  const prLink = (p) => ({ href: p.url, text: prLabel(p) });
  if (needy) return { state: "waiting", note: `Waiting on you: ${prLabel(needy)} ${prNeed(needy)}`, since: needy.opened_at ?? sinceOf(t), link: prLink(needy) };
  if (open.length) {
    const p = open[0];
    const note = `In review: ${prLabel(p)}${p.draft ? " · draft" : ""}${CHECKS[p.checks] ?? ""}`;
    return { state: "inreview", note, since: p.opened_at ?? sinceOf(t), link: prLink(p) };
  }
  // A pull request not read yet may still be open: no outcome until it is.
  if (prs.some((p) => p.state === "unknown")) return undefined;
  const merged = prs.find((p) => p.state === "merged" && p.merged_at && p.merged_at >= startOf(t));
  if (merged) return { state: "done", note: `Done: ${prLabel(merged)} merged (hoop checked)`, link: prLink(merged) };
  // A review approved before the todo started is its plan, not its outcome.
  const approved = reviews.find((r) => r.status === "approved" && r.approved_at && r.approved_at >= startOf(t));
  if (approved)
    return {
      state: "done",
      note: `Done: ${reviewLabel(approved)} approved (hoop checked)`,
      link: { href: `/r/${approved.id}`, text: approved.title ?? "Review" },
    };
  return undefined;
}

/** The todos that block `t`: those it names as blocked by that are still in the list, not done, removed or parked. */
export const blockers = (s, t) =>
  (t.blocked_by ?? []).flatMap(
    (id) =>
      s.todos.find(
        (x) =>
          x.id === id &&
          x.status !== "done" &&
          !(s.parked ?? []).includes(id) &&
          !(s.changes ?? []).some(
            (c) => c.kind === "remove" && c.todo === id && c.delivery !== "seen" && c.delivery !== "overridden" && c.delivery !== "withdrawn",
          ),
      ) ?? [],
  );

/** How long a todo's subject must be for a subagent's description that holds it to name the todo. */
const PHRASE_MIN = 12;
/** Text as lower-case words between spaces, so a phrase matches only on whole words. */
const words = (x) =>
  ` ${(x ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;

/**
 * Whether a subagent works on a todo: its description holds the todo's whole subject (of at least
 * PHRASE_MIN characters), or it started while the todo was the latest one started.
 */
function agentOn(a, t, marked) {
  const d = words(a.description);
  if ([t.text, t.active].some((x) => words(x).trim().length >= PHRASE_MIN && d.includes(words(x)))) return true;
  const latest = marked.filter((x) => sinceOf(x) <= a.started).at(-1);
  return latest === t;
}

/**
 * What a todo is, from evidence, as `{ state, note, since, link }`: `state` is one of done, waiting
 * (on the person), inreview, blocked, running, stalled or notrunning; `note` says why; `since` is when
 * that state began, for its clock; `link` the review or pull request that shows it. Rules go in that
 * order, first match wins. A queued todo is blocked or nothing; a done one is nothing.
 *
 * At most one todo the session itself works on reads running: the latest started of those its links
 * and blockers don't explain. A todo a live subagent works on runs too. Any other todo marked in
 * progress reads not running.
 */
export function todoState(s, t, now) {
  if (t.status === "done") return undefined;
  const blocked = blockers(s, t);
  const blockedState = blocked.length
    ? { state: "blocked", note: `Blocked by ${blocked.map((b) => `#${b.id} “${b.text}”`).join(", ")}`, since: sinceOf(t) }
    : undefined;
  if (t.status !== "running") return blockedState;
  const linked = linkState(t);
  if (linked) return linked;
  if (blockedState) return blockedState;
  return workState(s, t, now);
}

/** A running todo's state when neither its links nor its blockers explain it: by its session and the subagents on it. */
function workState(s, t, now) {
  const left = s.activity ?? sinceOf(t);
  // The hooks say when the session, or its turn, ended; else its last sign of life stands for it.
  if (s.state === "ended") return { state: "notrunning", note: "Not running: the session ended; this todo was left in progress", since: s.ended ?? left };
  const live = s.agents.filter((a) => a.status === "running");
  if (s.state === "idle" && !live.some((a) => agentHealth(a, now)?.state === "running")) {
    // A turn end from before the todo started, or long before the last activity (an interrupted turn has none), is another turn's.
    const ours = s.turn_ended && s.turn_ended >= sinceOf(t) && !(since(s.turn_ended, Date.parse(left)) > TURN_MS);
    const turn = ours ? s.turn_ended : left;
    return { state: "notrunning", note: "Not running: the session is idle; this todo was left in progress", since: turn };
  }
  const marked = s.todos.filter((x) => x.status === "running" && !linkState(x) && !blockers(s, x).length).sort((a, b) => sinceOf(a).localeCompare(sinceOf(b)));
  const agent = live.find((a) => agentOn(a, t, marked));
  if (agent) return agentWorkState(agent, t, now);
  if (marked.at(-1) !== t) return { state: "notrunning", note: "Not running: also marked in progress; the session works on another todo", since: sinceOf(t) };
  return sessionWorkState(s, t, live, now);
}

/** A todo's state while a live subagent works on it: as the subagent reads. */
function agentWorkState(agent, t, now) {
  const h = agentHealth(agent, now);
  const what = `a subagent works on it${agent.description ? `: ${agent.description}` : ""}`;
  const by = { agent: agent.id };
  if (h.state === "waiting") return { state: "waiting", note: `Waiting on you: ${what} asks you something`, since: agent.doing.at, ...by };
  if (h.state === "stalled") return { state: "stalled", note: `${h.note}; ${what}`, since: agent.activity, ...by };
  return { state: "running", note: `Running: ${what}`, since: sinceOf(t), ...by };
}

/** The state of the todo the session itself works on: waiting on the person, stalled, or running. */
function sessionWorkState(s, t, live, now) {
  if (s.doing?.waiting) {
    const what = WAITS[s.doing.waiting] ?? WAITS.review;
    return { state: "waiting", note: `Waiting on you: ${what}`, since: s.doing.at };
  }
  const quiet = since(s.activity, now);
  const agentLive = live.some((a) => agentHealth(a, now)?.state === "running");
  if (quiet !== undefined && quiet >= STALE_MS && !s.doing?.open && !agentLive)
    return { state: "stalled", note: `Stalled: no activity for ${span(quiet)}`, since: s.activity };
  return { state: "running", note: "Running: the session works on it", since: sinceOf(t) };
}

/**
 * How a working session or running subagent reads: waiting while its call waits on the person,
 * stalled once its transcript shows no activity for STALE_MS and no tool call runs, else running.
 */
function health(x, now) {
  if (x.doing?.waiting) return { state: "waiting" };
  const quiet = since(x.activity, now);
  if (quiet !== undefined && quiet >= STALE_MS && !x.doing?.open) return { state: "stalled", note: `Stalled: no activity for ${span(quiet)}` };
  return { state: "running" };
}

/** How a running subagent reads, by `health`; undefined for one that isn't running. */
export function agentHealth(a, now) {
  return a.status === "running" ? health(a, now) : undefined;
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
 * Counts a session's todos into `out`: the subagents whose todo already counts them (`counted`),
 * and whether a todo stands for the session's own work (`own`).
 */
function countTodos(out, s, now) {
  const counted = new Set();
  let own = false;
  for (const t of sortTodos(s.todos)) {
    const h = todoState(s, t, now);
    if (h?.agent) counted.add(h.agent);
    own ||= Boolean(h && !h.agent && !h.link && ["running", "waiting", "stalled"].includes(h.state));
    if (h && out[h.state]) out[h.state].push({ session: s.id, kind: "todo", id: t.id });
  }
  return { counted, own };
}

/**
 * The page's counts, as lists of `{ session, kind, id }` in the order the page shows them: todos and
 * subagents running, waiting on the person, stalled, and not running. A todo whose state comes from
 * the subagent working on it counts once, as the todo. A working session counts itself, as kind
 * "session", unless a todo stands for its own work: one whose state comes from neither its links nor a subagent. An ended session's work counts only for
 * ENDED_COUNT_MS after its last activity.
 */
export function counts(sessions, now) {
  const out = { running: [], waiting: [], stalled: [], notrunning: [] };
  for (const s of sortSessions(sessions)) {
    // An ended session's last activity, else its last hook, stands for when it ended.
    const old = s.state === "ended" && !(since(s.activity ?? s.updated, now) <= ENDED_COUNT_MS);
    if (old) continue;
    const { counted, own } = countTodos(out, s, now);
    for (const a of sortAgents(s.agents)) {
      const h = agentHealth(a, now);
      if (h && !counted.has(a.id)) out[h.state].push({ session: s.id, kind: "agent", id: a.id });
    }
    if (s.state === "busy" && !own) out[health(s, now).state].push({ session: s.id, kind: "session", id: "" });
  }
  return out;
}

/**
 * The todo a session starts next, by the person's order: the first queued todo that isn't removed,
 * parked or blocked. Undefined when there is none.
 */
export function upNext(s) {
  const removed = (t) => s.changes.some((c) => c.kind === "remove" && c.todo === t.id && c.delivery !== "seen" && c.delivery !== "overridden");
  return s.todos.find((t) => t.status === "queued" && !removed(t) && !(s.parked ?? []).includes(t.id) && !blockers(s, t).length);
}

/** A state as a todo's history line names it. */
const STATE_WORDS = {
  queued: "queued",
  running: "running",
  waiting: "waiting on you",
  inreview: "in review",
  blocked: "blocked",
  stalled: "stalled",
  notrunning: "not running",
};

/**
 * What a todo was before its current state, from its history: "after running for 40 m", so a row
 * reads "for 3 h · after running for 40 m". Empty when the history doesn't end in `state` or names
 * nothing before it.
 */
export function historyText(history, state) {
  const list = Array.isArray(history) ? history : [];
  const last = list.at(-1);
  const before = list.at(-2);
  if (!last || last.state !== state || !before || !STATE_WORDS[before.state]) return "";
  const ms = Date.parse(last.at) - Date.parse(before.at);
  return ms > 0 ? `after ${STATE_WORDS[before.state]} for ${span(ms)}` : "";
}
