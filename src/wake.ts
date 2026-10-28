import type { ActionItem } from "./actions.js";
import type { Feedback, ReviewDoc } from "./contract.js";
import type { Owner } from "./owner.js";
import { receiptKey, receivedBy, type Delivery, type ReviewMeta, type Store } from "./store.js";
import { sendToSession, type Sender } from "./steer.js";
import { isWaiting } from "./wait.js";
import { type ClaudeSession, ownerSession, type SessionReader } from "./work.js";

// A person's review reaches the session that asked for it even after the agent stopped waiting: the
// pages process sends the session one message over its messaging socket, and the review page shows
// whether the agent waits, is idle, or has ended.

/**
 * What the agent that owns a review is doing, as the review page shows it: `waiting` in a wait for
 * this review; `idle` or `busy` in a live Claude Code session (`wakes` when a submit can message it);
 * or `ended`, with the session to resume.
 */
export type AgentState = { state: "waiting" } | { state: "idle" | "busy"; session: string; wakes: boolean } | { state: "ended"; session: string };

/** The owner's live Claude Code session, when it runs, under a new ID after `/clear` too. */
function liveSession(owner: Owner | undefined, sessions: SessionReader): ClaudeSession | undefined {
  if (!owner || owner.claude === false) return undefined;
  try {
    return ownerSession(owner, sessions());
  } catch {
    return undefined;
  }
}

/** The owner's state for an open review, or undefined for an approved review or one no agent owns. */
export function agentState(store: Store, meta: ReviewMeta, sessions: SessionReader): AgentState | undefined {
  if (meta.status !== "open" || !meta.owner || meta.ask?.withdrawn || meta.closed) return undefined;
  if (isWaiting(store.home, meta.id)) return { state: "waiting" };
  // Another agent's session has no Claude Code session file to tell whether it runs.
  if (meta.owner.claude === false) return undefined;
  const live = liveSession(meta.owner, sessions);
  if (!live) return { state: "ended", session: meta.owner.session };
  return { state: live.status === "idle" ? "idle" : "busy", session: live.session, wakes: Boolean(live.socket) };
}

/**
 * What a message to a session that took over from the owner under a new ID (`/clear`) adds: that an
 * earlier conversation in its terminal started it, so it reads what it doesn't remember first.
 */
export const EARLIER = {
  review: " This review was started by an earlier conversation in this terminal (before /clear): read the document with hoop_export first.",
  ask: " This question was asked by an earlier conversation in this terminal (before /clear).",
  action: " This action item was added by an earlier conversation in this terminal (before /clear).",
};

/** The message a submitted review becomes in the owner's session; `reopened` names what it reopened: an approval or a person's close. */
export function wakeMessage(fb: Feedback, title: string, reopened?: "approval" | "close"): string {
  const n = fb.comments.length;
  const after = { approval: " after approval", close: ", reopening the review they had closed" };
  const verdict =
    fb.verdict === "approved" ? "approved" : fb.verdict === "changes_requested" ? `changes requested${reopened ? after[reopened] : ""}` : "commented";
  const then = fb.verdict === "approved" ? "then go on" : "and respond";
  return `${fb.reviewer} reviewed "${title}" in hoop: ${verdict}, ${n} ${n === 1 ? "comment" : "comments"}. Read it with hoop_feedback ${fb.review_id} ${then}.`;
}

/** Whether this review reopened its review: an approved one, or one a person had closed. */
function reopenedBy(meta: ReviewMeta, fb: Feedback): "approval" | "close" | undefined {
  if (meta.reopened_at === fb.at) return "approval";
  return meta.closes?.at(-1)?.reopened_at === fb.at ? "close" : undefined;
}

/**
 * The message a person's answer to a quick question becomes in the asking session: "Answered in
 * hoop: Keep the old endpoint? → A. Keep it as an alias", or for a change to an answer Claude already
 * read, "Corrected in hoop: Keep the old endpoint? Changed: A. Keep it as an alias → B. Remove it".
 */
export function answerMessage(fb: Feedback, doc: ReviewDoc): string {
  const said = (item: string, choice: string, text?: string) => {
    if (choice === "other") return `Other: "${text ?? ""}"`;
    const c = doc.items.find((i) => i.id === item)?.choices?.find((o) => o.id === choice);
    return `${choice}. ${c?.label ?? ""}`;
  };
  const corrected = fb.answers.some((a) => a.corrects);
  const parts = fb.answers.map((a) => {
    const q = doc.items.find((i) => i.id === a.item)?.title ?? a.item;
    if (a.corrects) return `${q} Changed: ${said(a.item, a.corrects.choice, a.corrects.text)} → ${said(a.item, a.choice, a.text)}`;
    return `${q} → ${said(a.item, a.choice, a.text)}${a.recommended ? " (your recommendation, taken with Go with your recommendation)" : ""}`;
  });
  const note = fb.summary?.trim() ? ` Note: "${fb.summary.trim()}".` : "";
  return `${corrected ? "Corrected" : "Answered"} in hoop: ${parts.join("; ")}.${note} Read it with hoop_feedback ${fb.review_id}.`;
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
    if (receivedBy(store.receipts(meta.id)[key], meta.owner?.session) || isWaiting(store.home, meta.id)) return { outcome: "waiting" };
    const live = liveSession(meta.owner, opts.sessions);
    if (!live?.socket) return { outcome: "no_session" };
    try {
      const text = meta.ask ? answerMessage(fb, store.revision(meta.id, 1)) : wakeMessage(fb, meta.title, reopenedBy(meta, fb));
      const earlier = live.session !== meta.owner?.session ? (meta.ask ? EARLIER.ask : EARLIER.review) : "";
      await (opts.send ?? sendToSession)(live.socket, text + earlier);
      return { outcome: "sent" };
    } catch (err) {
      return { outcome: "failed", error: (err as Error).message || String(err) };
    }
  };
  const d: Delivery = { ...(await outcome()), at: opts.now?.() ?? new Date().toISOString() };
  store.addDelivery(meta.id, key, d);
  return d;
}

/** The message a person's close of a review becomes in the owner's session. */
export function closeMessage(meta: ReviewMeta): string {
  return `Closed in hoop: ${meta.title} (${meta.id}), not approved: stop work on it.${meta.closed?.reason ? ` ${meta.closed.reason}` : ""}`;
}

/** The message a person's reopening of a closed review becomes in the owner's session. */
const reopenMessage = (meta: ReviewMeta) => `Reopened in hoop: ${meta.title} (${meta.id}). It waits for the person's review again.`;

type SendOpts = { sessions: SessionReader; send?: Sender; now?: () => string };

/**
 * Sends a message to the owner's live session, written for the session it reaches (`text`), and
 * returns how it went, stamped now.
 */
async function sendLive(owner: Owner, opts: SendOpts, text: (live: ClaudeSession) => string): Promise<Delivery> {
  const at = () => opts.now?.() ?? new Date().toISOString();
  const live = liveSession(owner, opts.sessions);
  if (!live?.socket) return { outcome: "no_session", at: at() };
  try {
    await (opts.send ?? sendToSession)(live.socket, text(live));
    return { outcome: "sent", at: at() };
  } catch (err) {
    return { outcome: "failed", error: (err as Error).message || String(err), at: at() };
  }
}

/** The deliveries key of a person's close or reopening, beside the submitted reviews' receipt keys. */
export const CLOSE_KEY = "closed";

/**
 * Tells the owner's session that a person closed its review, or reopened it (`reopenMessage`),
 * and records how it went under `CLOSE_KEY`. While a wait on the review runs, nothing is sent: the
 * wait returns with `closed`. Returns undefined for a review no session owns.
 */
export async function deliverClose(store: Store, meta: ReviewMeta, opts: SendOpts): Promise<Delivery | undefined> {
  const owner = meta.owner;
  if (!owner) return undefined;
  const earlier = meta.ask ? EARLIER.ask : EARLIER.review;
  const text = meta.closed ? closeMessage(meta) : reopenMessage(meta);
  const d = isWaiting(store.home, meta.id)
    ? { outcome: "waiting" as const, at: opts.now?.() ?? new Date().toISOString() }
    : await sendLive(owner, opts, (live) => text + (live.session !== owner.session ? earlier : ""));
  store.addDelivery(meta.id, CLOSE_KEY, d);
  return d;
}

/** The message a closed action item becomes in the session that added it. */
export function actionMessage(item: ActionItem): string {
  return item.state === "done" ? `Done: ${item.title}` : `Won't do: ${item.title} — ${item.reason ?? ""}`;
}

/**
 * Tells the session that added an action item that it closed: done, or the person won't do it.
 * Returns how it went; nothing is sent for an item still open or one the session withdrew itself.
 */
export async function deliverAction(item: ActionItem, opts: SendOpts): Promise<Delivery | undefined> {
  if (item.state !== "done" && item.state !== "wont_do") return undefined;
  // Its reference on the last line marks the turn it starts as the action item's.
  return sendLive(item.owner, opts, (live) => `${actionMessage(item)}${live.session !== item.owner.session ? EARLIER.action : ""}\n\n(hoop-action ${item.id})`);
}
