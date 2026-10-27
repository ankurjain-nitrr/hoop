// One label, tone and icon for every review status key the pages show. The server decides a
// review's key; this only names it. Tones follow the color rule in docs/DESIGN.md: live (a clock) is
// agent work running now and wait (a person) is your move, both amber; ok finished well, warn needs
// fixing, info a neutral fact.
import { esc } from "./esc.js";
import { icons } from "./icons.js";

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

/** A review whose latest submitted review the agent hasn't read, while it isn't waiting for one. */
export const READ = {
  unread: { label: "Not read yet", tone: "info", icon: "clock" },
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

/** A review's status badge, or a pull request's state badge from `names` (PR). */
export function statusBadge(key, names = REVIEW) {
  const s = (Object.hasOwn(names, key) ? names[key] : undefined) ?? { label: String(key), tone: "muted", icon: "clock" };
  return `<span class="badge tone-${s.tone}" data-status="${esc(key)}">${icons[s.icon]}<span>${esc(s.label)}</span></span>`;
}

/** The two verdicts a person's review takes, as the review page names them. */
export const VERDICT = { approved: "Approve", changes_requested: "Request changes" };

const some = (n, what) => `${n} ${what}${n === 1 ? "" : "s"}`;

/**
 * The one verdict a person's review can take now, with the short reason the review page shows
 * beside it. Request changes while they have new comments (replies and suggestions too) or new
 * answers, while a conversation they haven't resolved is open, or while a question is still in the
 * text, answered or not, since Claude writes the decisions in. Approve when there is none of that.
 * The page offers only this verdict, and src/rules.ts refuses the other one, so they never disagree.
 */
export function verdictNow({ comments = 0, answers = 0, threads = 0, questions = 0, unanswered = 0 }) {
  const why = [];
  if (comments) why.push(some(comments, "new comment"));
  if (answers) why.push(some(answers, "new answer"));
  if (unanswered) why.push(`${some(unanswered, "question")} unanswered`);
  else if (questions && !answers) why.push(questions === 1 ? "question answered, still in the text" : "questions answered, still in the text");
  if (threads) why.push(`${some(threads, "conversation")} open`);
  if (why.length || questions) return { verdict: "changes_requested", reason: why.join(", ") };
  return { verdict: "approved", reason: "nothing new, nothing open" };
}
