// One label, tone and icon for every review status key the pages show. The server decides a
// review's key; this only names it.
import { esc } from "./esc.js";
import { icons } from "./icons.js";

export const REVIEW = {
  building: { label: "Building", tone: "info", icon: "list" },
  awaiting_review: { label: "Awaiting review", tone: "wait", icon: "clock" },
  commented: { label: "Commented", tone: "info", icon: "comment" },
  changes_requested: { label: "Changes requested", tone: "warn", icon: "warning" },
  approved: { label: "Approved", tone: "ok", icon: "check" },
  question: { label: "Question", tone: "wait", icon: "comment" },
  answered: { label: "Answered", tone: "ok", icon: "check" },
  withdrawn: { label: "Withdrawn", tone: "muted", icon: "close" },
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
  unknown: { label: "State unknown", tone: "muted", icon: "clock" },
};

/** A review whose latest submitted review the agent hasn't read, while it isn't waiting for one. */
export const READ = {
  unread: { label: "Not read yet", tone: "warn", icon: "clock" },
};

/** A todo's or subagent's state on the Work page, and a session's. */
export const WORK = {
  queued: { label: "Queued", tone: "muted", icon: "minus" },
  running: { label: "Running", tone: "info", icon: "clock" },
  stalled: { label: "Stalled", tone: "warn", icon: "warning" },
  notrunning: { label: "Not running", tone: "warn", icon: "warning" },
  done: { label: "Done", tone: "ok", icon: "check" },
  stopped: { label: "Stopped", tone: "muted", icon: "close" },
  busy: { label: "Working", tone: "info", icon: "clock" },
  idle: { label: "Idle", tone: "muted", icon: "minus" },
  ended: { label: "Ended", tone: "muted", icon: "close" },
};

/** A review's status badge, or a pull request's state badge from `names` (PR). */
export function statusBadge(key, names = REVIEW) {
  const s = (Object.hasOwn(names, key) ? names[key] : undefined) ?? { label: String(key), tone: "muted", icon: "clock" };
  return `<span class="badge tone-${s.tone}" data-status="${esc(key)}">${icons[s.icon]}<span>${esc(s.label)}</span></span>`;
}
