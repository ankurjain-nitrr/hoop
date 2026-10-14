// One label, tone and icon for every status the pages show: review status keys from the server,
// tracker item statuses and change steps. The server decides a review's key; this only names it.
import { esc } from "./esc.js";
import { icons } from "./icons.js";

export const REVIEW = {
  awaiting_review: { label: "Awaiting review", tone: "wait", icon: "clock" },
  commented: { label: "Commented", tone: "info", icon: "comment" },
  changes_requested: { label: "Changes requested", tone: "warn", icon: "warning" },
  approved: { label: "Approved", tone: "ok", icon: "check" },
  closed: { label: "Closed", tone: "muted", icon: "close" },
};

/** Tracker item statuses and change steps, by their lower-case text. */
export const TRACKER = {
  queued: "wait", todo: "wait", "in progress": "info", "in review": "info", blocked: "warn",
  done: "ok", dropped: "muted", closed: "muted",
  intake: "wait", prd: "info", hld: "info", lld: "info", plan: "info", build: "info", review: "info",
  accept: "info", merge: "info", fold: "ok",
};

/** A review's status badge; `note` adds a short line, such as a GitHub review waiting for merge. */
export function statusBadge(key, note) {
  const s = REVIEW[key] ?? { label: String(key), tone: "muted", icon: "clock" };
  return `<span class="badge tone-${s.tone}" data-status="${esc(key)}">${icons[s.icon]}<span>${esc(s.label)}</span></span>${note ? ` <span class="badge-note">${esc(note)}</span>` : ""}`;
}

/** A tracker chip. Values match without regard to case; an unknown value shows as a neutral chip. */
export function statusChip(value) {
  const text = String(value).trim().toLowerCase();
  const tone = TRACKER[text] ?? "neutral";
  return `<span class="chip tone-${tone} s-${text.replace(/[^a-z0-9]+/g, "-")}">${esc(text)}</span>`;
}
