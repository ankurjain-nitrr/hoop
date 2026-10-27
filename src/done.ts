import { validSession } from "./owner.js";
import type { PrState } from "./prs.js";
import { editWork, type Evidence, prOwners, readWork, type TodoLink, todoLinks, type WorkTodo } from "./work.js";

// The done gate: Claude Code's TaskCompleted hook, run when a todo is marked completed. It refuses
// once per link when a review the todo links to isn't approved or a pull request it owns isn't
// merged; the next completion goes ahead, and the todo keeps a "done without it" note. A todo whose
// subject says the pull request or review is what it delivers is done once that exists. Anything
// unreadable lets the completion go ahead.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** How many refusals a record remembers it told. */
const TOLD_MAX = 50;
/** How long the gate waits for a fresh read of a pull request from `gh`; with no answer by then, it isn't a gap. */
const FRESH_MS = 2000;

/** Where a subject's own action starts: its beginning, or after punctuation, "and" or "then" ("Commit, push, open PR"). */
const START = String.raw`(?:^|[:;,.]\s*|\b(?:and|then)\s+)`;
/**
 * A subject that delivers a pull request: "Open a PR for X", "Open the fix PR", "Ship X: open PR",
 * "Commit, push, open pull request". Not "Rebase open PRs" (open is an adjective there) or "Open pull
 * request links on Home".
 */
const DELIVERS_PR = new RegExp(
  `${START}(?:open|create|raise|file|put up|send|submit)\\s+(?:[\\w'#-]+\\s+){0,2}?(?:PRs?|pull requests?)\\b(?!\\s+(?:links?|lists?|pages?|views?|buttons?|tabs?)\\b)`,
  "i",
);
/** A subject that delivers a review, of a document or of the pull request: "Submit the plan for review", "Send the fix for review". */
const DELIVERS_REVIEW = /\b(?:for|to) (?:a |hoop )?review\b|\bsubmit\b.{0,40}\breview\b/i;
/**
 * A subject whose job answers a review or works on the pull request, not landing it: "Revise the plan",
 * "Answer the review comments", "Fix review findings on #5", "Get PR #5 reviewed", "Draft PR 5's
 * description". Its review and pull request wait on the person after it, so they aren't its gaps.
 * "Fix the bug found in review" lands a fix, and isn't one.
 */
const RESPONDS =
  /\brevise\b|\b(?:answer|reply to|respond to|address|fix|resolve)\s+(?:the\s+|all\s+)?(?:review\b|(?:review\s+)?(?:findings|comments|feedback)\b)|\bget\b.{0,40}\breviewed\b|\b(?:draft|write|update|edit)\b.{0,40}\b(?:description|body|title)\b/i;
/** A review's statuses that still wait on a person or on Claude's next revision; an open quick question isn't a review to approve. */
const UNSETTLED = new Set(["building", "awaiting_review", "commented", "changes_requested", "reopened"]);

/** Whether the subject makes a link of this kind something the todo delivers or answers, not a gap. */
const exempt = (subject: string, kind: TodoLink["kind"]) =>
  RESPONDS.test(subject) || DELIVERS_REVIEW.test(subject) || (kind === "pr" && DELIVERS_PR.test(subject));

/** Whether a hook input is one the gate reads: a TaskCompleted from a valid session's own agent, naming its task. */
export function isDoneInput(input: unknown): input is Obj {
  // A subagent's completion, or an agent team teammate's (Claude Code runs TaskCompleted at its Stop),
  // goes ahead: it mustn't use up the session's one refusal.
  if (!isObj(input) || input.agent_id || input.teammate_name) return false;
  return input.hook_event_name === "TaskCompleted" && validSession(input.session_id) !== undefined && str(input.task_id) !== undefined;
}

/** What the gate needs beside the store's records: the Work API's evidence, and a fresh read of a pull request. */
export type DoneLook = { evidence: Evidence; fresh?: (url: string) => Promise<PrState> };

/** One link the todo isn't done without: its key in `done_told`, and its words. */
type Gap = { key: string; what: string };

/**
 * What a link still waits on, or undefined: a review not approved (one waiting on the person for a
 * revision the todo submitted is its outcome), or a pull request still open.
 */
function gapOf(t: WorkTodo, l: TodoLink): Gap | undefined {
  if (l.kind === "pr") return l.state === "open" ? { key: `${t.id}:${l.url}`, what: `PR #${l.number} isn't merged (${l.url})` } : undefined;
  const start = t.started ?? t.since;
  if (!UNSETTLED.has(l.status) || (l.status === "awaiting_review" && start && l.at >= start)) return undefined;
  return { key: `${t.id}:${l.id}`, what: `the review "${l.title ?? l.id}" isn't approved` };
}

/**
 * The todo's links the gate checks: the reviews its description names, and the pull requests it
 * owns (`prOwners`), each read again from `gh` past the cache; one with no answer in time is left out.
 */
async function linksOf(t: WorkTodo, todos: WorkTodo[], session: string, look: DoneLook): Promise<TodoLink[]> {
  const { evidence } = look;
  const owners = prOwners(
    todos,
    evidence.tracked.filter((x) => x.session === session),
    (u) => evidence.pr(u)?.branch,
  );
  const mine = new Set([...owners].filter(([, ts]) => ts.some((x) => x.id === t.id)).map(([url]) => url));
  const links = todoLinks(t, mine, evidence).filter((l) => l.kind === "review" || mine.has(l.url));
  const fresh = look.fresh;
  if (!fresh) return links;
  const read = await Promise.all(
    links.map(async (l) => {
      if (l.kind !== "pr" || l.state === "merged") return l;
      const p = await Promise.race([fresh(l.url).catch(() => undefined), new Promise<undefined>((r) => setTimeout(r, FRESH_MS))]);
      return p?.state === "merged" || p?.state === "open" ? { ...l, state: p.state } : undefined;
    }),
  );
  return read.filter((l) => l !== undefined);
}

/**
 * The gate's decision on one TaskCompleted hook input: a reason to refuse the completion, or
 * undefined to let it go ahead. Each link refuses once (`done_told`); a completion that goes ahead past
 * a link it told records the todo's `done_without` note.
 */
export async function doneGate(home: string, input: unknown, look: DoneLook): Promise<{ refuse: string } | undefined> {
  try {
    if (!isDoneInput(input)) return undefined;
    const session = validSession(input.session_id)!;
    const id = str(input.task_id)!;
    const record = readWork(home, session);
    const was = record?.todos.find((t) => t.id === id);
    if (!record || !was) return undefined;
    // Claude Code gives the subject and description the task had before this update.
    const subject = str(input.task_subject) ?? was.text;
    const todo: WorkTodo = { ...was, text: subject, ...(str(input.task_description) ? { description: str(input.task_description) } : {}) };
    const links = (await linksOf(todo, record.todos, session, look)).filter((l) => !exempt(subject, l.kind));
    const gaps = links.flatMap((l) => gapOf(todo, l) ?? []);
    if (!gaps.length) return undefined;
    const refuse = editWork(home, session, (r) => {
      const told = Array.isArray(r.done_told) ? r.done_told : [];
      const fresh = gaps.filter((g) => !told.includes(g.key));
      if (fresh.length) {
        r.done_told = [...told, ...fresh.map((g) => g.key)].slice(-TOLD_MAX);
        return refusal(id, subject, gaps);
      }
      r.done_without = { ...r.done_without, [id]: gaps.map((g) => g.what).join("; ") };
      return undefined;
    });
    return refuse ? { refuse } : undefined;
  } catch {
    return undefined;
  }
}

/** The refusal's one line: what the todo waits on, and what to do. */
const refusal = (id: string, subject: string, gaps: Gap[]) =>
  `hoop (once): todo #${id} "${subject.replace(/\s+/g, " ").trim()}" isn't done yet: ${gaps.map((g) => g.what).join("; ")}. Keep it in progress until that's done, or, if the todo is done without it, mark it completed again and hoop notes it as done without it.`;
