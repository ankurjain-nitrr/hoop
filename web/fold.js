// Collapsible parts of Home and the Work page: each session, and the parts inside it. A heading's
// disclosure button folds the part it names; this browser remembers what is folded, by key
// (`home:<section>:<session>`, `work:<session>:todos` and so on), across refreshes and reloads.
import { esc } from "./esc.js";
import { icons } from "./icons.js";

const STORE = "hoop:folded";

/** The folded keys this browser remembers; storage that can't be read leaves everything open. */
function read() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || "[]");
    return new Set(Array.isArray(v) ? v.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}
const folded = read();

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify([...folded]));
  } catch {}
}

export const isFolded = (key) => folded.has(key);

/** Opens the parts `keys` names, so what they hold shows. */
export function unfold(keys) {
  for (const k of keys) folded.delete(k);
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

/**
 * Acts on a click on a disclosure button or on Collapse all or Expand all, and returns a selector
 * for the button to focus after the page paints again; undefined for any other button. Collapse all
 * folds every session on the page; Expand all opens every part.
 */
export function foldClick(button, root) {
  const key = button?.dataset?.collapse;
  if (key) {
    if (folded.has(key)) folded.delete(key);
    else folded.add(key);
    save();
    return `[data-collapse="${CSS.escape(key)}"]`;
  }
  const all = button?.dataset?.collapseAll;
  if (!all) return undefined;
  for (const b of root.querySelectorAll("[data-collapse]")) {
    if (all === "expand") folded.delete(b.dataset.collapse);
    else if (b.dataset.level === "session") folded.add(b.dataset.collapse);
  }
  save();
  return `[data-collapse-all="${all}"]`;
}
