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
/** How long the gate waits for a fresh read of an open pull request before it goes by the last one. */
const FRESH_MS = 1000;

/**
 * A subject that delivers a pull request ("Open a PR for X", "Open PR #12", "Open draft PRs") or a
 * review ("Submit the plan for review", "Send it to review"). "Open pull request links on Home" isn't.
 */
const DELIVERS_PR =
  /\b(open|create|raise|file|put up|send|submit)\s+(?:(?:an?|the|its|draft|\d+)\s+)*(?:PRs?|pull requests?)\b(?!\s+(?:links?|list|page|view|button|tab)s?\b)/i;
const DELIVERS_REVIEW = /\b(?:for|to|in) (?:hoop )?review\b|\b(?:submit|send|put up|ask for)\b.{0,40}\breview\b/i;
/** A review's statuses that still wait on a person or on Claude's next revision. */
const UNSETTLED = new Set(["building", "awaiting_review", "commented", "changes_requested", "reopened", "question"]);

/** Whether a hook input is one the gate reads: a TaskCompleted from a valid session, naming its task. */
export function isDoneInput(input: unknown): input is Obj {
  return isObj(input) && input.hook_event_name === "TaskCompleted" && validSession(input.session_id) !== undefined && str(input.task_id) !== undefined;
}

/** What the gate needs beside the store's records: the Work API's evidence, and a fresh read of a pull request. */
export type DoneLook = { evidence: Evidence; fresh?: (url: string) => Promise<PrState> };

/** One link the todo isn't done without: its key in `done_told`, and its words. */
type Gap = { key: string; what: string };

/** What a link still waits on, or undefined: a review not approved, or a pull request still open. */
function gapOf(todo: string, l: TodoLink): Gap | undefined {
  if (l.kind === "review") return UNSETTLED.has(l.status) ? { key: `${todo}:${l.id}`, what: `the review "${l.title ?? l.id}" isn't approved` } : undefined;
  return l.state === "open" ? { key: `${todo}:${l.url}`, what: `PR #${l.number} isn't merged (${l.url})` } : undefined;
}

/** The todo's links as the Work API reads them, each pull request not known merged read again when that answers in time. */
async function linksOf(t: WorkTodo, todos: WorkTodo[], session: string, look: DoneLook): Promise<TodoLink[]> {
  const { evidence } = look;
  const owners = prOwners(
    todos,
    evidence.tracked.filter((x) => x.session === session),
    (u) => evidence.pr(u)?.branch,
  );
  const mine = new Set([...owners].filter(([, ts]) => ts.some((x) => x.id === t.id)).map(([url]) => url));
  const links = todoLinks(t, mine, evidence);
  const fresh = look.fresh;
  if (!fresh) return links;
  return Promise.all(
    links.map(async (l) => {
      if (l.kind !== "pr" || l.state === "merged") return l;
      const p = await Promise.race([fresh(l.url).catch(() => undefined), new Promise<undefined>((r) => setTimeout(r, FRESH_MS))]);
      return p?.state === "merged" || p?.state === "open" ? { ...l, state: p.state } : l;
    }),
  );
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
    const links = (await linksOf(todo, record.todos, session, look)).filter((l) => !(l.kind === "pr" ? DELIVERS_PR : DELIVERS_REVIEW).test(subject));
    const gaps = links.flatMap((l) => gapOf(id, l) ?? []);
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
