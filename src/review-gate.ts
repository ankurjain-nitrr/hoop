// The gate on file writes while a session's own review waits on the person (decided in
// rv_mw7pt2ccf618dc): the first file write or edit the session makes while its review's latest
// revision waits for the person's review is refused once, naming the review, its link and what it
// waits for. The way out: wait for the person (hoop_wait, or end the turn and be told), or, when the
// change isn't the work the review plans, make it again, which goes on. A new revision is a new cause.
// It runs in the pages process, from the Work gate's hook, and never calls a model.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewUrl } from "./hoop.js";
import { validSession } from "./owner.js";
import { clearReviewWait, reviewMarkPath } from "./review-mark.js";
import { writesFiles } from "./shell-writes.js";
import type { ReviewMeta, Store } from "./store.js";
import { isRecord, tryReadJson } from "./util.js";

/** How many told reviews a session's record keeps. */
const TOLD_MAX = 50;

/** Whether `session` submitted the review: its owner, under this ID or an earlier one. */
const ownedBy = (m: ReviewMeta, session: string) => m.owner?.session === session || Boolean(m.owners?.includes(session));

/**
 * The reviews `session` submitted that wait on the person now: open, not closed, not a quick question
 * or a build or a review the person opened, and with no review by the person on the latest revision.
 */
function waitingReviews(store: Store, session: string): ReviewMeta[] {
  // The plan hook's review of the session's plan: plan mode already keeps Claude from writing until it is approved.
  const plan = tryReadJson<{ review_id?: unknown }>(join(store.home, "plans", `${session}.json`))?.review_id;
  return store
    .list()
    .filter((m) => m.revisions > 0 && m.status === "open" && !m.closed && !m.ask && m.build !== "open" && !m.opened_by && !m.sample)
    .filter((m) => ownedBy(m, session) && m.id !== plan)
    .filter((m) => !reviewedOrUnknown(store, m));
}

/**
 * Whether the person reviewed the latest revision, or hoop can't tell: a feedback file that doesn't
 * read as a list of reviews counts as reviewed, so a broken folder never refuses a write.
 */
function reviewedOrUnknown(store: Store, m: ReviewMeta): boolean {
  try {
    const dir = store.dirOf(m.id);
    // The review's own record must read as one, where its feedback would be.
    if (!isRecord(JSON.parse(readFileSync(join(dir, "review.json"), "utf8")))) return true;
    const file = join(dir, `feedback-${m.revisions}.json`);
    if (!existsSync(file)) return false;
    const read: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(read)) return true;
    const list: unknown[] = read;
    return list.some((f: unknown) => !isRecord(f) || !f.session);
  } catch {
    return true;
  }
}

const toldPath = (home: string, session: string) => join(home, "work", `${session}.review-told`);
const toldOf = (home: string, session: string): string[] => {
  const path = toldPath(home, session);
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
};

/** What the refusal says: the review, its link, what it waits for, and the way out. */
function message(m: ReviewMeta): string {
  return (
    `Your review "${m.title}" (${reviewUrl(m.id)}) waits on the person to review revision ${m.revisions}, so hold off on changing files ` +
    `for the work it plans until they approve it. Wait with hoop_wait ${m.id}, or end your turn and hoop tells you when they review. ` +
    "If this change isn't part of that work, make it again: it goes on (hoop says this once for each revision)."
  );
}

/** What a subagent's refusal says: the session's review waits, and the subagent hands back rather than waiting itself. */
function agentMessage(m: ReviewMeta): string {
  return (
    `The session's review "${m.title}" (${reviewUrl(m.id)}) waits on the person to review revision ${m.revisions}, so don't change files ` +
    "for the work it plans: stop and report back to the session that started you. " +
    "If this change isn't part of that work, make it again: it goes on (hoop says this once for each revision)."
  );
}

/**
 * The gate on one PreToolUse call: a refusal, once for each revision of each review the session
 * submitted that waits on the person, of a file write or edit (a file tool, or a shell command that
 * writes). A subagent's write gets its own refusal, once per subagent, which tells it to report back
 * and leaves the session's own refusal for the session. Anything else, or anything unreadable,
 * passes. Whatever the call, once nothing is left to tell the session, it clears the session's gate
 * file, so later calls start no process until the next submit.
 */
export function reviewGate(store: Store, input: unknown): string | undefined {
  const i = isRecord(input) ? input : undefined;
  const session = validSession(i?.session_id);
  if (!i || !session || i.hook_event_name !== "PreToolUse" || !existsSync(reviewMarkPath(store.home, session))) return undefined;
  const told = toldOf(store.home, session);
  const key = (m: ReviewMeta) => `${m.id}@${m.revisions}`;
  const left = waitingReviews(store, session).filter((m) => !told.includes(key(m)));
  if (!left.length) {
    clearReviewWait(store.home, session);
    return undefined;
  }
  if (!writesFiles(i.tool_name, isRecord(i.tool_input) ? i.tool_input : {})) return undefined;
  const agent = typeof i.agent_id === "string" && i.agent_id ? i.agent_id : undefined;
  const untold = agent ? left.filter((m) => !told.includes(`${agent}:${key(m)}`)) : left;
  if (!untold.length) return undefined;
  const keys = untold.map((m) => (agent ? `${agent}:${key(m)}` : key(m)));
  writeFileSync(toldPath(store.home, session), `${[...told, ...keys].slice(-TOLD_MAX).join("\n")}\n`);
  // The session has been told about everything that waits: its later calls start no process.
  if (!agent) clearReviewWait(store.home, session);
  return untold.map(agent ? agentMessage : message).join(" ");
}
