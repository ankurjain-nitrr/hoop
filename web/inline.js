// The line renderer: shows a document line as formatted text, and keeps a map from what is shown
// back to the line's source text, so comments anchor to source positions as before. Every shown
// source character sits in a `<span data-s="offset">`; markers that aren't source text (a bullet,
// Claude's inserted words) carry no `data-s`. Markup comes only from escaped text and fixed tags.
import { esc } from "./esc.js";
import { JOIN, rowCells, TASK } from "./blocks.js";

const SAFE_LINK = /^https?:\/\//i;
// Code spans first, so nothing inside them is formatted; then bold, italic, links, and web
// addresses written bare or in angle brackets, without trailing punctuation. No nesting.
const INLINE =
  /(`+)([^\u2028]+?)\1|\*\*([^*\u2028]+?)\*\*|__([^_\u2028]+?)__|\*([^*\s\u2028](?:[^*\u2028]*?[^*\s\u2028])?)\*|(?<![\p{L}\p{N}_])_([^_\s\u2028](?:[^_\u2028]*?[^_\s\u2028])?)_(?![\p{L}\p{N}_])|\[([^\]\u2028]+)\]\(([^)\s\u2028]+)\)|<(https?:\/\/[^>\s\u2028]+)>|(?<![\p{L}\p{N}_/])(https?:\/\/[^\s<>\u2028]*[^\s<>\u2028.,;:!?)\]'"*_`])/gu;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+/;
const QUOTE = /^\s{0,3}>\s?/;

/** The source ranges shown inside `[from, to)`, with each formatted run's tag and full extent. */
function inlineRuns(text, from, to) {
  const runs = [];
  const part = text.slice(from, to);
  let pos = 0;
  for (const m of part.matchAll(INLINE)) {
    if (m.index > pos) runs.push({ s: from + pos, e: from + m.index });
    const rs = from + m.index,
      re = rs + m[0].length;
    let tag, inner, open, href;
    if (m[1]) {
      tag = "code";
      inner = m[2];
      open = m[1].length;
    } else if (m[3] !== undefined || m[4] !== undefined) {
      tag = "strong";
      inner = m[3] ?? m[4];
      open = 2;
    } else if (m[5] !== undefined || m[6] !== undefined) {
      tag = "em";
      inner = m[5] ?? m[6];
      open = 1;
    } else if (m[7] !== undefined) {
      tag = "a";
      inner = m[7];
      open = 1;
      href = m[8];
    } else {
      tag = "a";
      inner = m[9] ?? m[10];
      open = m[9] ? 1 : 0;
      href = inner;
    }
    // A link to anything other than http or https shows only its text.
    if (tag === "a" && !SAFE_LINK.test(href)) tag = "";
    runs.push({ s: rs + open, e: rs + open + inner.length, fmt: { tag, href, rs, re } });
    pos = m.index + m[0].length;
  }
  if (pos < part.length) runs.push({ s: from + pos, e: to });
  return runs;
}

/**
 * Free text, such as a todo's description, as HTML: each line formatted on its own (code, bold,
 * italic, links and bare web addresses), line breaks kept. `link(href, shown)` may give a link
 * other words to show (`text`) and keep it in this tab (`sameTab`); other links open a new tab.
 */
export function inlineHtml(text, link = () => ({})) {
  return String(text)
    .split(/\r?\n/)
    .map((line) =>
      inlineRuns(line, 0, line.length)
        .map((r) => {
          const shown = esc(line.slice(r.s, r.e));
          const tag = r.fmt?.tag;
          if (!tag) return shown;
          if (tag !== "a") return `<${tag}>${shown}</${tag}>`;
          const how = link(r.fmt.href, line.slice(r.s, r.e)) ?? {};
          const words = how.text ? esc(how.text) : shown;
          const target = how.sameTab ? "" : ' target="_blank" rel="noopener noreferrer"';
          return `<a href="${esc(r.fmt.href)}"${target}>${words}</a>`;
        })
        .join(""),
    )
    .join("<br>");
}

/** Splits the line into its source lines, as [start, end) offsets. */
function pieces(text) {
  const out = [];
  let s = 0;
  for (const p of text.split(JOIN)) {
    out.push([s, s + p.length]);
    s += p.length + 1;
  }
  return out;
}

/**
 * Prose across a line's source lines: each source line formats on its own, a later one drops its
 * leading spaces (and `strip`, such as a quote marker), and each break shows as a space, as
 * published markdown flows wrapped lines.
 */
function prose(text, from, strip) {
  const runs = [];
  pieces(text).forEach(([s, e], i) => {
    if (e <= from) return;
    let start = Math.max(s, from);
    if (i && s >= from) {
      runs.push({ s: s - 1, e: s, soft: true });
      start = s + (text.slice(s, e).match(strip ?? /^\s*/)?.[0].length ?? 0);
    }
    runs.push(...inlineRuns(text, start, e));
  });
  return runs;
}

/**
 * How a line shows: its wrapper, a marker that isn't source text, and the source ranges shown. A
 * kind the renderer doesn't know, a table row, or a missing block shows the whole line as written.
 */
function layout(text, block) {
  const kind = block?.kind;
  const all = [{ s: 0, e: text.length }];
  if (kind === "break") return { wrap: "break", runs: [] };
  if (kind === "code") {
    const ps = pieces(text);
    const fenced = /^\s{0,3}(```|~~~)/.test(text);
    if (fenced) {
      const last = ps.length > 1 && /^\s*(```|~~~)\s*$/.test(text.slice(...ps.at(-1)));
      const s = ps.length > 1 ? ps[1][0] : text.length;
      const e = last ? Math.max(s, ps.at(-1)[0] - 1) : text.length;
      return { wrap: "code", runs: s < e ? [{ s, e }] : [] };
    }
    // Indented code: each source line drops up to four leading spaces.
    const runs = [];
    ps.forEach(([s, e], i) => {
      if (i) runs.push({ s: s - 1, e: s }); // the line break between source lines
      const lead = text.slice(s, e).match(/^( {1,4}|\t)/)?.[0].length ?? 0;
      if (e > s + lead) runs.push({ s: s + lead, e });
    });
    return { wrap: "code", runs };
  }
  if (kind === "list") {
    const m = text.match(LIST);
    if (!m) return { wrap: "", runs: inlineRuns(text, 0, text.length) };
    const task = text.slice(m[0].length).match(TASK);
    // A task item shows a checkbox for its box, in the bullet's place.
    let marker = /\d/.test(m[2]) ? m[2] : "•";
    if (task && marker === "•") marker = "";
    const done = task ? { task: task[1] === " " ? "open" : "done" } : {};
    return { wrap: "list", indent: block.indent, marker, ...done, runs: prose(text, m[0].length + (task?.[0].length ?? 0)) };
  }
  if (kind === "quote") {
    const first = text.match(QUOTE);
    return { wrap: "quote", runs: prose(text, first ? first[0].length : 0, /^\s{0,3}>?\s?/) };
  }
  if (kind === "paragraph") return { wrap: "", runs: prose(text, 0) };
  return { wrap: "", runs: all };
}

/**
 * The line as HTML. `decorations` are source ranges: `{ start, end, mark: true }` for a highlight,
 * or `{ start, end, insert }` for a tracked change, whose deleted text shows struck through and
 * whose inserted text follows it. Where they overlap, the edit wins.
 */
export function renderLine(text, decorations = [], block) {
  const asWritten = { wrap: "", runs: [{ s: 0, e: text.length }] };
  let shape;
  try {
    shape = layout(text, block);
  } catch {
    shape = asWritten;
  }
  return paint(text, shape, asWritten, decorations);
}

/**
 * A table row as one HTML string per cell, each cell's text formatted and decorated in place, so
 * selections and highlights still map to source offsets. Returns null when a tracked change crosses
 * a cell boundary, so the caller shows the row as written.
 */
export function renderTableRow(text, decorations = []) {
  const cells = rowCells(text);
  const edits = decorations.filter((d) => d.insert !== undefined);
  if (edits.some((d) => !cells.some((c) => c.start <= d.start && d.end <= c.end))) return null;
  return cells.map((c) => {
    const inCell = decorations
      .filter((d) => d.start < c.end && c.start < d.end)
      .map((d) => ({ ...d, start: Math.max(d.start, c.start), end: Math.min(d.end, c.end) }));
    const asWritten = { wrap: "", runs: c.end > c.start ? [{ s: c.start, e: c.end }] : [] };
    let shape;
    try {
      shape = { wrap: "", runs: inlineRuns(text, c.start, c.end) };
    } catch {
      shape = asWritten;
    }
    return paint(text, shape, asWritten, inCell);
  });
}

/** Paints a laid-out line, or part of one, with its highlights and tracked changes. */
function paint(text, shape, asWritten, decorations) {
  const edits = decorations.filter((d) => d.insert !== undefined).sort((a, b) => a.start - b.start);
  // An edit that touches hidden markup (a marker or a link target) shows on the line as written,
  // so every deleted character is visible.
  const shown = edits.length ? new Set(shape.runs.filter((r) => !r.soft).flatMap((r) => Array.from({ length: r.e - r.s }, (_, i) => r.s + i))) : new Set();
  if (edits.some((d) => Array.from({ length: d.end - d.start }, (_, i) => d.start + i).some((i) => !shown.has(i) && text[i] !== JOIN))) shape = asWritten;
  const marks = decorations.filter((d) => d.mark && !edits.some((e) => d.start < e.end && e.start < d.end));
  const cuts = new Set(decorations.flatMap((d) => [d.start, d.end]));
  let html = "",
    open = null,
    pending = [...edits];
  const flushEdits = (upTo) => {
    while (pending.length && pending[0].end <= upTo) html += `<ins class="tc-ins" data-comment="hide">${esc(pending.shift().insert)}</ins>`;
  };
  const close = () => {
    if (open) html += open.tag ? `</${open.tag}>` : "";
    open = null;
  };
  for (const run of shape.runs) {
    const points = [run.s, ...[...cuts].filter((c) => c > run.s && c < run.e).sort((a, b) => a - b), run.e];
    for (let i = 0; i < points.length - 1; i++) {
      const s = points[i],
        e = points[i + 1];
      flushEdits(s);
      if (open !== (run.fmt ?? null)) {
        close();
        if (run.fmt) {
          open = run.fmt;
          html += open.tag === "a" ? `<a href="${esc(open.href)}" target="_blank" rel="noopener noreferrer">` : open.tag ? `<${open.tag}>` : "";
        }
      }
      const piece = `<span data-s="${s}">${run.soft ? " " : esc(text.slice(s, e))}</span>`;
      const del = edits.some((d) => d.start <= s && e <= d.end && d.start < d.end);
      const hl = marks.some((d) => d.start <= s && e <= d.end);
      // Struck and highlighted text are the document's own words, so hiding comments only plains them.
      html += del ? `<del class="tc-del" data-comment="plain">${piece}</del>` : hl ? `<mark class="hl" data-comment="plain">${piece}</mark>` : piece;
    }
  }
  close();
  flushEdits(Infinity);
  if (shape.wrap === "break") return `<hr class="ln-break">${html}`;
  if (shape.wrap === "code") return `<code class="ln-code">${html}</code>`;
  if (shape.wrap === "quote") return `<span class="ln-quote">${html}</span>`;
  if (shape.wrap === "list") {
    const box = shape.task
      ? `<input type="checkbox" class="ln-check nosrc" disabled${shape.task === "done" ? " checked" : ""} aria-label="${shape.task === "done" ? "Done" : "Not done"}">`
      : "";
    const marker = shape.marker
      ? `<span class="ln-marker nosrc" aria-hidden="true">${esc(shape.marker)}</span>`
      : `<span class="ln-marker nosrc">${box}</span>`;
    return `<span class="ln-list" style="--indent:${Number(shape.indent) || 0}">${marker}<span class="ln-body">${shape.marker ? box : ""}${html}</span></span>`;
  }
  return html;
}

/** The line's text as a reader sees it, without markers. Wrapped prose flows; code keeps its line breaks. */
export function shownText(text, block) {
  return layout(text, block)
    .runs.map((r) => (r.soft ? " " : text.slice(r.s, r.e)))
    .join("")
    .replace(/\u2028/g, "\n");
}

/**
 * Finds words the reviewer typed in the line as a reader sees it, across formatting, and returns
 * the matching source range widened to whole formatted runs. When the shown text has no match,
 * typed source text, markers included, matches. Returns null when the words aren't in the line.
 */
export function findTyped(text, block, typed) {
  if (!typed) return null;
  // The shown text first, so a word in a hidden link target never wins over the word a reader sees.
  const map = []; // the source offset of each shown character
  for (const r of layout(text, block).runs) for (let i = r.s; i < r.e; i++) map.push(i);
  const shown = map.map((i) => (text[i] === "\u2028" ? " " : text[i])).join("");
  const from = shown.indexOf(typed);
  if (from >= 0) return widen(text, block, map[from], map[from + typed.length - 1] + 1);
  const at = text.indexOf(typed);
  return at >= 0 ? widen(text, block, at, at + typed.length) : null;
}

/** A selection [start, end) in source offsets, widened so it never cuts a formatted run's markers. */
export function widen(text, block, start, end) {
  for (const r of layout(text, block).runs) {
    if (!r.fmt) continue;
    const { rs, re } = r.fmt;
    if (start > rs && start < re) start = rs;
    if (end > rs && end < re) end = re;
  }
  return { start, end };
}

/**
 * The source offset of a DOM position inside a rendered line, or null when it sits in text that
 * isn't source text (a marker or Claude's inserted words).
 */
export function sourceOffset(container, node, offset) {
  const host = node.nodeType === 1 ? node : node.parentElement;
  if (host?.closest(".tc-ins, .nosrc")) return null;
  if (node.nodeType === 3) {
    const span = host?.closest("[data-s]");
    if (span && container.contains(span)) return Number(span.dataset.s) + offset;
  }
  const spans = [...container.querySelectorAll("[data-s]")];
  if (!spans.length) return null;
  const at = document.createRange();
  at.setStart(node, offset);
  at.collapse(true);
  for (const sp of spans) if (at.comparePoint(sp, 0) >= 0) return Number(sp.dataset.s);
  const last = spans.at(-1);
  return Number(last.dataset.s) + last.textContent.length;
}
