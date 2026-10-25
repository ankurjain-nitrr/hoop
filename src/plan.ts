import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Feedback } from "./contract.js";
import type { FeedbackResult, Hoop } from "./hoop.js";
import { parseMarkdown } from "./markdown.js";
import { HoopError, writeAtomic } from "./util.js";
import { cursorOf, receive, waitForReview } from "./wait.js";

/** What Claude Code sends a PreToolUse hook for ExitPlanMode. */
export type PlanHookInput = { session_id?: string; cwd?: string; tool_input?: { plan?: unknown } };

/** A hook's answer, in Claude Code's PreToolUse output. */
export type PlanDecision = {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "allow" | "deny"; permissionDecisionReason: string };
};

/** The review that holds one session's plan, kept in the hoop folder's `plans/<session>.json`. */
export type PlanRecord = { review_id: string; hash: string; cursor: string };

/** What a plan submit did: the session's record, and the reviews the agent hadn't read that kept a changed plan out. */
export type PlanSubmit = PlanRecord & { unread?: Feedback[] };

const decide = (permissionDecision: "allow" | "deny", reason: string): PlanDecision => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason },
});

const hashOf = (plan: string) => createHash("sha256").update(plan).digest("hex");

function recordPath(home: string, session: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new HoopError("the hook's session ID isn't one hoop can use");
  return join(home, "plans", `${session}.json`);
}

function readRecord(path: string): PlanRecord | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PlanRecord;
  } catch {
    return undefined;
  }
}

/**
 * The session's plan review, with this plan in it: the first plan submits a review, a changed plan
 * becomes a revision, and an unchanged one changes nothing. A changed plan over reviews the agent
 * hadn't read isn't submitted: hoop refuses it, and those reviews come back in `unread`, now
 * received. The pages process runs this.
 */
export function submitPlan(hoop: Hoop, session: string, plan: string): PlanSubmit {
  const path = recordPath(hoop.store.home, session);
  const hash = hashOf(plan);
  const record = readRecord(path);
  const stale =
    record &&
    (() => {
      try {
        hoop.store.meta(record.review_id);
        return false;
      } catch {
        return true;
      }
    })();
  if (record && !stale && record.hash === hash) return record;
  const doc = parseMarkdown(/^#\s/m.test(plan) ? plan : `# Plan\n\n${plan}`, { slug: "plan" });
  let result: ReturnType<Hoop["submit"]>;
  try {
    result = hoop.submit(record && !stale ? { ...doc, review_id: record.review_id } : doc);
  } catch (err) {
    const unread = err instanceof HoopError ? (err.detail?.unread as Feedback[] | undefined) : undefined;
    if (record && unread?.length) return { ...record, unread };
    throw err;
  }
  const fresh = { review_id: result.review_id, hash, cursor: result.cursor };
  mkdirSync(join(hoop.store.home, "plans"), { recursive: true });
  writeAtomic(path, JSON.stringify(fresh));
  return fresh;
}

/** Records how much of the plan review's feedback the hook has passed on. The pages process runs this. */
export function savePlanCursor(hoop: Hoop, session: string): void {
  const path = recordPath(hoop.store.home, session);
  const record = readRecord(path);
  if (record) writeAtomic(path, JSON.stringify({ ...record, cursor: cursorOf(hoop, record.review_id) }));
}

type Reviewed = Extract<FeedbackResult, { status: "reviewed" }>;

/** Submitted reviews' answers and comments as one message for the agent, each read against its own revision. */
function feedbackText(hoop: Hoop, reviewId: string, feedback: Feedback[]): string {
  const lines = feedback.flatMap((f) => {
    const items = new Map(hoop.store.revision(reviewId, f.revision).items.map((i) => [i.id, i]));
    return [
      ...(f.summary ? [`${f.reviewer}: ${f.summary}`] : []),
      ...f.answers.map((a) => {
        const item = items.get(a.item);
        const label = item?.choices?.find((c) => c.id === a.choice)?.label;
        const answer = a.choice === "other" ? `in their own words: ${a.text ?? ""}` : `${a.choice}) ${label ?? ""}`.trimEnd();
        // An approval that left a question unanswered took its recommended option; the person didn't pick it.
        if (a.recommended) return `${f.reviewer} approved without answering "${item?.title ?? a.item}", so hoop took the recommended option: ${answer}`;
        return `${f.reviewer} answered "${item?.title ?? a.item}": ${answer}`;
      }),
      ...f.comments.map(
        (c) =>
          `${f.reviewer} on ${c.item} line ${c.line}${c.range ? ` ("${c.range.quote}")` : ""}: ${c.body ?? ""}${c.suggestion !== undefined ? ` Suggested: ${c.suggestion}` : ""}`,
      ),
    ];
  });
  return lines.join("\n");
}

/**
 * Reviews a plan in hoop before the agent leaves plan mode. One review holds each session's plan: the
 * first call submits it, a changed plan becomes a revision, and an unchanged plan whose latest revision
 * is approved goes ahead. Otherwise it waits for the person, and denies with their comments, or with
 * the link when no verdict comes in time.
 */
export async function planReview(input: PlanHookInput, hoop: Hoop, opts: { waitMs: number; intervalMs?: number }): Promise<PlanDecision> {
  const plan = typeof input.tool_input?.plan === "string" ? input.tool_input.plan : "";
  if (!plan.trim()) return decide("deny", "The plan is empty, so there is nothing to review. Write the plan, then leave plan mode again.");
  const session = input.session_id ?? "";
  recordPath(hoop.store.home, session);
  const record = hoop.remote
    ? await hoop.remote.post<PlanSubmit>("plan", { session, plan, agent: hoop.actor, place: hoop.remote.place(hoop.actor) })
    : submitPlan(hoop, session, plan);
  const reviewId = record.review_id;
  const current = hoop.feedback(reviewId);
  const { url } = current;
  // A changed plan isn't submitted over feedback the agent never got, such as a review that came after a wait timed out.
  // An approval the agent missed approved the previous plan; the changed plan still needs its own review.
  if (record.unread?.length && record.unread.every((f) => f.verdict === "approved")) {
    const text = feedbackText(hoop, reviewId, record.unread);
    return decide(
      "deny",
      `Your previous plan was approved in hoop: ${url}${text ? `\n${text}` : ""}\nThis changed plan needs a new review: leave plan mode again to send it.`,
    );
  }
  if (record.unread?.length)
    return decide(
      "deny",
      `The plan has feedback in hoop you hadn't read, so hoop didn't submit the changed plan. Revise it with this feedback, then leave plan mode again.\n${feedbackText(hoop, reviewId, record.unread) || "The reviewer left no comments."}\nReview: ${url}`,
    );
  const latest = (result: Reviewed) => result.feedback.filter((f) => f.revision === result.revision);
  // An approval passes on its notes and answers, including the recommended options it took.
  const approved = (result: Reviewed) => {
    const text = feedbackText(hoop, reviewId, latest(result));
    return decide("allow", `The plan was approved in hoop: ${url}${text ? `\n${text}` : ""}`);
  };
  // Received, so the session's next plan isn't refused over an approval it already passed on.
  if (current.status === "reviewed" && current.approved) {
    await receive(hoop, reviewId);
    return approved(current);
  }
  const result = await waitForReview(hoop, record.review_id, { after: record.cursor, timeoutMs: opts.waitMs, intervalMs: opts.intervalMs });
  if (hoop.remote) await hoop.remote.post("plan_cursor", { session, agent: hoop.actor });
  else savePlanCursor(hoop, session);
  if (result?.status === "reviewed" && result.approved) return approved(result);
  if (result?.status === "reviewed") {
    const text = feedbackText(hoop, reviewId, latest(result));
    // A plan is approved only once no question is left in it, so answers are written in.
    const answered = latest(result).some((f) => f.answers.length) ? " Write the answers into the plan and remove the Question sections." : "";
    return decide(
      "deny",
      `The plan wasn't approved in hoop. Revise it with this feedback, then leave plan mode again.${answered}\n${text || "The reviewer left no comments."}\nReview: ${url}`,
    );
  }
  return decide(
    "deny",
    `No verdict on the plan yet. Stop here and tell the user to review it at ${url}. Once they approve it there, they ask you to go on, and leaving plan mode again finds the approval.`,
  );
}
