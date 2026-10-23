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

/** A review's status badge. */
export function statusBadge(key) {
  const s = (Object.hasOwn(REVIEW, key) ? REVIEW[key] : undefined) ?? { label: String(key), tone: "muted", icon: "clock" };
  return `<span class="badge tone-${s.tone}" data-status="${esc(key)}">${icons[s.icon]}<span>${esc(s.label)}</span></span>`;
}
