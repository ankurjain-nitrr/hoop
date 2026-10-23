import type { Feedback } from "./contract.js";
import { receiptKey, type Delivery, type ReviewMeta, type Store } from "./store.js";
import { sendToSession, type Sender } from "./steer.js";
import { isWaiting } from "./wait.js";
import type { ClaudeSession, SessionReader } from "./work.js";

// A person's review reaches the session that asked for it even after the agent stopped waiting: the
// pages process sends the session one message over its messaging socket, and the review page shows
// whether the agent waits, is idle, or has ended.

/**
 * What the agent that owns a review is doing, as the review page shows it: `waiting` in a wait for
 * this review; `idle` or `busy` in a live Claude Code session (`wakes` when a submit can message it);
 * or `ended`, with the session to resume.
 */
export type AgentState = { state: "waiting" } | { state: "idle" | "busy"; session: string; wakes: boolean } | { state: "ended"; session: string };

/** The owner's live Claude Code session, when it runs. */
function liveSession(meta: ReviewMeta, sessions: SessionReader): ClaudeSession | undefined {
  if (!meta.owner || meta.owner.claude === false) return undefined;
  try {
    return sessions().find((s) => s.session === meta.owner!.session);
  } catch {
    return undefined;
  }
}

/** The owner's state for an open review, or undefined for an approved review or one no agent owns. */
export function agentState(store: Store, meta: ReviewMeta, sessions: SessionReader): AgentState | undefined {
  if (meta.status !== "open" || !meta.owner) return undefined;
  if (isWaiting(store.home, meta.id)) return { state: "waiting" };
  // Another agent's session has no Claude Code session file to tell whether it runs.
  if (meta.owner.claude === false) return undefined;
  const live = liveSession(meta, sessions);
  if (!live) return { state: "ended", session: meta.owner.session };
  return { state: live.status === "idle" ? "idle" : "busy", session: live.session, wakes: Boolean(live.socket) };
}

/** The message a submitted review becomes in the owner's session. */
export function wakeMessage(fb: Feedback, title: string): string {
  const n = fb.comments.length;
  const verdict = fb.verdict === "approved" ? "approved" : fb.verdict === "changes_requested" ? "changes requested" : "commented";
  const then = fb.verdict === "approved" ? "then go on" : "and respond";
  return `${fb.reviewer} reviewed "${title}" in hoop: ${verdict}, ${n} ${n === 1 ? "comment" : "comments"}. Read it with hoop_feedback ${fb.review_id} ${then}.`;
}

/**
 * Tells the owner's session about a person's review just submitted on the page, and records how it
 * went. Nothing is sent when a wait is running or already read it (the wait hands it over), or for an
 * agent's own comment. Returns undefined when nothing was to be delivered.
 */
export async function deliverReview(
  store: Store,
  fb: Feedback,
  opts: { sessions: SessionReader; send?: Sender; now?: () => string },
): Promise<Delivery | undefined> {
  if (fb.session) return undefined;
  const meta = store.meta(fb.review_id);
  if (!meta.owner) return undefined;
  const index = store.feedback(meta.id, fb.revision).findIndex((f) => f.at === fb.at && f.reviewer === fb.reviewer);
  const key = receiptKey(fb.revision, index);
  const outcome = async (): Promise<Omit<Delivery, "at">> => {
    if (store.receipts(meta.id)[key] || isWaiting(store.home, meta.id)) return { outcome: "waiting" };
    const socket = liveSession(meta, opts.sessions)?.socket;
    if (!socket) return { outcome: "no_session" };
    try {
      await (opts.send ?? sendToSession)(socket, wakeMessage(fb, meta.title));
      return { outcome: "sent" };
    } catch (err) {
      return { outcome: "failed", error: (err as Error).message || String(err) };
    }
  };
  const d: Delivery = { ...(await outcome()), at: opts.now?.() ?? new Date().toISOString() };
  store.addDelivery(meta.id, key, d);
  return d;
}
