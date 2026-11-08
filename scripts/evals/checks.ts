// The agent evals' deterministic checks: a trial's record (Claude's stream-json transcript and the
// hoop data it left) in, a pass or a named failure per check out. No model grades anything.

/** One tool call from the transcript, with its parsed result once it came back; a subagent's names the Agent call that started it (`parent`). */
export type Call = { id: string; name: string; input: Record<string, any>; result?: any; error?: boolean; parent?: string };
/** Claude's text to the person, with how many tool calls came before it. */
export type Said = { text: string; at: number };

export type Line = { item: string; line: number; text: string };
export type Revision = {
  revision: number;
  title: string;
  tldr: string;
  /** Every commentable line, as the review page numbers it: DOC 1 and 2, each item's heading (0) and lines. */
  lines: Line[];
  questions: { id: string; choices: { id: string; label: string; recommended?: boolean }[] }[];
};
export type ReviewRecord = {
  id: string;
  status: string;
  revisions: Revision[];
  /** Every stored review: the person's (no session) and the session's own comments. */
  feedback: {
    revision: number;
    verdict: string;
    session?: unknown;
    comments: { thread?: string }[];
    answers?: { item: string; choice: string; recommended?: boolean }[];
  }[];
  threads: { thread: string; status: string; revision: number; item: string; line: number; outdated: boolean; entries: { role: string; at: string }[] }[];
  edits: { id: string; thread: string; status: string; find: string; replace: string; applied_revision?: number }[];
};
/** The session's work as hoop recorded it: its todos, its subagents and the person's changes from the Work page. */
export type WorkSnapshot = {
  todos: { id: string; text: string; status: string }[];
  agents: { id: string; description?: string; status: string; call?: string }[];
  changes: { kind: string; todo?: string; agent?: string; at: string }[];
};
/** What a trial leaves: written by the runner, and kept as fixtures in test/fixtures/evals/. */
export type TrialRecord = {
  scenario: string;
  script: number;
  trial: number;
  model?: string;
  hoop?: string;
  /** The plugin's commit, marked dirty when the checkout has changes the commit doesn't hold. */
  plugin?: string;
  /** The plugin's version, from its plugin.json, and the SHA-256 of its files (`pluginHash`). */
  plugin_version?: string;
  plugin_hash?: string;
  transcript: unknown[];
  reviews: ReviewRecord[];
  work?: WorkSnapshot;
  /** Each step the person took, with how many of Claude's tool calls (`at`) and texts (`said`) came before it. */
  person?: { step: string; at?: number; said?: number; error?: string }[];
  /** `git status --porcelain` of the trial's repository, the first time it wasn't clean before the person approved. */
  dirty_before_approval?: string[];
  /** The trial hit its time limit and its last run was killed, so its turns and spend are a lower bound. */
  timed_out?: true;
};
/** A run's result subtypes that mean it stopped at a limit (`--max-turns`, `--max-budget-usd`), not because Claude ended its turn. */
export const LIMITS = ["error_max_turns", "error_max_budget_usd"];
/**
 * A trial as the checks read it: Claude's calls and text; where each `claude -p` run ended its turn
 * (`ends`, the number of calls before each run's result; a run stopped at a limit didn't end its
 * turn, so it isn't one); and what hoop's SessionStart hook told the session (`contexts`), with the
 * number of calls before it.
 */
export type Trial = { record: TrialRecord; calls: Call[]; text: string[]; said: Said[]; ends: number[]; contexts: Said[]; turns: number; cost: number };
/** A check passes with undefined; a failure says why and, when it can, the index of the call at fault. */
export type Check = { name: string; run: (t: Trial) => undefined | string | { reason: string; at: number } };
export type Outcome = { check: string; pass: boolean; reason?: string; around?: string[] };

const short = (name: string) => name.replace(/^mcp__(?:plugin_)?hoop(?:_hoop)?__/, "");
/** A tool result's text: the string, or its text blocks joined. */
const textOf = (content: unknown) => {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((c) => c?.text ?? "").join("") : "";
};
const parsed = (content: unknown) => {
  const text = textOf(content);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** The context a SessionStart hook added to the session, from its stream-json `hook_response` event, if this is one. */
function sessionContext(e: any): string | undefined {
  if (e?.type !== "system" || e.subtype !== "hook_response" || e.hook_event !== "SessionStart") return undefined;
  try {
    const context = JSON.parse(String(e.output ?? "")).hookSpecificOutput?.additionalContext;
    return typeof context === "string" ? context : undefined;
  } catch {
    return undefined;
  }
}

/** One block of a message: Claude's text or tool call, or a tool's result, which goes on its call. */
function readBlock(e: any, b: any, calls: Call[], said: Said[]) {
  const type = e.type;
  // A subagent's own messages carry the Agent call that started it; only the session's text is Claude's word to the person.
  const parent = typeof e.parent_tool_use_id === "string" ? e.parent_tool_use_id : undefined;
  if (type === "assistant" && b.type === "text" && !parent) said.push({ text: b.text, at: calls.length });
  if (type === "assistant" && b.type === "tool_use") calls.push({ id: b.id, name: short(b.name), input: b.input ?? {}, ...(parent ? { parent } : {}) });
  if (type === "user" && b.type === "tool_result") {
    const call = calls.find((c) => c.id === b.tool_use_id);
    if (call) Object.assign(call, { result: parsed(b.content), ...(b.is_error ? { error: true } : {}) });
  }
}

/** Claude's tool calls (hoop's without their MCP prefix), its text, and the turns and spend the run reported. */
export function parseTranscript(events: unknown[]): Omit<Trial, "record"> {
  const calls: Call[] = [];
  const said: Said[] = [];
  const ends: number[] = [];
  const contexts: Said[] = [];
  let turns = 0,
    cost = 0;
  for (const e of events as any[]) {
    for (const b of e?.message?.content ?? []) readBlock(e, b, calls, said);
    // Each `claude -p` run (the first, and each resume after a review) ends with its own result.
    if (e?.type === "result") {
      turns += e.num_turns ?? 0;
      cost += e.total_cost_usd ?? 0;
      if (!LIMITS.includes(e.subtype ?? "")) ends.push(calls.length);
    }
    const context = sessionContext(e);
    if (context) contexts.push({ text: context, at: calls.length });
  }
  return { calls, text: said.map((x) => x.text), said, ends, contexts, turns, cost };
}

export const trialOf = (record: TrialRecord): Trial => ({ record, ...parseTranscript(record.transcript) });

/** Runs each check; a failure names it and shows the calls around the one at fault. */
export function score(t: Trial, checks: Check[]): Outcome[] {
  return checks.map((c) => {
    let out: ReturnType<Check["run"]>;
    try {
      out = c.run(t);
    } catch (err) {
      out = `the check threw: ${(err as Error).message}`;
    }
    if (out === undefined) return { check: c.name, pass: true };
    const { reason, at } = typeof out === "string" ? { reason: out, at: -1 } : out;
    const around =
      at < 0
        ? []
        : t.calls
            .slice(Math.max(0, at - 2), at + 3)
            .map((x, i) => `${i + Math.max(0, at - 2) === at ? ">" : " "} ${x.name} ${JSON.stringify(x.input).slice(0, 160)}`);
    return { check: c.name, pass: false, reason, around };
  });
}

// Helpers the scenarios' checks share.

/** The review Claude submitted first: the one the scenario is about. */
export const reviewOf = (t: Trial): ReviewRecord | undefined => t.record.reviews[0];
export const callsOf = (t: Trial, name: string) => t.calls.flatMap((c, i) => (c.name === name ? [{ ...c, at: i }] : []));
/** How many times Claude's text gave the review's link. */
export const linkCount = (t: Trial, id: string) => t.text.join("\n").split(`/r/${id}`).length - 1;
/** The index of the first call whose result says the review is approved, or the number of calls. */
export const approvedAt = (t: Trial) => {
  const i = t.calls.findIndex((c) => c.name.startsWith("hoop_") && c.result?.approved === true);
  return i < 0 ? t.calls.length : i;
};

/** Exactly one review, and every later submit revises it rather than starting another. */
export const oneReview: Check = {
  name: "one-review",
  run: (t) => {
    const r = reviewOf(t);
    if (!r) return "Claude submitted no review";
    if (t.record.reviews.length > 1) return `Claude started ${t.record.reviews.length} reviews instead of revising one`;
    const stray = callsOf(t, "hoop_submit")
      .slice(1)
      .find((c) => c.input.document?.review_id !== r.id && c.input.review_id !== r.id);
    return stray ? { reason: "a later hoop_submit didn't revise the review", at: stray.at } : undefined;
  },
};

/** Every hoop_wait passes the cursor from the latest hoop result that gave one. */
export const waitsWithCursor: Check = {
  name: "waits-with-cursor",
  run: (t) => {
    let cursor: string | undefined;
    for (const [i, c] of t.calls.entries()) {
      if (c.name === "hoop_wait" && cursor && c.input.after !== cursor)
        return { reason: `hoop_wait passed after=${c.input.after}, not the cursor ${cursor}`, at: i };
      if (c.name.startsWith("hoop_") && typeof c.result?.cursor === "string") cursor = c.result.cursor;
    }
    return callsOf(t, "hoop_wait").length ? undefined : "Claude never called hoop_wait";
  },
};

/** Claude wrote nothing before the person approved: no Write or Edit call, and no change in the repository. */
export const noWritesBeforeApproval: Check = {
  name: "no-writes-before-approval",
  run: (t) => {
    const i = t.calls.findIndex((c, n) => n < approvedAt(t) && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(c.name));
    if (i >= 0) return { reason: `${t.calls[i]!.name} before the person approved`, at: i };
    // A write through Bash (mkdir, touch, a redirect) shows only in the repository.
    const dirty = t.record.dirty_before_approval;
    return dirty?.length ? `the repository changed before the person approved: ${dirty.join(", ")}` : undefined;
  },
};

/** Where the person's step `name` came, as the number of Claude's calls before it; undefined when it didn't run or was refused. */
export const stepAt = (t: Trial, name: string) => t.record.person?.find((p) => p.step === name && !p.error)?.at;

/**
 * What Claude said after the person's step `name`, by the texts said before it: a text with no call
 * between it and the step can't be ordered by calls. None when the step didn't run, or its record
 * doesn't say how many texts came before it.
 */
export function saidAfter(t: Trial, name: string): Said[] {
  const n = t.record.person?.find((p) => p.step === name && !p.error)?.said;
  return n === undefined ? [] : t.said.slice(n);
}

/** A todo, by the ID its task list gives it or by its text, as hoop recorded it. */
const todoOf = (t: Trial, ref: { id?: string; text?: string }) =>
  t.record.work?.todos.find((x) => (ref.id !== undefined ? x.id === ref.id : x.text === ref.text));

/** The todos one of the session's own task list calls sets to `status`; a subagent's calls don't count. */
function movedBy(t: Trial, c: Call, status: string): string[] {
  if (c.parent || c.error) return [];
  if (c.name === "TaskUpdate") return c.input.status === status ? [todoOf(t, { id: String(c.input.taskId) })?.id ?? `#${c.input.taskId}`] : [];
  if (c.name !== "TodoWrite") return [];
  const todos = (c.input.todos ?? []) as { content?: string; status?: string }[];
  return todos.flatMap((x) => (x.status === status ? [todoOf(t, { text: x.content })?.id ?? String(x.content)] : []));
}

/** Each todo the session set to `status` ("in_progress" or "completed"), in order, with the index of the call. */
export const todoMoves = (t: Trial, status: string): { todo: string; at: number }[] =>
  t.calls.flatMap((c, at) => movedBy(t, c, status).map((todo) => ({ todo, at })));

/** The person's Work change of `kind`, as hoop recorded it. */
export const changeOf = (t: Trial, kind: string) => t.record.work?.changes.find((c) => c.kind === kind);

// A shell redirect (`>`, `>>`, `1>`, `&>`) and its target; one to `&N` or /dev/null writes no file.
const REDIRECT = /(?:\d|&)?>>?\s*(&\d+|[^\s;&|<>]+)/g;
// A shell command that writes the files it names: tee, touch, cp, mv, truncate, dd, sed or perl in
// place (`sed -i`, `sed -Ei`, `sed -e … -i`, `perl -pi`), or a script (a python or node heredoc) that
// opens a file to write or append, or calls writeFile. `rm` deliberately doesn't count: deleting a
// file isn't doing its todo.
const SHELL_WRITES = /\b(tee|touch|cp|mv|truncate|dd)\b|\b(sed|perl)\b[^|;&]*\s-[a-zA-Z]*i|\bopen\([^)]*['"][wa]\+?['"]|\bwriteFile(Sync)?\b|\bwrite_text\(/;

/** Whether a shell command writes `file`: a redirect to it, or a writing command that names it. */
function shellWrites(command: string, file: string): boolean {
  if (!command.includes(file)) return false;
  for (const [, to] of command.matchAll(REDIRECT)) if (to && !to.startsWith("&") && to !== "/dev/null" && to.includes(file)) return true;
  return SHELL_WRITES.test(command);
}

/** Whether a call writes `file`: a Write or Edit of it, or a shell command that writes it; `cat` or `ls` of it doesn't. */
export const touches = (c: Call, file: string) =>
  (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(c.name) && String(c.input.file_path ?? c.input.notebook_path ?? "").endsWith(file)) ||
  (c.name === "Bash" && shellWrites(String(c.input.command ?? ""), file));
