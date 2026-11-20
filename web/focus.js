// Where focus goes when a page draws itself again: every page redraws by replacing its markup, which
// drops the focused control. A page notes where focus was before it redraws (`focusSpot`) and, when
// nothing it chose took focus afterwards, puts it back (`regainFocus`): on the same control if it is
// still there, else on the control now in its place, so focus never falls to the top of the page.

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";

/**
 * A control's group, from its `data-focus-key`: controls that look alike but act on different
 * things, such as two cards' Allow once, carry their thing's key. A redraw never moves focus from
 * one group's control to another's.
 */
const group = (el) => el.dataset?.focusKey ?? "";

/** What a control is, so a redraw finds the same one: its tag, ID, address, label, text and group. */
const what = (el) =>
  [el.tagName, el.id, el.getAttribute("href"), el.getAttribute("aria-label"), (el.textContent || "").trim().slice(0, 60), group(el)].join("|");

/** Whether a control can take focus now: it is there, shown and not turned off. */
export const canFocus = (el) => Boolean(el) && !el.disabled && el.checkVisibility?.() !== false;

/** The controls in `root` that can take focus now. */
const focusable = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(canFocus);

/**
 * Where the focused control is in `root`: what it is, which of the controls like it, its place
 * among all, and its group. Null when focus is elsewhere, or on something that can't take focus
 * again (hidden or turned off), so a redraw moves nothing.
 */
export function focusSpot(root, active = document.activeElement) {
  if (!active || active === root || !root.contains(active)) return null;
  const all = focusable(root);
  const place = all.indexOf(active);
  if (place < 0) return null;
  const key = what(active);
  return { key, nth: all.filter((el) => what(el) === key).indexOf(active), place, group: group(active) };
}

/** Whether focus fell to the page itself, as it does when the focused control is redrawn. */
const focusLost = () => !document.activeElement || document.activeElement === document.body;

/**
 * After a redraw, the control at `at` (from `focusSpot`) takes focus again: the same one if it is
 * still there, else the first of its group, else the one in its place outside any other group, or
 * the last. Nothing happens while focus is on a control, so a place the page chose wins, unless
 * `back` asks to go back there anyway, as closing a panel does.
 */
export function regainFocus(root, at, back = false) {
  if (!at || (!back && !focusLost())) return;
  const all = focusable(root);
  const same = all.filter((el) => what(el) === at.key);
  const kin = at.group ? all.filter((el) => group(el) === at.group) : [];
  const free = all.filter((el) => !group(el) || group(el) === at.group);
  (same[at.nth] ?? same[0] ?? kin[0] ?? free[Math.min(at.place, free.length - 1)])?.focus();
}
