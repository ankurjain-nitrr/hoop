// Where focus goes when a page draws itself again: every page redraws by replacing its markup, which
// drops the focused control. A page notes where focus was before it redraws (`focusSpot`) and, when
// nothing it chose took focus afterwards, puts it back (`regainFocus`): on the same control if it is
// still there, else on the control now in its place, so focus never falls to the top of the page.

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";

/** What a control is, so a redraw finds the same one: its tag, ID, address, label and text. */
const what = (el) => [el.tagName, el.id, el.getAttribute("href"), el.getAttribute("aria-label"), (el.textContent || "").trim().slice(0, 60)].join("|");

/** The controls in `root` that can take focus now: shown and not turned off. */
const focusable = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.checkVisibility?.() !== false);

/** Where the focused control is in `root`: what it is, which of the controls like it, and its place among all; null when focus is elsewhere. */
export function focusSpot(root, active = document.activeElement) {
  if (!active || active === root || !root.contains(active)) return null;
  const all = focusable(root);
  const key = what(active);
  return { key, nth: all.filter((el) => what(el) === key).indexOf(active), place: Math.max(all.indexOf(active), 0) };
}

/** Whether focus fell to the page itself, as it does when the focused control is redrawn. */
const focusLost = () => !document.activeElement || document.activeElement === document.body;

/**
 * After a redraw, the control at `at` (from `focusSpot`) takes focus again: the same one if it is
 * still there, else the one in its place, or the last. Nothing happens while focus is on a control,
 * so a place the page chose wins.
 */
export function regainFocus(root, at) {
  if (!at || !focusLost()) return;
  const all = focusable(root);
  const same = all.filter((el) => what(el) === at.key);
  (same[at.nth] ?? same[0] ?? all[Math.min(at.place, all.length - 1)])?.focus();
}
