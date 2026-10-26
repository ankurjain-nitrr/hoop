// The agent evals' deterministic checks: a trial's record (Claude's stream-json transcript and the
// hoop data it left) in, a pass or a named failure per check out. No model grades anything.

/** One tool call from the transcript, with its parsed result once it came back. */
export type Call = { id: string; name: string; input: Record<string, any>; result?: any; error?: boolean };

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
  feedback: { revision: number; verdict: string; session?: unknown; answers?: { item: string; choice: string }[] }[];
  threads: { thread: string; status: string; revision: number; item: string; line: number; outdated: boolean; entries: { role: string; at: string }[] }[];
  edits: { id: string; thread: string; status: string; find: string; replace: string }[];
};
/** What a trial leaves: written by the runner, and kept as fixtures in test/fixtures/evals/. */
export type TrialRecord = {
  scenario: string;
  script: number;
  trial: number;
  model?: string;
  hoop?: string;
  plugin?: string;
  transcript: unknown[];
  reviews: ReviewRecord[];
  person?: { step: string; error?: string }[];
};
export type Trial = { record: TrialRecord; calls: Call[]; text: string[]; turns: number; cost: number };
/** A check passes with undefined; a failure says why and, when it can, the index of the call at fault. */
export type Check = { name: string; run: (t: Trial) => undefined | string | { reason: string; at: number } };
export type Outcome = { check: string; pass: boolean; reason?: string; around?: string[] };

const short = (name: string) => name.replace(/^mcp__(?:plugin_)?hoop(?:_hoop)?__/, "");
const parsed = (content: unknown) => {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("") : "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Claude's tool calls (hoop's without their MCP prefix), its text, and the turns and spend the run reported. */
export function parseTranscript(events: unknown[]): Omit<Trial, "record"> {
  const calls: Call[] = [];
  const text: string[] = [];
  let turns = 0,
    cost = 0;
  for (const e of events as any[]) {
    for (const b of e?.message?.content ?? []) {
      if (e.type === "assistant" && b.type === "text") text.push(b.text);
      if (e.type === "assistant" && b.type === "tool_use") calls.push({ id: b.id, name: short(b.name), input: b.input ?? {} });
      if (e.type === "user" && b.type === "tool_result") {
        const call = calls.find((c) => c.id === b.tool_use_id);
        if (call) Object.assign(call, { result: parsed(b.content), ...(b.is_error ? { error: true } : {}) });
      }
    }
    // Each `claude -p` run (the first, and each resume after a review) ends with its own result.
    if (e?.type === "result") {
      turns += e.num_turns ?? 0;
      cost += e.total_cost_usd ?? 0;
    }
  }
  return { calls, text, turns, cost };
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
