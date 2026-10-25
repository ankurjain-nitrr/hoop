// Collapsible parts of Home and the Work page: each session, and the parts inside it. A heading's
// disclosure button folds the part it names; this browser remembers what is folded, by key
// (`home:<section>:<session>`, `work:<session>:todos` and so on), across refreshes and reloads.
// A part folded by default stays folded until the person opens it, which is kept as `!<key>`.
import { esc } from "./esc.js";
import { icons } from "./icons.js";

const STORE = "hoop:folded";

/** Parts that start folded: Home's Completed section, which only grows. */
const FOLDED_BY_DEFAULT = ["home:completed"];

/**
 * The folded keys this browser remembers, plus each part folded by default that the person hasn't
 * opened; storage that can't be read leaves only those parts folded.
 */
function read() {
  let saved = [];
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || "[]");
    if (Array.isArray(v)) saved = v.filter((k) => typeof k === "string");
  } catch {}
  const set = new Set(saved);
  for (const k of FOLDED_BY_DEFAULT) if (!set.has(`!${k}`)) set.add(k);
  return set;
}
const folded = read();

/** Opens the part `key` names; for a part folded by default, remembers that it was opened. */
function open(key) {
  folded.delete(key);
  if (FOLDED_BY_DEFAULT.includes(key)) folded.add(`!${key}`);
}

function fold(key) {
  folded.add(key);
  folded.delete(`!${key}`);
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify([...folded]));
  } catch {}
}

export const isFolded = (key) => folded.has(key);

/** Opens the parts `keys` names, so what they hold shows. */
export function unfold(keys) {
  for (const k of keys) open(k);
  save();
}

/**
 * A heading's disclosure button: a chevron and the heading's text, which shows or hides the
 * element `body`. `level` is "session" for a session or pull request group, which Collapse all
 * folds, or "part" for a section or a part of a session.
 */
export function foldButton(key, body, content, level = "part") {
  const open = !folded.has(key);
  return `<button type="button" class="fold-btn" data-collapse="${esc(key)}" data-level="${level}" aria-expanded="${open}" aria-controls="${esc(body)}">${open ? icons.collapse : icons.expand}<span>${content}</span></button>`;
}

/** The attributes of a part's body: its ID, and hidden while folded. */
export const foldBody = (key, body) => `id="${esc(body)}" class="fold-body"${folded.has(key) ? " hidden" : ""}`;

/** What a folded part holds, shown beside its heading, as "2 queued · 1 running". Nothing while open. */
export function foldSummary(key, counts) {
  if (!folded.has(key)) return "";
  const text = counts.filter(([n]) => n > 0).map(([n, one, many = one]) => `${n} ${n === 1 ? one : many}`);
  return `<span class="fold-summary">${esc(text.join(" · ") || "empty")}</span>`;
}

/** How many of `list` are in each state of `names` (a status.js table), in its order, as `foldSummary` takes them. */
export const tally = (list, names, stateOf = (x) => x.status) =>
  Object.entries(names).map(([k, s]) => [list.filter((x) => stateOf(x) === k).length, s.label.toLowerCase()]);

/** The Collapse all and Expand all buttons at the top of a page. */
export const foldAllHtml = () =>
  `<div class="fold-all"><button type="button" class="btn small" data-collapse-all="collapse">Collapse all</button><button type="button" class="btn small" data-collapse-all="expand">Expand all</button></div>`;

// A button acts on Space at key up, so a repaint between key down and up would replace it and drop
// the press: a fold button acts at key down instead, and its key up does nothing.
document.addEventListener("keydown", (e) => {
  if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey) return;
  const b = e.target.closest?.("button[data-collapse], button[data-collapse-all]");
  if (!b) return;
  e.preventDefault();
  if (!e.repeat) b.click();
});

/**
 * Acts on a click on a disclosure button or on Collapse all or Expand all, and returns a selector
 * for the button to focus after the page paints again; undefined for any other button. Collapse all
 * folds every session on the page; Expand all opens every part.
 */
export function foldClick(button, root) {
  const key = button?.dataset?.collapse;
  if (key) {
    if (folded.has(key)) open(key);
    else fold(key);
    save();
    return `[data-collapse="${CSS.escape(key)}"]`;
  }
  const all = button?.dataset?.collapseAll;
  if (!all) return undefined;
  for (const b of root.querySelectorAll("[data-collapse]")) {
    if (all === "expand") open(b.dataset.collapse);
    else if (b.dataset.level === "session") fold(b.dataset.collapse);
  }
  save();
  return `[data-collapse-all="${all}"]`;
}
