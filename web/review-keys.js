// The review page's keys (#336, Keyboard): j and k move to the next and previous line, n and p to the
// next and previous open conversation, c comments on the line, s suggests a change to it, a and x
// accept or reject Claude's tracked change on it, 1 to 4 pick an option in its Question section, g
// picks the recommended one, and v marks its section viewed. A key does nothing inside a text box,
// with a modifier held, or on a quick question's card, whose own 1 to 4 pick its answers. Approve and
// Request changes have no key: only a press of their button sends a verdict.
import { state } from "/app.js";
import { canFocus } from "/focus.js";

/** Where a key never acts: a text box, so typing never triggers one. */
const TYPING = "input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]";

/** Whether `a` comes before `b` in the page. */
const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** Each line's +, in page order: the lines a reader moves between. */
const pluses = () => [...document.querySelectorAll("#app .add-btn")].filter(canFocus);

/** The line focus is on, or the last line above it, as that line's +; none before the first. */
function currentPlus() {
  const at = document.activeElement;
  if (!at || at === document.body) return undefined;
  return pluses()
    .filter((p) => p === at || p.contains(at) || before(p, at))
    .at(-1);
}

/** Moves focus to the line `step` lines from the current one; from nowhere, to the first or last. */
function moveLine(step) {
  const all = pluses();
  const at = all.indexOf(currentPlus());
  const from = step > 0 ? all[0] : all.at(-1);
  (at < 0 ? from : all[at + step])?.focus();
}

/** The open conversations' first controls, in page order: Reply, else Resolve. */
const threads = () =>
  [...document.querySelectorAll("#app .thread:not(.resolved):not(.ask-card)")]
    .map((t) => t.querySelector("[data-reply], [data-resolve]"))
    .filter((b) => b && canFocus(b));

/** Moves focus to the next (`step` 1) or previous (-1) open conversation after or before focus. */
function moveThread(step) {
  const at = document.activeElement;
  const all = threads();
  const here = at && at !== document.body ? at : null;
  const next = step > 0 ? all.find((b) => !here || before(here, b)) : all.filter((b) => here && before(b, here) && !b.contains(here)).at(-1);
  next?.focus();
}

/** The control `selector` that belongs to the current line: after its + and before the next line's. */
function onLine(selector) {
  const plus = currentPlus();
  if (!plus) return undefined;
  const next = pluses()[pluses().indexOf(plus) + 1];
  return [...document.querySelectorAll(`#app ${selector}`)].find((el) => canFocus(el) && before(plus, el) && (!next || before(el, next)));
}

/** The item the current line belongs to, from the review as the page shows it. */
function currentItem() {
  const id = currentPlus()?.dataset.item;
  return id ? state.view?.doc?.items.find((i) => i.id === id) : undefined;
}

/** Picks an answer to the current line's Question section: its option `n` (from 1), or the recommended one. */
function pick(n) {
  const item = currentItem();
  const choice = n === "recommended" ? item?.choices?.find((c) => c.recommended) : item?.choices?.[n - 1];
  const radio = choice && document.getElementById(`q-${item.id}-${choice.id}`);
  if (radio && !radio.disabled) radio.click();
}

/** Opens the comment box on the current line with Suggest a change on: its edit in place where it has one. */
function suggest() {
  const plus = currentPlus();
  if (!plus) return;
  const edit = document.querySelector(`.edit-btn[data-edit-item="${CSS.escape(plus.dataset.item)}"][data-edit-line="${plus.dataset.line}"]`);
  if (edit) return edit.click();
  plus.click();
  document.getElementById("toggleSuggest")?.click();
}

const KEYS = {
  j: () => moveLine(1),
  k: () => moveLine(-1),
  n: () => moveThread(1),
  p: () => moveThread(-1),
  c: () => currentPlus()?.click(),
  s: suggest,
  a: () => onLine("[data-accept]")?.click(),
  x: () => onLine("[data-reject]")?.click(),
  g: () => pick("recommended"),
  v: () => document.getElementById(`viewed-${currentPlus()?.dataset.item}`)?.click(),
  ...Object.fromEntries([1, 2, 3, 4].map((n) => [String(n), () => pick(n)])),
};

document.addEventListener("keydown", (e) => {
  if (!state.view || state.view.ask || state.view.build || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  if (!Object.hasOwn(KEYS, e.key) || e.target.closest?.(`${TYPING}, [data-ask]`)) return;
  e.preventDefault();
  KEYS[e.key]();
});
