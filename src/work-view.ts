// The Work page's view of the sessions' work: each session with its todos, subagents, requests
// and what it does now, linked to the reviews and pull requests their text names. It reads the work
// records that src/work.ts keeps, and changes only which person's changes it has seen read.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { type Activity, RECENT_MS, recentSteps, type Step, transcriptActivity, transcriptReads, waitsOn } from "./activity.js";
import { sessionName } from "./owner.js";
import { parseEntry, tailLines } from "./transcript.js";
import { type AgentLink, type AgentMeta, agentEnd, agentMeta, failReason, isRealAgent, outcomeOf, plainStep, reportLinks } from "./subagents.js";
import { parsePrUrl, type PrState } from "./prs.js";
import { type Queued, type Request, transcriptRequests } from "./requests.js";
import { type TodoTools, todoTools } from "./todo-tools.js";
import { oneLine, opt } from "./util.js";
import { type ClaudeSession, claudeSessions, type SessionReader } from "./claude-sessions.js";
import { LINE_MAX, str } from "./work-events.js";
import { blockedBy, blockersOf, hasQueue, inQueue, ordered, parkedTodo, removedTodo } from "./work-queue.js";
import { requestOf } from "./work-settle.js";
import { REVIEW_LINK } from "../web/links.js";

import {
  type TodoLink,
  type WorkAgent,
  type WorkChange,
  type WorkRecord,
  type WorkTodo,
  endedBy,
  prompted,
  readWork,
  sessionTranscript,
  sinceOf,
  startOf,
  workRecords,
} from "./work.js";

type Obj = Record<string, unknown>;

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
    for (const line of tailLines(path, STEP_BYTES, STEP_BYTES).reverse()) {
      step = lineStep(line);
      if (step !== undefined) break;
    }
  } catch {
    /* unreadable */
  }
  steps.set(path, { key, step });
  return step;
}

/** The step a transcript line shows: an assistant message's last tool call, else its last text. */
function lineStep(line: string): string | undefined {
  if (!line.includes('"assistant"')) return undefined;
  const v = parseEntry(line) as { type?: string; message?: { content?: unknown } } | undefined;
  if (v?.type !== "assistant" || !Array.isArray(v.message?.content)) return undefined;
  const parts = [...(v.message.content as { type?: string; name?: string; input?: Obj; text?: string }[])].reverse();
  const use = parts.find((p) => p.type === "tool_use" && p.name);
  if (use) {
    const what = str(use.input?.description) ?? str(use.input?.command) ?? str(use.input?.file_path) ?? str(use.input?.pattern) ?? str(use.input?.url);
    return oneLine(what ? `${use.name}: ${what}` : use.name!, LINE_MAX);
  }
  const said = parts.find((p) => p.type === "text" && str(p.text));
  return said ? oneLine(said.text!, LINE_MAX) : undefined;
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
  /** Whether it has the todo tools, for a session without todos: the page says how to turn them on. */
  todo_tools?: TodoTools;
  /** What the person asked for, oldest first, with the todos each became. */
  requests?: ViewRequest[];
  /** The messages queued for the agent, and the person's it picked up lately, with the todos each became. */
  waiting?: WaitingMessage[];
  /** The open or unread pull requests it opened that no todo names or ran alone for (`prOwners`); the Work API adds them. */
  prs?: TodoLink[];
};

/**
 * A request on the Work page: the todos that came from it, and whether it's `unregistered`, a prompt
 * no todo came from that the person hasn't dismissed, made once hoop recorded sources and answered.
 */
type ViewRequest = Request & { todos: string[]; dismissed?: true; unregistered?: true; title?: string };

/** How many requests the Work page lists for a session, the latest ones. */
const REQUESTS_SHOWN = 30;
/** How many dismissals a record keeps. */
export const DISMISSED_MAX = 500;

/** Words a question starts with, asked with or without its question mark. */
const QUESTION = /^(?:what|how|is|are|did|can|why|should|do|does)\b/i;

/** A message queued while the agent worked, as the Work page shows it. */
type WaitingMessage = Omit<Queued, "request" | "passed"> & { todos?: string[] };

/** How long a message still reads as waiting when nothing shows it was picked up. */
const WAITING_MAX_MS = 2 * 60 * 60_000;

/**
 * The messages queued for the agent, oldest first: those still in Claude Code's queue while the
 * session is busy, which may be another session's (the queue doesn't say whose a message is), and
 * the person's the agent picked up in the last five minutes, with when and the todos each became. An
 * ended session has none, and an idle one none still waiting, since Claude Code takes the queue when
 * a turn ends. One still queued stops waiting once a turn the person started went ahead of it, or
 * after two hours; a turn a notification or a peer started leaves it waiting.
 */
function waitingMessages(r: WorkRecord, transcript: string | undefined, state: WorkSession["state"], now: number): WaitingMessage[] {
  if (state === "ended" || !transcript) return [];
  const scan = transcriptRequests(transcript);
  const queue = new Set(scan?.queue ?? []);
  const left = (q: Queued) => state === "busy" && queue.has(q) && !q.passed && now - Date.parse(q.at) <= WAITING_MAX_MS;
  return (scan?.queued ?? [])
    .filter((q) => (q.picked ? now - Date.parse(q.picked) <= RECENT_MS : left(q)))
    .map(({ request, passed: _passed, ...q }) => {
      const todos = request ? r.todos.filter((t) => requestOf(t, r.changes ?? []) === request).map((t) => t.id) : [];
      return { ...q, text: q.text.replace(/\s+/g, " ").trim().slice(0, 300), ...(todos.length ? { todos } : {}) };
    });
}

/**
 * Whether a prompt reads as asking for work no todo came from: its turn edited files and neither
 * created nor updated a todo, and it is no question or short reply ("thanks", "yes").
 */
const asksForWork = (q: Pick<Request, "text" | "changed" | "created">) => {
  const text = q.text.trim();
  return Boolean(q.changed && !q.created) && !text.endsWith("?") && !QUESTION.test(text) && text.split(/\s+/).length >= 5;
};

/** A session's latest requests with the todos each became, from its transcript; none when it can't be read. */
function viewRequests(r: WorkRecord, transcript: string | undefined, state: WorkSession["state"]): ViewRequest[] {
  const scan = transcript ? transcriptRequests(transcript) : undefined;
  if (!scan) return [];
  const all = scan.requests.slice(-REQUESTS_SHOWN);
  const dismissed = new Set(Array.isArray(r.dismissed) ? r.dismissed : []);
  return all.map((q, n) => {
    const todos = r.todos.filter((t) => requestOf(t, r.changes ?? []) === q.id).map((t) => t.id);
    // The latest request of a busy session is still being worked on.
    const answered = n < all.length - 1 || state !== "busy";
    const open = q.kind === "prompt" && asksForWork(q) && !todos.length && answered && Boolean(r.sources_from && q.at >= r.sources_from);
    if (dismissed.has(q.id)) return { ...q, todos, dismissed: true as const };
    return { ...q, todos, ...(open ? { unregistered: true as const } : {}) };
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
  /** While the call waits on the person: a hoop review or ask (`review`), AskUserQuestion (`question`), or a permission prompt for it (`permission`). */
  waiting?: "review" | "question" | "permission" | "dialog";
};

/** What an open call does, as a Doing; `asked` while a permission prompt for it waits. */
const openDoing = (step: Step, asked = false): Doing => {
  const waiting = asked ? "permission" : waitsOn(step.tool);
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
  asked = false,
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
  if (a?.open) return openDoing(a.open, asked);
  const latest = a?.steps[a.steps.length - 1];
  return latest ? { what: latest.what, at: latest.at, open: false } : agentLine();
}

/** A session's queued todos in the order the Work view shows, for the agent; none when it has no work. */
export function workQueue(home: string, session: string) {
  const r = readWork(home, session);
  const todos = r
    ? ordered(r)
        .filter((t) => inQueue(r, t))
        .map((t) => {
          const blocked = blockersOf(r, t).map((b) => b.id);
          return { id: t.id, text: t.text, ...(t.description ? { description: t.description } : {}), ...(blocked.length ? { blocked_by: blocked } : {}) };
        })
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
const ENDED_MS = 60 * 60_000;

/** Whether `text` names the pull request at `url`: by its URL, its `#N`, or its head branch (one with a "/", "-" or "_"). */
export function namesPr(text: string | undefined, url: string, branch?: string): boolean {
  const n = parsePrUrl(url)?.number;
  if (!text || n === undefined) return false;
  if (new RegExp(`${escapeRe(url)}(?!\\d)`).test(text) || new RegExp(`(?<![\\w/&])#${n}(?!\\d)`).test(text)) return true;
  if (!branch || !/[/_-]/.test(branch)) return false;
  return new RegExp(`(?<![\\w./-])${escapeRe(branch)}(?![\\w/-])`).test(text);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a todo ran at `at`: it had started, and it still runs or was done after then. */
const ranAt = (t: WorkTodo, at: string) => {
  const start = startOf(t);
  return Boolean(start && start <= at && (t.status === "running" || (t.status === "done" && sinceOf(t) >= at)));
};

/**
 * The todos each pull request a session tracked belongs to, by URL: of the todos that had started by
 * the time it was opened, those whose subject names it (`namesPr`), else those whose description
 * does; else the one todo running when it was opened. None (an empty list) when no such todo names it
 * and several or none ran then: it belongs to the session. A todo started later never takes it, as
 * one that "Builds on #N".
 */
export function prOwners(todos: WorkTodo[], tracked: { url: string; added: string }[], branchOf: (url: string) => string | undefined) {
  const owners = new Map<string, WorkTodo[]>();
  for (const p of tracked) {
    const branch = branchOf(p.url);
    const started = todos.filter((t) => {
      const at = startOf(t);
      return at !== undefined && at <= p.added;
    });
    const bySubject = started.filter((t) => namesPr(t.text, p.url, branch));
    const named = bySubject.length ? bySubject : started.filter((t) => namesPr(t.description, p.url, branch));
    const ran = todos.filter((t) => ranAt(t, p.added));
    if (named.length) owners.set(p.url, named);
    else owners.set(p.url, ran.length === 1 ? ran : []);
  }
  return owners;
}

/** What a pull request's link keeps of its state, once read. */
const PR_KEPT = ["checks", "review_requested", "ready", "draft", "opened_at", "merged_at"] as const;

/** A pull request as a todo's or session's link, from its state as last read (`unknown` before the first read). */
function prLink(url: string, p: PrState | undefined, opened: boolean): TodoLink {
  const known = p && p.state !== "unknown" && p.state !== "gone";
  const extra = known ? Object.fromEntries(PR_KEPT.filter((k) => p[k]).map((k) => [k, p[k]])) : {};
  const state = known ? (p.state as "open" | "merged") : "unknown";
  return { kind: "pr", url, number: parsePrUrl(url)!.number, state, ...(opened ? { opened: true as const } : {}), ...extra };
}

/** Whether a pull request's state as last read is settled other than merged: closed or gone, or merged when `merged` is false. */
const settledPr = (p: PrState | undefined, merged: boolean) => Boolean(p && p.state !== "unknown" && p.state !== "open" && !(merged && p.state === "merged"));

/** The reviews among a todo's links, each titled in `reviews`. */
function reviewLinks(urls: string[], look: Pick<Evidence, "review">, reviews: Record<string, string>): TodoLink[] {
  const links: TodoLink[] = [];
  for (const url of urls) {
    const id = url.match(REVIEW_LINK)?.[1];
    const r = id && !reviews[id] ? look.review(id) : undefined;
    if (!id || !r) continue;
    if (r.title) reviews[id] = r.title;
    links.push({ kind: "review", id, ...r });
  }
  return links;
}

/**
 * One todo's links: the reviews its description names, and the pull requests it names that are open or
 * not read yet (a merged or closed one it names is context, such as what it builds on), with those of
 * `mine`, the session's pull requests it owns (`prOwners`), merged too. `reviews` gets each review's title.
 */
export function todoLinks(t: WorkTodo, mine: Set<string>, look: Pick<Evidence, "review" | "pr">, reviews: Record<string, string> = {}, prs = true): TodoLink[] {
  const urls = (t.description?.match(LINKS) ?? []).map((u) => u.replace(/[.,;:!?'"*_`]+$/, ""));
  const links = reviewLinks(urls, look, reviews);
  if (prs)
    for (const url of new Set([...urls.filter((u) => parsePrUrl(u)), ...mine])) {
      const p = look.pr(url);
      if (!settledPr(p, mine.has(url))) links.push(prLink(url, p, mine.has(url)));
    }
  return links;
}

/**
 * The view with each todo's linked reviews titled, each running todo's links (`todoLinks`), and the
 * session's `prs`: the open or unread pull requests it tracked that no todo owns. Pull requests of a
 * session that ended over ENDED_MS ago aren't read.
 */
export function linkTodos(view: WorkSession[], look: Evidence, now = Date.now()): WorkSession[] {
  for (const s of view) linkSession(s, look, now);
  return view;
}

/** One session of `linkTodos`. */
function linkSession(s: WorkSession, look: Evidence, now: number) {
  const old = s.state === "ended" && !(now - Date.parse(s.activity ?? s.updated) <= ENDED_MS);
  const owners = old
    ? new Map<string, WorkTodo[]>()
    : prOwners(
        s.todos,
        look.tracked.filter((x) => x.session === s.id),
        (u) => look.pr(u)?.branch,
      );
  for (const t of s.todos) linkTodo(t, owners, look, old);
  const loose = [...owners].filter(([url, ts]) => !ts.length && !settledPr(look.pr(url), false)).map(([url]) => prLink(url, look.pr(url), true));
  if (loose.length) s.prs = loose;
  for (const q of s.requests ?? []) {
    const title = q.review ? look.review(q.review)?.title : undefined;
    if (title) q.title = title;
  }
}

/** A todo's linked reviews titled and, while it runs, its links. A todo of an `old` session links no pull requests. */
function linkTodo(t: WorkTodo, owners: Map<string, WorkTodo[]>, look: Evidence, old: boolean) {
  const reviews: Record<string, string> = {};
  const mine = new Set([...owners].filter(([, ts]) => ts.includes(t)).map(([url]) => url));
  const running = t.status === "running";
  const links = todoLinks(t, mine, look, reviews, running && !old);
  if (Object.keys(reviews).length) t.reviews = reviews;
  if (running && links.length) t.links = links;
}

/**
 * An Agent-started subagent as the Work page shows it. A running agent of a session that ended shows
 * as stopped; one whose transcript ends in an API error, as failed.
 */
function viewAgent(
  { call: _call, unstarted: _unstarted, resumed: _resumed, ...a }: WorkAgent,
  meta: AgentMeta | undefined,
  state: WorkSession["state"],
  cwd?: string,
  prompts?: WorkRecord["prompts"],
): ViewAgent {
  const step = () => (a.transcript ? lastStep(a.transcript) : undefined);
  const last = (a.status === "running" ? step() : undefined) ?? a.last ?? step();
  // Claude Code's meta file names the agent's own call: its description stands over the call hoop paired by guess.
  const description = (meta?.call ? meta.description : undefined) ?? a.description ?? meta?.description;
  const base = { ...a, ...opt("description", description), ...opt("type", a.type ?? meta?.type), ...opt("last", last) };
  if (a.status === "running" && state !== "ended") return runningAgent(base, cwd, prompts);
  return endedAgent(a, base);
}

/** A running subagent of a running session, with what its transcript shows it doing. */
function runningAgent(base: Omit<WorkAgent, "call">, cwd: string | undefined, prompts: WorkRecord["prompts"]): ViewAgent {
  const own = base.transcript ? transcriptActivity(base.transcript, cwd) : undefined;
  if (!own) return base;
  const step = plainStep(own.open?.what ?? own.steps[own.steps.length - 1]?.what);
  return {
    ...base,
    ...opt("activity", own.last),
    ...(own.open ? { doing: openDoing(own.open, prompted(prompts, own.open, base.id)) } : {}),
    ...opt("step", step),
  };
}

/** A subagent that finished or stopped: done with its outcome, failed on an API error, or stopped with why. */
function endedAgent(a: Omit<WorkAgent, "call">, base: Omit<WorkAgent, "call">): ViewAgent {
  const end = agentEnd(a.transcript);
  const report = end?.report ?? a.last;
  const links = report ? reportLinks(report) : [];
  const outcome = report ? outcomeOf(report) : undefined;
  const linked = links.length ? { links } : {};
  if (end?.error && !end.report) return { ...base, ...linked, status: "failed", reason: failReason(end.error) };
  if (a.status === "done") return { ...base, ...linked, ...(outcome ? { outcome } : {}) };
  return { ...base, ...linked, status: "stopped", reason: stopReason(a, end), ...(outcome ? { outcome } : {}) };
}

/** Why an agent that isn't done stopped: a running one, because its session ended. */
function stopReason(a: WorkAgent, end: ReturnType<typeof agentEnd>) {
  if (a.status === "running") return "Stopped: its session ended";
  return end?.interrupted ? "Stopped: the person interrupted it" : "Stopped before it reported back";
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

/** A session's state on the Work page: ended without a process or once SessionEnd counts, busy in a turn or a dialog, else idle. */
function sessionState(live: ClaudeSession | undefined, ended: boolean, dialog: boolean): WorkSession["state"] {
  if (!live || ended) return "ended";
  return live.status === "busy" || dialog ? "busy" : "idle";
}

/** How many sessions the Work page shows, newest first. */
const WORK_SESSIONS_MAX = 30;

/**
 * Every session with work, newest first: running ones by their Claude Code record (busy or idle,
 * name, folder), each subagent with its last step. A running subagent of a session that ended shows
 * as stopped.
 */
export function workView(home: string, readSessions: SessionReader = claudeSessions, now = Date.now()): WorkSession[] {
  const running = new Map(readSessions().map((s) => [s.session, s]));
  const records = workRecords(home).filter((r) => r.todos.length || r.agents.length);
  return records
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, WORK_SESSIONS_MAX)
    .map((r) => viewSession(r, running.get(r.session), home, now));
}

/** A session's record as the Work view shows it, with its Claude Code record `live` while one runs it. */
function viewSession(r: WorkRecord, live: ClaudeSession | undefined, home: string, now: number): WorkSession {
  const cwd = live?.cwd ?? r.cwd;
  const transcript = sessionTranscript(r);
  const activity = transcript ? transcriptActivity(transcript, cwd) : undefined;
  // A session whose dialog waits on the person (`waiting`) is in the middle of its turn while a tool call runs.
  const dialog = live?.status === "waiting" && Boolean(activity?.open);
  // SessionEnd counts while no process runs the session, or one does that hasn't updated since: a
  // resumed session runs again, though no hook has said so yet.
  const ended = endedBy(r, live);
  const state = sessionState(live, ended, dialog);
  const lastSeen = activity?.last ?? (live?.updatedAt ? new Date(live.updatedAt).toISOString() : undefined);
  const agents = r.agents.flatMap((a) => {
    const meta = agentMeta(a.transcript);
    return isRealAgent(a, meta) ? [viewAgent(a, meta, state, cwd, r.prompts)] : [];
  });
  const current = doingNow(state, activity, agents, prompted(r.prompts, activity?.open));
  // Claude Code names what its dialog waits for (`waitingFor`); a call that waits on nothing else waits on it.
  const doing = current?.open && !current.waiting && dialog && live?.waitingFor ? { ...current, waiting: "dialog" as const } : current;
  const recent = recentSteps(activity, now).map(({ tool: _tool, ...s }) => s);
  const { changes, fresh } = readChanges(r.changes ?? [], transcript);
  const requests = viewRequests(r, transcript, state);
  const waiting = waitingMessages(r, transcript, state, now);
  const view: WorkSession = {
    id: r.session,
    ...opt("name", sessionName(r.session, home) ?? live?.name),
    state,
    ...(cwd ? { folder: basename(cwd) } : {}),
    updated: r.updated,
    reachable: Boolean(live?.socket),
    todos: viewTodos(r),
    parked: Array.isArray(r.parked) ? r.parked : [],
    changes,
    agents,
    ...opt("activity", lastSeen),
    ...opt("doing", doing),
    ...opt("recent", nonEmpty(recent)),
    ...(r.todos.length ? {} : { todo_tools: todoTools(transcript, cwd) }),
    ...opt("requests", nonEmpty(requests)),
    ...opt("waiting", nonEmpty(waiting)),
    ...opt("turn_ended", r.turn_ended),
    ...(ended ? { ended: r.ended } : {}),
  };
  if (fresh.length) freshReads.set(view, fresh);
  return view;
}

/** A list, or undefined when it is empty, for `opt`. */
const nonEmpty = <T>(list: T[]): T[] | undefined => (list.length ? list : undefined);

/** A session's todos as the Work view shows them. The person's starts-after links show as the todo's blocked-by, so the page's Blocked by and Up next agree with the gate. */
function viewTodos(r: WorkRecord): WorkTodo[] {
  return ordered(r).map((t) => {
    const blocked = blockedBy(r, t);
    return {
      ...t,
      ...opt("blocked_by", blocked.length > (t.blocked_by?.length ?? 0) ? blocked : undefined),
      ...opt("done_without", t.status === "done" ? r.done_without?.[t.id] : undefined),
    };
  });
}
