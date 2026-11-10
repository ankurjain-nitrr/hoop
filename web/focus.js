// Where focus goes when a page draws itself again: every page redraws by replacing its markup, which
// drops the focused control. A page notes where focus was before it redraws (`focusSpot`) and, when
// nothing it chose took focus afterwards, puts it back (`regainFocus`): on the same control if it is
// still there, else on the control now in its place, so focus never falls to the top of the page.

/** @typedef {{ key: string, nth: number, place: number }} Spot Where focus was: what the control is, which of the controls like it, and its place among all. */

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";

/**
 * What a control is, so a redraw finds the same one: its tag, ID, address, label and text.
 * @param {Element} el
 */
const what = (el) => [el.tagName, el.id, el.getAttribute("href"), el.getAttribute("aria-label"), (el.textContent || "").trim().slice(0, 60)].join("|");

/**
 * Whether a control can take focus now: it is there, shown and not turned off.
 * @param {(Element & { disabled?: boolean }) | null | undefined} el
 * @returns {boolean}
 */
export const canFocus = (el) => el != null && !el.disabled && el.checkVisibility?.() !== false;

/**
 * The controls in `root` that can take focus now.
 * @param {Element} root
 * @returns {HTMLElement[]}
 */
const focusable = (root) => [.../** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(FOCUSABLE))].filter(canFocus);

/**
 * Where the focused control is in `root`: what it is, which of the controls like it, and its place
 * among all. Null when focus is elsewhere, or on something that can't take focus again (hidden or
 * turned off), so a redraw moves nothing.
 * @param {Element} root
 * @param {Element | null} [active]
 * @returns {Spot | null}
 */
export function focusSpot(root, active = document.activeElement) {
  if (!active || active === root || !root.contains(active)) return null;
  /** @type {Element[]} */
  const all = focusable(root);
  const place = all.indexOf(active);
  if (place < 0) return null;
  const key = what(active);
  return { key, nth: all.filter((el) => what(el) === key).indexOf(active), place };
}

/** Whether focus fell to the page itself, as it does when the focused control is redrawn. */
const focusLost = () => !document.activeElement || document.activeElement === document.body;

/**
 * After a redraw, the control at `at` (from `focusSpot`) takes focus again: the same one if it is
 * still there, else the one in its place, or the last. Nothing happens while focus is on a control,
 * so a place the page chose wins, unless `back` asks to go back there anyway, as closing a panel does.
 * @param {Element} root
 * @param {Spot | null | undefined} at
 * @param {boolean} [back]
 */
export function regainFocus(root, at, back = false) {
  if (!at || (!back && !focusLost())) return;
  const all = focusable(root);
  const same = all.filter((el) => what(el) === at.key);
  (same[at.nth] ?? same[0] ?? all[Math.min(at.place, all.length - 1)])?.focus();
}
