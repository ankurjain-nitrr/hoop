// Partial-text comments: drag over words (or select with caret browsing) to comment on just that text.
import { $, esc, hooks, state, textAt } from "/app.js";
import { openComposer, proposalsOn, rangesOn } from "/review.js";

const btn = Object.assign(document.createElement("button"), { className: "sel-btn", id: "selBtn", textContent: "Comment on selection", hidden: true });
btn.type = "button";
document.body.append(btn);
let current = null;

/**
 * Decorates a line: Claude's undecided edits as tracked changes (deleted and inserted text), and
 * text with comments on it as highlights. Offsets are into the line's current text; where the two
 * overlap, the edit wins.
 */
hooks.line.push((item, line, where) => {
  if (where !== "text") return undefined;
  const text = textAt(item.id, line);
  if (text === undefined) return undefined;
  const edits = proposalsOn(item.id, line).filter((e) => e.position).map((e) => ({ ...e.position, html: `<del class="tc-del">${esc(text.slice(e.position.start, e.position.end))}</del><ins class="tc-ins">${esc(e.replace)}</ins>` }));
  const marks = rangesOn(item.id, line).filter((r) => text.slice(r.start, r.end) === r.quote).map((r) => ({ start: r.start, end: r.end, html: `<mark class="hl">${esc(r.quote)}</mark>` }));
  let out = "", pos = 0;
  for (const d of [...edits, ...marks].sort((a, b) => a.start - b.start)) {
    if (d.start < pos) continue;
    out += esc(text.slice(pos, d.start)) + d.html;
    pos = d.end;
  }
  return out + esc(text.slice(pos));
});

function offsetIn(el, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(node, offset);
  return r.toString().length;
}

function hide() { btn.hidden = true; current = null; }

/** The selection as {item, line, range} when it sits inside one line's text, else null. */
export function selectionTarget() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || state.view?.meta.status === "approved") return null;
  const range = sel.getRangeAt(0);
  const host = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest("[data-sel-item]");
  const a = host(range.startContainer);
  if (!a || a !== host(range.endContainer)) return null;
  const start = offsetIn(a, range.startContainer, range.startOffset), end = offsetIn(a, range.endContainer, range.endOffset);
  const quote = a.textContent.slice(start, end);
  if (!quote.trim()) return null;
  return { item: a.dataset.selItem, line: Number(a.dataset.selLine), range: { start, end, quote }, rect: range.getBoundingClientRect() };
}

function onSelect() {
  current = selectionTarget();
  if (!current) return hide();
  btn.hidden = false;
  const { rect } = current;
  btn.style.top = `${window.scrollY + rect.top - btn.offsetHeight - 8}px`;
  btn.style.left = `${Math.max(16, Math.min(window.scrollX + rect.left, window.scrollX + document.documentElement.clientWidth - btn.offsetWidth - 16))}px`;
}

btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection while clicking
btn.addEventListener("click", () => {
  if (!current) return;
  const { item, line, range } = current;
  hide();
  window.getSelection().removeAllRanges();
  openComposer({ item, line, range });
});
document.addEventListener("mouseup", (e) => { if (e.target !== btn) setTimeout(onSelect, 0); });
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
  const start = part ? text.indexOf(part) : -1;
  c.range = start >= 0 ? { start, end: start + part.length, quote: part } : undefined;
  $("#cpartHint").textContent = !part ? "" : start >= 0 ? "Found in this line." : "Not found in this line; the comment covers the whole line.";
});
