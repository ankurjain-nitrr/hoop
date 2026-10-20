import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./audit.js";
import type { FeedbackResult, Hoop } from "./hoop.js";
import { parseMarkdown } from "./markdown.js";
import { HoopError, writeAtomic } from "./util.js";
import { cursorOf, waitForReview } from "./wait.js";

/** What Claude Code sends a PreToolUse hook for ExitPlanMode. */
export type PlanHookInput = { session_id?: string; cwd?: string; tool_input?: { plan?: unknown } };

/** A hook's answer, in Claude Code's PreToolUse output. */
export type PlanDecision = {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "allow" | "deny"; permissionDecisionReason: string };
};

/** The review that holds one session's plan, kept in the hoop folder's `plans/<session>.json`. */
type PlanRecord = { review_id: string; hash: string; cursor: string };

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

/** The review's comments as one message for the agent. */
function feedbackText(result: Extract<FeedbackResult, { status: "reviewed" }>): string {
  const latest = result.feedback.filter((f) => f.revision === result.revision);
  const lines = latest.flatMap((f) => [
    ...(f.summary ? [`${f.reviewer}: ${f.summary}`] : []),
    ...f.comments.map(
      (c) =>
        `${f.reviewer} on ${c.item} line ${c.line}${c.range ? ` ("${c.range.quote}")` : ""}: ${c.body ?? ""}${c.suggestion !== undefined ? ` Suggested: ${c.suggestion}` : ""}`,
    ),
  ]);
  return lines.join("\n");
}

/**
 * Reviews a plan in hoop before the agent leaves plan mode. One review holds each session's plan: the
 * first call submits it, a changed plan becomes a revision, and an unchanged plan whose latest revision
 * is approved goes ahead. Otherwise it waits for the person, and denies with their comments, or with
 * the link when no verdict comes in time. A plan review writes no decision files.
 */
export async function planReview(input: PlanHookInput, hoop: Hoop, opts: { waitMs: number; intervalMs?: number }): Promise<PlanDecision> {
  const plan = typeof input.tool_input?.plan === "string" ? input.tool_input.plan : "";
  if (!plan.trim()) return decide("deny", "The plan is empty, so there is nothing to review. Write the plan, then leave plan mode again.");
  const path = recordPath(hoop.store.home, input.session_id ?? "");
  const hash = hashOf(plan);
  let record = readRecord(path);
  const stale =
    record &&
    (() => {
      try {
        hoop.store.meta(record!.review_id);
        return false;
      } catch {
        return true;
      }
    })();
  if (!record || stale || record.hash !== hash) {
    const doc = parseMarkdown(/^#\s/m.test(plan) ? plan : `# Plan\n\n${plan}`, { slug: "plan" });
    const result = await hoop.submitAny(record && !stale ? { ...doc, review_id: record.review_id } : doc);
    hoop.store.update(result.review_id, { decisions: false });
    record = { review_id: result.review_id, hash, cursor: result.cursor };
    mkdirSync(join(hoop.store.home, "plans"), { recursive: true });
    writeAtomic(path, JSON.stringify(record));
    audit("plan_review", { review_id: record.review_id, outcome: result.outcome });
  }
  const url = hoop.feedback(record.review_id).url;
  if (hoop.store.meta(record.review_id).status === "approved") return decide("allow", `The plan was approved in hoop: ${url}`);
  const result = await waitForReview(hoop, record.review_id, { after: record.cursor, timeoutMs: opts.waitMs, intervalMs: opts.intervalMs });
  writeAtomic(path, JSON.stringify({ ...record, cursor: cursorOf(hoop, record.review_id) }));
  if (result?.status === "reviewed" && result.approved) return decide("allow", `The plan was approved in hoop: ${url}`);
  if (result?.status === "reviewed") {
    const text = feedbackText(result);
    return decide(
      "deny",
      `The plan wasn't approved in hoop. Revise it with this feedback, then leave plan mode again.\n${text || "The reviewer left no comments."}\nReview: ${url}`,
    );
  }
  return decide(
    "deny",
    `No verdict on the plan yet. Stop here and tell the user to review it at ${url}. Once they approve it there, they ask you to go on, and leaving plan mode again finds the approval.`,
  );
}
