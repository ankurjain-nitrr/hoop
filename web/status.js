// One label, tone and icon for every review status key the pages show. The server decides a
// review's key; this only names it. Tones follow the color rule in docs/DESIGN.md: live (a clock) is
// agent work running now and wait (a person) is your move, both amber; ok finished well, warn needs
// fixing, info a neutral fact.
import { esc } from "./esc.js";
import { icons } from "./icons.js";

/** @typedef {{ label: string; tone: string; icon: string }} Status */

/** @type {Record<string, Status>} */
export const REVIEW = {
  building: { label: "Building", tone: "info", icon: "list" },
  awaiting_review: { label: "Awaiting review", tone: "wait", icon: "person" },
  commented: { label: "Commented", tone: "info", icon: "comment" },
  changes_requested: { label: "Changes requested", tone: "warn", icon: "warning" },
  reopened: { label: "Changes requested after approval", tone: "warn", icon: "warning" },
  approved: { label: "Approved", tone: "ok", icon: "check" },
  question: { label: "Question", tone: "wait", icon: "comment" },
  answered: { label: "Answered", tone: "ok", icon: "check" },
  withdrawn: { label: "Withdrawn", tone: "muted", icon: "close" },
  closed: { label: "Closed (not approved)", tone: "muted", icon: "close" },
  superseded: { label: "Replaced", tone: "muted", icon: "close" },
};

/** A pull request's states on Home. */
export const PR = {
  checks_running: { label: "Checks running", tone: "wait", icon: "clock" },
  checks_failing: { label: "Checks failing", tone: "warn", icon: "warning" },
  checks_green: { label: "Checks passed", tone: "ok", icon: "check" },
  conflicts: { label: "Conflicts with base", tone: "warn", icon: "warning" },
  review_requested: { label: "Your review requested", tone: "info", icon: "comment" },
  ready: { label: "Ready to merge", tone: "ok", icon: "check" },
  merged: { label: "Merged", tone: "ok", icon: "check" },
  closed: { label: "Closed", tone: "muted", icon: "close" },
  gone: { label: "Gone", tone: "muted", icon: "close" },
  unknown: { label: "State unknown", tone: "muted", icon: "clock" },
};

/** An action item's state on Home. */
export const ACTION = {
  open: { label: "Waiting on you", tone: "wait", icon: "person" },
  done: { label: "Done", tone: "ok", icon: "check" },
  wont_do: { label: "Won't do", tone: "muted", icon: "close" },
  withdrawn: { label: "Withdrawn", tone: "muted", icon: "close" },
};

/** What Home and Work say of a message hoop didn't send, since hoop's off list turns messages into a session off. */
export const MESSAGES_OFF = "Not sent: messages into a session are off in hoop's off list";

/** What a review or an answer sent with messages into a session off says: it is kept, and Claude reads it when it asks. */
export const SAVED_OFF = "Saved. Messages into a session are off in hoop's off list, so Claude wasn't told; it reads this with hoop_wait or hoop_feedback.";

/** A review whose latest submitted review the agent hasn't read, while it isn't waiting for one. */
export const READ = {
  unread: { label: "Not read yet", tone: "info", icon: "clock" },
  // Unread since messages into a session are off in hoop's off list: nothing told Claude.
  not_sent: { label: MESSAGES_OFF, tone: "muted", icon: "minus" },
  // Claude read the latest review and hasn't revised or replied, while its session is idle or ended.
  no_response: { label: "No response yet", tone: "info", icon: "comment" },
};

/** A todo's or subagent's state on the Work page, and a session's. */
export const WORK = {
  queued: { label: "Queued", tone: "muted", icon: "minus" },
  running: { label: "Running", tone: "live", icon: "clock" },
  waiting: { label: "Waiting on you", tone: "wait", icon: "person" },
  inreview: { label: "In review", tone: "info", icon: "comment" },
  blocked: { label: "Blocked", tone: "muted", icon: "minus" },
  stalled: { label: "Stalled", tone: "warn", icon: "warning" },
  notrunning: { label: "Not running", tone: "warn", icon: "warning" },
  done: { label: "Done", tone: "ok", icon: "check" },
  stopped: { label: "Stopped", tone: "muted", icon: "close" },
  failed: { label: "Failed", tone: "warn", icon: "warning" },
  busy: { label: "Working", tone: "live", icon: "clock" },
  idle: { label: "Idle", tone: "muted", icon: "minus" },
  ended: { label: "Ended", tone: "muted", icon: "close" },
};

/**
 * A review's status badge, or a pull request's state badge from `names` (PR).
 * @param {string} key
 * @param {Record<string, Status>} [names]
 */
export function statusBadge(key, names = REVIEW) {
  const s = (Object.hasOwn(names, key) ? names[key] : undefined) ?? { label: String(key), tone: "muted", icon: "clock" };
  return `<span class="badge tone-${s.tone}" data-status="${esc(key)}">${icons[s.icon]}<span>${esc(s.label)}</span></span>`;
}

/** @typedef {"approved" | "changes_requested"} Verdict */

/**
 * The two verdicts a person's review takes, as the review page names them.
 * @type {Record<Verdict, string>}
 */
export const VERDICT = { approved: "Approve", changes_requested: "Request changes" };

/**
 * @param {number} n
 * @param {string} what
 */
const some = (n, what) => `${n} ${what}${n === 1 ? "" : "s"}`;

/**
 * The one verdict a person's review can take now, with the short reason the review page shows
 * beside it. Request changes while they have new comments (replies and suggestions too) or new
 * answers, while a conversation they haven't resolved is open, or while a question is still in the
 * text, answered or not, since Claude writes the decisions in. Approve when there is none of that.
 * On a review opened from a file (`file`), no session writes the decisions in: its answers stay with
 * the review, so answering every question lets the person approve. Until then, with nothing else new
 * or open, the verdict is Approve, `held` by the questions left, since a request for changes would
 * ask no one for anything.
 * The page offers only this verdict, and src/rules.ts refuses the other one, so they never disagree.
 * @param {{ comments?: number; answers?: number; threads?: number; questions?: number; unanswered?: number; file?: boolean }} state
 * @returns {{ verdict: Verdict; reason: string; held?: boolean }}
 */
export function verdictNow({ comments = 0, answers = 0, threads = 0, questions = 0, unanswered = 0, file = false }) {
  /** @type {string[]} */
  const why = [];
  if (comments) why.push(some(comments, "new comment"));
  if (answers && !file) why.push(some(answers, "new answer"));
  if (unanswered) why.push(`${some(unanswered, "question")} unanswered`);
  else if (questions && !answers && !file) why.push(questions === 1 ? "question answered, still in the text" : "questions answered, still in the text");
  if (threads) why.push(`${some(threads, "conversation")} open`);
  if (file && unanswered && !comments && !threads) return { verdict: "approved", reason: why.join(", "), held: true };
  if (why.length || (questions && !file)) return { verdict: "changes_requested", reason: why.join(", ") };
  return { verdict: "approved", reason: answers ? `${some(answers, "answer")}, nothing open` : "nothing new, nothing open" };
}
