// The review page's keys (#336, Keyboard; docs/DESIGN-LANGUAGE.md, Keyboard shortcuts): j and k move
// to the next and previous line, n and p to the next and previous open conversation, c comments on
// the line, s suggests a change to it, a and x accept or reject Claude's tracked change on it, 1 to 4
// pick an option in its Question section, g picks the recommended one, and v marks its section
// viewed. A key with nothing to act on changes nothing, and the live region says why. ? opens the
// panel that lists them, with the switch that turns them off; ? works while they are off, so they can
// be turned on again. A key does nothing inside a text box, the comment box, the verdict panel, a
// dialog or a popover; with a modifier held, held down or while an input method composes; or on a
// quick question's card, whose own 1 to 4 pick its answers. Approve and Request changes have no key:
// only a press of their button sends a verdict.
import { esc, hooks, render, state } from "/app.js";
import { canFocus, focusSpot, regainFocus } from "/focus.js";
import { announce } from "/frame.js";
import { icons } from "/icons.js";
import { composing } from "/send.js";

/** Where a key never acts: a text box, the comment box, the verdict panel, a dialog, a popover and a quick question's card. */
const NOT_HERE = "input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable], .composer, #finishPop, dialog, [popover], [data-ask]";

/** Whether `a` comes before `b` in the page. */
const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** Each line's + that shows, in page order: the lines a reader moves between. A folded part's lines are skipped. */
const pluses = () => [...document.querySelectorAll("#app .add-btn")].filter(canFocus);

/** The line focus is on, or the last line above it, as that line's +; none before the first. */
function currentPlus() {
  const at = document.activeElement;
  if (!at || at === document.body) return undefined;
  return pluses()
    .filter((p) => p === at || p.contains(at) || before(p, at))
    .at(-1);
}

/** Focuses `el` when there is one; whether a key acted. */
const focusOn = (el) => {
  el?.focus();
  return Boolean(el);
};

/** Presses `el` when there is one and it can be pressed; whether a key acted. */
const press = (el) => {
  if (!el || el.disabled) return false;
  el.click();
  return true;
};

/** Moves focus to the line `step` lines from the current one; from nowhere, to the first or last. */
function moveLine(step) {
  const all = pluses();
  const at = all.indexOf(currentPlus());
  const from = step > 0 ? all[0] : all.at(-1);
  return focusOn(at < 0 ? from : all[at + step]);
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
  return focusOn(step > 0 ? all.find((b) => !here || before(here, b)) : all.filter((b) => here && before(b, here) && !b.contains(here)).at(-1));
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
  if (!item?.choices?.length) return "This line isn't in a question";
  const choice = n === "recommended" ? item.choices.find((c) => c.recommended) : item.choices[n - 1];
  if (!choice) return n === "recommended" ? "This question has no recommended option" : `This question has no option ${n}`;
  const id = `q-${item.id}-${choice.id}`;
  // Focus goes to the option picked, whose checked state says what was picked.
  return (press(document.getElementById(id)) && focusOn(document.getElementById(id))) || "This question takes no answers now";
}

/**
 * Presses Claude's change nearest the focus on the current line, its first, as its own button: focus
 * goes there first, so what follows (the toast, and focus once the change is gone) is as for a press.
 */
function decide(selector) {
  const button = onLine(selector);
  button?.focus();
  return press(button) || "No change from Claude on this line";
}

/** Marks the current line's section viewed, or not, and keeps focus on its Viewed, so v again undoes it. */
function viewed() {
  // On a Viewed itself, as v leaves focus, it is that section's, folded or not.
  const id = document.activeElement?.dataset?.viewed ? document.activeElement.id : `viewed-${currentPlus()?.dataset.item}`;
  return (press(document.getElementById(id)) && focusOn(document.getElementById(id))) || "No section here to mark viewed";
}

/** Whether the comment box is open with words in it, which a key must never replace. */
const written = () => [...document.querySelectorAll("#app .composer textarea, #app .composer input")].some((el) => el.value.trim());

/** What c and s say when the comment box holds words, which they never replace. */
const WRITING = "Add or cancel your comment first";

/** Comments on the current line, as its + does, unless the comment box holds words. */
function comment() {
  if (written()) return WRITING;
  return press(currentPlus()) || "No line here to comment on";
}

/**
 * Suggests a change to the current line: its edit in place where it has one, else the comment box
 * with Suggest a change on, keeping words kept for the line, with focus in the suggestion. It never
 * replaces a comment box that holds words, and never turns a suggestion off.
 */
function suggest() {
  const plus = currentPlus();
  if (written()) return WRITING;
  if (!plus) return "No line here to suggest a change to";
  const edit = document.querySelector(`.edit-btn[data-edit-item="${CSS.escape(plus.dataset.item)}"][data-edit-line="${plus.dataset.line}"]`);
  if (press(edit)) return true;
  plus.click();
  if (!document.getElementById("csugg")) document.getElementById("toggleSuggest")?.click();
  return focusOn(document.getElementById("csugg"));
}

/** Each key: what it does, as the panel lists it, and its action, which says why when it has nothing to act on. */
const KEYS = {
  j: ["Next line", () => moveLine(1) || "No next line"],
  k: ["Previous line", () => moveLine(-1) || "No previous line"],
  n: ["Next open conversation", () => moveThread(1) || "No next open conversation"],
  p: ["Previous open conversation", () => moveThread(-1) || "No previous open conversation"],
  c: ["Comment on the line", comment],
  s: ["Suggest a change to the line", suggest],
  a: ["Accept Claude's change on the line", () => decide("[data-accept]")],
  x: ["Reject Claude's change on the line", () => decide("[data-reject]")],
  "1–4": ["Pick that option in a question", null],
  g: ["Pick the question's recommended option", () => pick("recommended")],
  v: ["Mark the section viewed, or not", viewed],
};
const ACTS = {
  ...Object.fromEntries(Object.entries(KEYS).filter(([, [, run]]) => run)),
  ...Object.fromEntries([1, 2, 3, 4].map((n) => [String(n), ["", () => pick(n)]])),
};

// The switch: on unless this browser turned the keys off, and on when its storage can't be read.
const STORE = "hoop:keys";
function keysOn() {
  try {
    return localStorage.getItem(STORE) !== "off";
  } catch {
    return true;
  }
}
function setKeysOn(on) {
  try {
    localStorage.setItem(STORE, on ? "on" : "off");
  } catch {}
}

/** The panel's state: open or not, and where focus was when it opened, which it goes back to. */
const panel = { open: false, back: null };

/** The switch's button: pressed while the keys are on, with a check, as Notify me shows it. */
const switchHtml = (on) =>
  `<button type="button" class="btn small icon-label" id="keysOn" aria-pressed="${on}">${on ? icons.check : ""}<span>Keyboard shortcuts</span></button>`;

/** The panel at the top of the main column, under the review's header: the keys and what each does, the switch, and Hide keys. */
hooks.before.push(() =>
  panel.open
    ? `<section class="keys-panel" id="keysPanel" aria-labelledby="keysTitle"><div class="keys-head"><h2 id="keysTitle" tabindex="-1">Keys on this page</h2>${switchHtml(keysOn())}<button type="button" class="btn small" id="keysHide">Hide keys</button></div><dl>${Object.entries(
        KEYS,
      )
        .map(([key, [does]]) => `<div><dt><kbd>${esc(key)}</kbd></dt><dd>${esc(does)}</dd></div>`)
        .join(
          "",
        )}<div><dt><kbd>?</kbd></dt><dd>Open or close this panel</dd></div></dl><p class="hint">Keys do nothing while you type, and Approve and Request changes have none. ? works while they are off.</p></section>`
    : "",
);

/** Opens the panel, with focus on its heading. */
function openPanel() {
  panel.open = true;
  panel.back = focusSpot(document.getElementById("app"));
  render();
  document.getElementById("keysTitle")?.focus();
}

/** Closes the panel, and puts focus back where it was when it opened. */
function closePanel() {
  panel.open = false;
  render();
  // Opened with nothing focused, it leaves focus nowhere, as it found it.
  if (panel.back) regainFocus(document.getElementById("app"), panel.back, true);
  else document.activeElement?.blur?.();
  panel.back = null;
}

document.addEventListener("click", (e) => {
  const t = e.target.closest?.("#keysOn, #keysHide");
  if (t?.id === "keysHide") return closePanel();
  if (!t) return;
  // The switch changes in place, so focus stays on it.
  const on = !keysOn();
  setKeysOn(on);
  t.outerHTML = switchHtml(on);
  document.getElementById("keysOn")?.focus();
});

document.addEventListener("keydown", (e) => {
  if (!state.view || state.view.ask || state.view.build || e.ctrlKey || e.metaKey || e.altKey || e.repeat || composing(e)) return;
  const inPanel = Boolean(e.target.closest?.("#keysPanel"));
  if (!inPanel && e.target.closest?.(NOT_HERE)) return;
  if (e.key === "?" || (e.key === "Escape" && panel.open)) {
    e.preventDefault();
    return panel.open ? closePanel() : openPanel();
  }
  if (!Object.hasOwn(ACTS, e.key) || !keysOn()) return;
  e.preventDefault();
  const done = ACTS[e.key][1]();
  // A key with nothing to act on changes nothing: the live region says why.
  if (done !== true) announce(typeof done === "string" ? done : "Nothing to do here");
});
