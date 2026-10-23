// One label, tone and icon for every review status key the pages show. The server decides a
// review's key; this only names it.
import { esc } from "./esc.js";
import { icons } from "./icons.js";

export const REVIEW = {
  awaiting_review: { label: "Awaiting review", tone: "wait", icon: "clock" },
  commented: { label: "Commented", tone: "info", icon: "comment" },
  changes_requested: { label: "Changes requested", tone: "warn", icon: "warning" },
  approved: { label: "Approved", tone: "ok", icon: "check" },
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

/** A review's status badge, or a pull request's state badge from `names` (PR). */
export function statusBadge(key, names = REVIEW) {
  const s = (Object.hasOwn(names, key) ? names[key] : undefined) ?? { label: String(key), tone: "muted", icon: "clock" };
  return `<span class="badge tone-${s.tone}" data-status="${esc(key)}">${icons[s.icon]}<span>${esc(s.label)}</span></span>`;
}
