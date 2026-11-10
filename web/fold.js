// Every page's disclosures: a chevron button that folds the part it names (docs/DESIGN-LANGUAGE.md,
// Disclosures). This browser remembers what is folded, by key (`home:<section>:<session>`,
// `work:<session>:todos`, `thread:<id>` and so on), across refreshes and reloads. A part folded by
// default stays folded until the person opens it, which is kept as `!<key>`.
import { esc } from "./esc.js";
import { icons } from "./icons.js";

const STORE = "hoop:folded";
/** How many keys this browser keeps; past it the oldest go, so the list doesn't grow for ever. */
const KEPT = 500;

/** Parts that start folded: Home's Completed section, which only grows, and Your response times. */
const FOLDED_BY_DEFAULT = new Set(["home:completed", "home:response-times"]);
/** Kinds of part that start folded, by key prefix, as each page registers them with `foldedByDefault`. */
/** @type {string[]} */
const FOLDED_KINDS = [];

/**
 * Makes every part whose key starts with one of `prefixes` start folded, as a history does.
 * @param {...string} prefixes
 */
export const foldedByDefault = (...prefixes) => FOLDED_KINDS.push(...prefixes);

/** @param {string} key */
const byDefault = (key) => FOLDED_BY_DEFAULT.has(key) || FOLDED_KINDS.some((p) => key.startsWith(p));

/** The keys this browser remembers; storage that can't be read leaves none. */
function read() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || "[]");
    if (Array.isArray(v)) return new Set(v.filter((k) => typeof k === "string"));
  } catch {}
  return new Set();
}
const folded = read();

/**
 * Whether the part `key` names is folded: folded by the person, or by default and not opened.
 * @param {string} key
 */
export const isFolded = (key) => folded.has(key) || (byDefault(key) && !folded.has(`!${key}`));

// A key is deleted and added again on every touch, so the list runs from the least recently touched
// to the most, and the cap in `save` drops the ones touched longest ago.

/**
 * Opens the part `key` names; for a part folded by default, remembers that it was opened.
 * @param {string} key
 */
function open(key) {
  folded.delete(key);
  folded.delete(`!${key}`);
  if (byDefault(key)) folded.add(`!${key}`);
}

/** @param {string} key */
function fold(key) {
  folded.delete(`!${key}`);
  folded.delete(key);
  if (!byDefault(key)) folded.add(key);
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify([...folded].slice(-KEPT)));
  } catch {}
}

/**
 * Opens the parts `keys` names, so what they hold shows.
 * @param {Iterable<string>} keys
 */
export function unfold(keys) {
  for (const k of keys) open(k);
  save();
}

/**
 * Folds the parts `keys` names; a part folded by default is back to its default.
 * @param {Iterable<string>} keys
 */
export function refold(keys) {
  for (const k of keys) fold(k);
  save();
}

/**
 * A fold's name with its count, the one way a disclosure writes it: "History 3".
 * @param {string} name
 * @param {number} n
 */
export const foldCount = (name, n) => `${name} <span class="count">${n}</span>`;

/**
 * The disclosure button every page uses: the chevron, then `content` (a fold's name and count, as
 * `foldCount` writes it), with `aria-expanded` saying whether what it folds shows. `attrs` names what
 * it does; `controls` is the ID of what it folds, while that is on the page; `label`, when given, is
 * its accessible name, for a button whose name sits outside it.
 * @param {{ open: boolean, content?: string, attrs?: string, controls?: string, label?: string }} options
 */
export function disclosure({ open, content = "", attrs = "", controls = "", label = "" }) {
  const named = label ? ` aria-label="${esc(label)}"` : "";
  const owns = controls ? ` aria-controls="${esc(controls)}"` : "";
  return `<button type="button" class="fold-btn" ${attrs} aria-expanded="${open}"${owns}${named}>${open ? icons.collapse : icons.expand}${content ? `<span>${content}</span>` : ""}</button>`;
}

/**
 * A part's disclosure button, which shows or hides the element `body`, with its state kept by `key`.
 * `level` is "session" for a session or pull request group, which Collapse all folds; "part" for a
 * section or a part of a session, which Expand all opens; or "item" for what one item holds (its
 * history, its details), which neither touches. `here` folds it in place, with no repaint: for a page
 * that doesn't paint again on a fold.
 * @param {string} key
 * @param {string} body
 * @param {string} content
 * @param {"session" | "part" | "item"} [level]
 * @param {{ label?: string, here?: boolean }} [options]
 */
export function foldButton(key, body, content, level = "part", { label = "", here = false } = {}) {
  const attrs = `data-collapse="${esc(key)}" data-level="${level}"${here ? " data-fold-here" : ""}`;
  return disclosure({ open: !isFolded(key), content, attrs, controls: body, label });
}

/**
 * The hidden attribute of a folded part: hidden until found, so the browser's find in page still
 * reaches its text and opens it (see the `beforematch` listener below).
 * @param {string} key
 */
export const foldHidden = (key) => (isFolded(key) ? ' hidden="until-found"' : "");

/**
 * The attributes of a part's body: its ID, and hidden while folded.
 * @param {string} key
 * @param {string} body
 */
export const foldBody = (key, body) => `id="${esc(body)}" class="fold-body"${foldHidden(key)}`;

/**
 * What a folded part holds, shown beside its heading, as "2 queued · 1 running". Nothing while open.
 * @param {string} key
 * @param {[number, string, string?][]} counts
 */
export function foldSummary(key, counts) {
  if (!isFolded(key)) return "";
  const text = counts.filter(([n]) => n > 0).map(([n, one, many = one]) => `${n} ${n === 1 ? one : many}`);
  return `<span class="fold-summary">${esc(text.join(" · ") || "empty")}</span>`;
}

/**
 * How many of `list` are in each state of `names` (a status.js table), in its order, as `foldSummary` takes them.
 * @template T
 * @param {T[]} list
 * @param {Record<string, { label: string }>} names
 * @param {(x: T) => unknown} [stateOf]
 * @returns {[number, string][]}
 */
export const tally = (list, names, stateOf = (x) => /** @type {{ status?: unknown }} */ (x).status) =>
  Object.entries(names).map(([k, s]) => [list.filter((x) => stateOf(x) === k).length, s.label.toLowerCase()]);

/** The Collapse all and Expand all buttons at the top of a page. */
export const foldAllHtml = () =>
  `<div class="fold-all"><button type="button" class="btn small" data-collapse-all="collapse">Collapse all</button><button type="button" class="btn small" data-collapse-all="expand">Expand all</button></div>`;

// A button acts on Space at key up, so a repaint between key down and up would replace it and drop
// the press: a fold button acts at key down instead, and its key up is cancelled so no browser clicks it again.
/**
 * @param {KeyboardEvent} e
 * @returns {HTMLButtonElement | null | undefined}
 */
const foldSpace = (e) =>
  e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey
    ? /** @type {Element | null} */ (e.target)?.closest?.("button[data-collapse], button[data-collapse-all]")
    : null;
document.addEventListener("keydown", (e) => {
  const b = foldSpace(e);
  if (!b) return;
  e.preventDefault();
  if (!e.repeat) b.click();
});
document.addEventListener("keyup", (e) => {
  if (foldSpace(e)) e.preventDefault();
});

/**
 * Folds or opens the part `key` names, and remembers it.
 * @param {string} key
 */
function flip(key) {
  if (isFolded(key)) open(key);
  else fold(key);
  save();
}

/**
 * Acts on a click on a disclosure button or on Collapse all or Expand all, and returns a selector
 * for the button to focus after the page paints again; undefined for any other button, and for a
 * button that folds in place. Collapse all folds every session on the page; Expand all opens every
 * session and part, and leaves what an item holds as it is.
 * @param {HTMLElement | null | undefined} button
 * @param {ParentNode} root
 * @returns {string | undefined}
 */
export function foldClick(button, root) {
  const key = button?.dataset?.collapse;
  if (key) {
    if (button.hasAttribute("data-fold-here")) return undefined;
    flip(key);
    return `[data-collapse="${CSS.escape(key)}"]`;
  }
  const all = button?.dataset?.collapseAll;
  if (!all) return undefined;
  for (const b of root.querySelectorAll(/** @type {"button"} */ ("[data-collapse]"))) {
    const key = b.dataset.collapse ?? "";
    if (all === "expand" && b.dataset.level !== "item") open(key);
    else if (all === "collapse" && b.dataset.level === "session") fold(key);
  }
  save();
  return `[data-collapse-all="${all}"]`;
}

/**
 * Draws a fold button `b` and its part as its state now says, in place.
 * @param {HTMLElement} b
 */
function showState(b) {
  const open = !isFolded(b.dataset.collapse ?? "");
  b.setAttribute("aria-expanded", String(open));
  b.querySelector(".icon")?.replaceWith(document.createRange().createContextualFragment((open ? icons.collapse : icons.expand) ?? ""));
  const body = document.getElementById(b.getAttribute("aria-controls") ?? "");
  if (open) body?.removeAttribute("hidden");
  else body?.setAttribute("hidden", "until-found");
}

// A button that folds in place shows or hides its part itself, so focus stays on it and nothing else
// on the page moves.
document.addEventListener("click", (e) => {
  const b = /** @type {HTMLElement | null | undefined} */ (/** @type {Element | null} */ (e.target)?.closest?.("button[data-fold-here]"));
  if (!b) return;
  flip(b.dataset.collapse ?? "");
  showState(b);
});

// Find in page reached text in a folded part, and the browser opens it: the fold opens too, and is
// remembered open, as if its button had been pressed.
document.addEventListener("beforematch", (e) => {
  const id = /** @type {Element | null} */ (e.target)?.id;
  const b = id && document.querySelector(/** @type {"button"} */ (`button.fold-btn[data-collapse][aria-controls="${CSS.escape(id)}"]`));
  if (!b) return;
  unfold([b.dataset.collapse ?? ""]);
  showState(b);
});
