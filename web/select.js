// Partial-text comments: drag over words (or select with caret browsing) to comment on just that text.
import { $, hooks, PROSE, state, textAt } from "/app.js";
import { findTyped, sourceOffset, widen } from "/inline.js";
import { deleteSelection, openComposer, proposalsOn, rangesOn } from "/review.js";

// The selection's actions: comment on it, or delete it as a suggestion in one step.
const bar = Object.assign(document.createElement("div"), { className: "sel-bar", hidden: true });
const btn = Object.assign(document.createElement("button"), { className: "sel-btn", id: "selBtn", textContent: "Comment on selection", type: "button" });
const del = Object.assign(document.createElement("button"), { className: "sel-btn", id: "selDelete", textContent: "Delete selection", type: "button" });
bar.append(btn, del);
document.body.append(bar);
let current = null;

/**
 * A line's decorations as source ranges: Claude's undecided edits as tracked changes, and text with
 * comments on it as highlights. The renderer lets an edit win where the two overlap.
 */
hooks.line.push((item, line, where) => {
  if (where !== "decorations") return undefined;
  const text = textAt(item.id, line);
  if (text === undefined) return undefined;
  const edits = proposalsOn(item.id, line)
    .filter((e) => e.position)
    .map((e) => ({ start: e.position.start, end: e.position.end, insert: e.replace }));
  const marks = rangesOn(item.id, line)
    .filter((r) => text.slice(r.start, r.end) === r.quote)
    .map((r) => ({ start: r.start, end: r.end, mark: true }));
  return [...edits, ...marks];
});

/** How a line is rendered: its kind, prose for titles and headings, or as written on the Changes tab. */
function blockAt(itemId, line, asWritten) {
  if (asWritten || state.tab === "changes") return undefined;
  if (line < 0 || itemId === "DOC") return PROSE;
  return state.view.doc.items.find((i) => i.id === itemId)?.blocks?.[line];
}

function hide() {
  bar.hidden = true;
  current = null;
}

/** The selection as {item, line, range} when it sits inside one line's text, else null. */
export function selectionTarget() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || state.view?.meta.superseded_by) return null;
  const range = sel.getRangeAt(0);
  const host = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest("[data-sel-item]");
  const a = host(range.startContainer);
  if (!a || a !== host(range.endContainer)) return null;
  const from = sourceOffset(a, range.startContainer, range.startOffset),
    to = sourceOffset(a, range.endContainer, range.endOffset);
  if (from === null || to === null || to <= from) return null; // a selection in Claude's inserted text can't anchor a comment
  const line = Number(a.dataset.selLine);
  const text = textAt(a.dataset.selItem, line) ?? "";
  // A start or end inside a formatted run widens to the whole run, so the quote keeps its markers.
  const block = blockAt(a.dataset.selItem, line, a.closest(".line.add, .line.del") !== null);
  const { start, end } = widen(text, block, from, to);
  const quote = text.slice(start, end);
  if (!quote.trim()) return null;
  return { item: a.dataset.selItem, line: Number(a.dataset.selLine), range: { start, end, quote }, rect: range.getBoundingClientRect() };
}

function onSelect() {
  current = selectionTarget();
  if (!current) return hide();
  bar.hidden = false;
  const { rect } = current;
  bar.style.top = `${window.scrollY + rect.top - bar.offsetHeight - 8}px`;
  bar.style.left = `${Math.max(16, Math.min(window.scrollX + rect.left, window.scrollX + document.documentElement.clientWidth - bar.offsetWidth - 16))}px`;
}

bar.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection while clicking
const act = (fn) => () => {
  if (!current) return;
  const target = current;
  hide();
  window.getSelection().removeAllRanges();
  fn(target);
};
btn.addEventListener(
  "click",
  act(({ item, line, range }) => openComposer({ item, line, range })),
);
del.addEventListener("click", act(deleteSelection));
document.addEventListener("mouseup", (e) => {
  if (!bar.contains(e.target)) setTimeout(onSelect, 0);
});
document.addEventListener("keyup", (e) => {
  if (e.shiftKey) onSelect();
  else if (e.key === "Escape") hide();
});

/** Keyboard path without caret browsing: "Only about this text" in the comment box sets the range. */
document.addEventListener("input", (e) => {
  if (e.target.id !== "cpart") return;
  const c = state.composerRef?.();
  if (!c) return;
  const text = textAt(c.item, c.line) ?? "";
  const part = e.target.value;
  // Typed words match the line as shown, across formatting; the quote is the matching source text.
  const found = findTyped(text, blockAt(c.item, c.line, false), part);
  c.range = found ? { ...found, quote: text.slice(found.start, found.end) } : undefined;
  $("#cpartHint").textContent = !part ? "" : found ? "Found in this line." : "Not found in this line; the comment covers the whole line.";
});
