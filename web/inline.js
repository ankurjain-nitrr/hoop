// The line renderer: shows a document line as formatted text, and keeps a map from what is shown
// back to the line's source text, so comments anchor to source positions as before. Every shown
// source character sits in a `<span data-s="offset">`; markers that aren't source text (a bullet,
// Claude's inserted words) carry no `data-s`. Markup comes only from escaped text and fixed tags.
import { esc } from "./esc.js";
import { JOIN, rowCells, TASK } from "./blocks.js";

const SAFE_LINK = /^https?:\/\//i;
// The marks inside a line: code spans, whose text stays literal; links; web addresses written bare
// or in angle brackets, without trailing punctuation; and bold and italic, which nest in each other
// and around code and links. Each sticky pattern is tried only where its first character is, and
// none of them backtracks over more than one address, so a line renders in linear time.
const ANGLED = /<(https?:\/\/[^<>\s\u2028]+)>/y;
const BARE = /(?<![\p{L}\p{N}_/])https?:\/\/[^\s<>\u2028]*[^\s<>\u2028.,;:!?)\]'"*_`]/uy;
const TARGET_END = /[)\s\u2028]/g;
const SPACE = /\s/u;
const PUNCT = /[\p{P}\p{S}]/u;
const WORD = /[\p{L}\p{N}]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+/;
const QUOTE = /^\s{0,3}>\s?/;

/** A sticky pattern's match at `at`, or null. */
function stuck(re, text, at) {
  re.lastIndex = at;
  return re.exec(text);
}

/** How many `c` characters run on from `at`. */
function runOf(text, at, c) {
  let k = at;
  while (text[k] === c) k++;
  return k - at;
}

/**
 * Where each run of backticks in `[from, to)` closes a code span: at the next run of exactly as
 * many backticks, as a map from a run's start to its closer's start.
 */
function codeClosers(text, from, to) {
  const ticks = [];
  for (let i = text.indexOf("`", from); i >= 0 && i < to; i = text.indexOf("`", i)) {
    const n = Math.min(runOf(text, i, "`"), to - i);
    ticks.push([i, n]);
    i += n;
  }
  const closers = new Map();
  const next = new Map(); // a run length to the start of the next run that long
  for (let k = ticks.length - 1; k >= 0; k--) {
    const [at, n] = ticks[k];
    if (next.has(n)) closers.set(at, next.get(n));
    next.set(n, at);
  }
  return closers;
}

/**
 * A delimiter run of `*` or `_` at `at`, and whether it can open or close bold and italic: a run
 * opens before a word and closes after one, and an `_` inside a word (`snake_case`) does neither.
 */
function delimiter(text, at, from, to) {
  const ch = text[at];
  const len = Math.min(runOf(text, at, ch), to - at);
  const before = at > from ? text[at - 1] : " ",
    after = at + len < to ? text[at + len] : " ";
  // Unlike CommonMark, a run beside punctuation also opens after a letter and closes before one, so
  // `**Note:**text` and `中文**（注）**中文` format, as writing without spaces between words needs.
  const left = !SPACE.test(after) && (!PUNCT.test(after) || SPACE.test(before) || PUNCT.test(before) || WORD.test(before));
  const right = !SPACE.test(before) && (!PUNCT.test(before) || SPACE.test(after) || PUNCT.test(after) || WORD.test(after));
  // `_` beside Chinese or Japanese text, which has no spaces between words, acts as `*` does.
  if (ch === "*" || CJK.test(before) || CJK.test(after)) return { ch, at, len, open: left, close: right };
  return { ch, at, len, open: left && (!right || PUNCT.test(before)), close: right && (!left || PUNCT.test(after)) };
}

/**
 * The link written `[words](target)` at `at`, whose words may hold formatting but no other link.
 * The next `]` and the target after it are looked up once, however many `[` come before it.
 */
function linkAt(text, at, to, scan) {
  if (scan.bracket >= 0 && scan.bracket <= at) scan.bracket = text.indexOf("]", at + 1);
  const ce = scan.bracket;
  if (ce < at + 2 || ce >= to || text[ce + 1] !== "(") return null;
  // A target runs to the first `)` or space; where that is, is remembered for the targets after it.
  if (scan.stop <= ce + 1) scan.stop = stuck(TARGET_END, text, ce + 2)?.index ?? to;
  const end = scan.stop;
  if (end >= to || text[end] !== ")" || end === ce + 2) return null;
  return { tag: "a", href: text.slice(ce + 2, end), rs: at, cs: at + 1, ce, re: end + 1, words: true };
}

/** A web address at `at`, in angle brackets or bare. */
function addressAt(text, at, to) {
  const m = text[at] === "<" ? stuck(ANGLED, text, at) : stuck(BARE, text, at);
  if (!m || at + m[0].length > to) return null;
  const re = at + m[0].length;
  return m[1] ? { tag: "a", href: m[1], rs: at, cs: at + 1, ce: re - 1, re } : { tag: "a", href: m[0], rs: at, cs: at, ce: re, re };
}

/** A mark at `at` whose inside isn't formatted further (code, a web address), or a link; null when there's none. */
function markAt(text, at, to, scan) {
  const c = text[at];
  if (c === "`") {
    const close = scan.closers.get(at);
    if (close === undefined) return null;
    const n = runOf(text, at, "`");
    return { tag: "code", rs: at, cs: at + n, ce: close, re: close + n };
  }
  if (scan.inLink) return null;
  if (c === "[") return linkAt(text, at, to, scan);
  return c === "<" || c === "h" ? addressAt(text, at, to) : null;
}

/**
 * Every formatted span in `[from, to)`, as `{ tag, href, rs, cs, ce, re }`: the span's source runs
 * `[rs, re)` and its shown text `[cs, ce)`. Spans nest and never overlap.
 */
function spansIn(text, from, to, inLink, spans) {
  const scan = { closers: codeClosers(text, from, to), inLink, bracket: from, stop: -1 };
  const delims = [];
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === "*" || c === "_") {
      const d = delimiter(text, i, from, to);
      delims.push(d);
      i += d.len;
      continue;
    }
    const mark = markAt(text, i, to, scan);
    if (!mark) {
      i += c === "`" ? runOf(text, i, "`") : 1;
      continue;
    }
    if (mark.tag === "a" && !SAFE_LINK.test(mark.href)) mark.tag = ""; // shows only its words
    spans.push(mark);
    if (mark.words) spansIn(text, mark.cs, mark.ce, true, spans);
    i = mark.re;
  }
  emphasis(delims, spans);
  return spans;
}

/**
 * Pairs `*` and `_` runs into bold and italic, as CommonMark does: each closing run takes the
 * nearest opening run of its character, two characters for bold or one for italic, and the
 * unpaired runs between them stay text. Each run is passed over at most once, so it stays linear.
 */
function emphasis(delims, spans) {
  const stack = [];
  const open = { "*": 0, _: 0 }; // the opening runs on the stack, by character
  for (const d of delims) {
    while (d.close && d.len && open[d.ch]) spans.push(pair(stack, open, d));
    if (d.open && d.len) {
      stack.push(d);
      open[d.ch]++;
    }
  }
}

/**
 * Closes the nearest opening run of the closing run `d`'s character, from the inside out, and
 * drops the opening runs it passes over. Returns the bold or italic span they make.
 */
function pair(stack, open, d) {
  let k = stack.length - 1;
  while (stack[k].ch !== d.ch) k--;
  for (const skipped of stack.splice(k + 1)) open[skipped.ch]--;
  const o = stack[k];
  const n = o.len >= 2 && d.len >= 2 ? 2 : 1;
  o.len -= n;
  const span = { tag: n === 2 ? "strong" : "em", rs: o.at + o.len, cs: o.at + o.len + n, ce: d.at, re: d.at + n };
  d.at += n;
  d.len -= n;
  if (!o.len) open[stack.pop().ch]--;
  return span;
}

/**
 * The shown ranges of one source line's `[from, to)`. A run inside formatting carries its innermost
 * `fmt` (`{ tag, href, rs, cs, ce, re, parent, depth, link }`): `parent` leads out to the outermost, and
 * `link` is the link it sits in, if any.
 */
function segmentRuns(text, from, to, runs) {
  // Marks are found in the segment alone, so none reaches past it.
  const part = text.slice(from, to);
  const spans = spansIn(part, 0, part.length, false, [])
    .map((sp) => ({ ...sp, rs: sp.rs + from, cs: sp.cs + from, ce: sp.ce + from, re: sp.re + from }))
    .sort((a, b) => a.rs - b.rs || b.re - a.re);
  const open = [];
  let pos = from,
    fmt;
  const shown = (e) => {
    if (e > pos) runs.push(fmt ? { s: pos, e, fmt } : { s: pos, e });
  };
  const leave = () => {
    const top = open.pop();
    shown(top.ce);
    pos = top.re;
    fmt = fmt.parent;
  };
  for (const sp of spans) {
    while (open.length && open.at(-1).re <= sp.rs) leave();
    shown(sp.rs);
    const f = { tag: sp.tag, href: sp.href, rs: sp.rs, cs: sp.cs, ce: sp.ce, re: sp.re, parent: fmt, depth: depth(fmt) + 1 };
    f.link = sp.tag === "a" ? f : fmt?.link;
    fmt = f;
    open.push(sp);
    pos = sp.cs;
  }
  while (open.length) leave();
  shown(to);
}

/** The source ranges shown inside `[from, to)`, each formatted run with its formatting; marks never cross a source line. */
function inlineRuns(text, from, to) {
  const runs = [];
  let s = from;
  for (;;) {
    const j = text.indexOf(JOIN, s);
    const e = j < 0 || j >= to ? to : j;
    segmentRuns(text, s, e, runs);
    if (e >= to) return runs;
    runs.push({ s: e, e: e + 1 });
    s = e + 1;
  }
}

const depth = (fmt) => fmt?.depth ?? 0;

/**
 * The tags that close `from`'s formatting and open `to`'s, keeping what they share. It walks only
 * the formatting that differs, so a line's tags cost as much as its formatting.
 */
function retag(from, to, openTag) {
  let a = from ?? undefined,
    b = to ?? undefined,
    closes = "";
  const opens = [];
  while (a !== b) {
    const da = depth(a),
      db = depth(b);
    if (da >= db) {
      closes += a.tag ? `</${a.tag}>` : "";
      a = a.parent;
    }
    if (db >= da) {
      opens.push(b);
      b = b.parent;
    }
  }
  return closes + opens.reverse().map(openTag).join("");
}

/**
 * Free text, such as a todo's description, as HTML: each line formatted on its own (code, bold,
 * italic, links and bare web addresses), line breaks kept. `link(href, shown)` may give a link
 * other words to show (`text`) and keep it in this tab (`sameTab`); other links open a new tab.
 */
export function inlineHtml(text, link = () => ({})) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => freeLine(line, link))
    .join("<br>");
}

/** Titles, headings, paragraphs and the TL;DR format their inline text as prose. */
export const PROSE = { kind: "paragraph", indent: 0 };

/** A title as plain text, for a tab title, an accessible name or a tooltip: its words without markdown markers. */
export const plainText = (text) => shownText(String(text ?? ""), PROSE).replace(/\s*\n\s*/g, " ");

/** Formatting with its links taken out, so a link's words show as text around them. */
function unlinked(fmt, seen) {
  if (!fmt) return undefined;
  if (!seen.has(fmt)) seen.set(fmt, { ...fmt, tag: fmt.tag === "a" ? "" : fmt.tag, parent: unlinked(fmt.parent, seen) });
  return seen.get(fmt);
}

/**
 * A title as HTML for a place that is itself a link, such as a row on Home: formatted as prose
 * (code, bold, italic), with a link showing only its words.
 */
export function titleHtml(text) {
  const line = String(text ?? "").replace(/[\r\n\u2028]+/g, " ");
  const seen = new Map();
  let html = "",
    open = null;
  for (const r of inlineRuns(line, 0, line.length)) {
    const at = unlinked(r.fmt, seen);
    html += retag(open, at, openTag);
    open = at;
    html += esc(line.slice(r.s, r.e));
  }
  return html + retag(open, null, openTag);
}

/** One line of free text as HTML. A link given other words shows only those words. */
function freeLine(line, link) {
  const runs = inlineRuns(line, 0, line.length);
  const words = new Map(); // each link's shown words
  for (const r of runs) {
    const a = r.fmt?.link;
    if (a) words.set(a, (words.get(a) ?? "") + line.slice(r.s, r.e));
  }
  const hows = new Map([...words].map(([a, shown]) => [a, link(a.href, shown) ?? {}]));
  const openTag = (f) => {
    if (f.tag !== "a") return f.tag ? `<${f.tag}>` : "";
    const how = hows.get(f);
    const target = how.sameTab ? "" : ' target="_blank" rel="noopener noreferrer"';
    return `<a href="${esc(f.href)}"${target}>${how.text ? esc(how.text) : ""}`;
  };
  let html = "",
    open = null;
  for (const r of runs) {
    const a = r.fmt?.link;
    const replaced = Boolean(a && hows.get(a).text);
    const at = replaced ? a : (r.fmt ?? null);
    html += retag(open, at, openTag);
    open = at;
    if (!replaced) html += esc(line.slice(r.s, r.e));
  }
  return html + retag(open, null, openTag);
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

/** A code block's layout: a fenced block shows what is between its fences, an indented one its lines without the indent. */
function codeLayout(text) {
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

/** A list item's layout: its number or bullet, or a task's checkbox in the bullet's place, then its prose. */
function listLayout(text, block) {
  const m = text.match(LIST);
  if (!m) return { wrap: "", runs: inlineRuns(text, 0, text.length) };
  const task = text.slice(m[0].length).match(TASK);
  // A task item shows a checkbox for its box, in the bullet's place.
  let marker = /\d/.test(m[2]) ? m[2] : "•";
  if (task && marker === "•") marker = "";
  const done = task ? { task: task[1] === " " ? "open" : "done" } : {};
  return { wrap: "list", indent: block.indent, marker, ...done, runs: prose(text, m[0].length + (task?.[0].length ?? 0)) };
}

/** Each kind of block's layout, by its kind. */
const LAYOUTS = {
  break: () => ({ wrap: "break", runs: [] }),
  code: codeLayout,
  list: listLayout,
  quote(text) {
    const first = text.match(QUOTE);
    return { wrap: "quote", runs: prose(text, first ? first[0].length : 0, /^\s{0,3}>?\s?/) };
  },
  paragraph: (text) => ({ wrap: "", runs: prose(text, 0) }),
};

/**
 * How a line shows: its wrapper, a marker that isn't source text, and the source ranges shown. A
 * kind the renderer doesn't know, a table row, or a missing block shows the whole line as written.
 */
function layout(text, block) {
  const kind = block?.kind;
  if (Object.hasOwn(LAYOUTS, kind ?? "")) return LAYOUTS[kind](text, block);
  return { wrap: "", runs: [{ s: 0, e: text.length }] };
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

/** Whether an edit deletes a character the layout doesn't show, other than a break between source lines. */
function editsHidden(text, shape, edits) {
  if (!edits.length) return false;
  const shown = new Set(shape.runs.filter((r) => !r.soft).flatMap((r) => Array.from({ length: r.e - r.s }, (_, i) => r.s + i)));
  return edits.some((d) => Array.from({ length: d.end - d.start }, (_, i) => d.start + i).some((i) => !shown.has(i) && text[i] !== JOIN));
}

/** Paints a laid-out line, or part of one, with its highlights and tracked changes. */
function paint(text, shape, asWritten, decorations) {
  const edits = decorations.filter((d) => d.insert !== undefined).sort((a, b) => a.start - b.start);
  // An edit that touches hidden markup (a marker or a link target) shows on the line as written,
  // so every deleted character is visible.
  if (editsHidden(text, shape, edits)) shape = asWritten;
  const marks = decorations.filter((d) => d.mark && !edits.some((e) => d.start < e.end && e.start < d.end));
  const cuts = new Set(decorations.flatMap((d) => [d.start, d.end]));
  let html = "",
    open = null,
    pending = [...edits];
  const flushEdits = (upTo) => {
    while (pending.length && pending[0].end <= upTo) html += `<ins class="tc-ins" data-comment="hide">${esc(pending.shift().insert)}</ins>`;
  };
  for (const run of shape.runs) {
    const points = [run.s, ...[...cuts].filter((c) => c > run.s && c < run.e).sort((a, b) => a - b), run.e];
    for (let i = 0; i < points.length - 1; i++) {
      const s = points[i],
        e = points[i + 1];
      flushEdits(s);
      html += retag(open, run.fmt ?? null, openTag);
      open = run.fmt ?? null;
      const piece = `<span data-s="${s}">${run.soft ? " " : esc(text.slice(s, e))}</span>`;
      const del = edits.some((d) => d.start <= s && e <= d.end && d.start < d.end);
      const hl = marks.some((d) => d.start <= s && e <= d.end);
      html += markPiece(piece, del, hl);
    }
  }
  html += retag(open, null, openTag);
  flushEdits(Infinity);
  return wrapLine(shape, html);
}

/** A formatted run's opening tag: a link opens in a new tab; a run whose tag was dropped opens nothing. */
function openTag(fmt) {
  if (fmt.tag === "a") return `<a href="${esc(fmt.href)}" target="_blank" rel="noopener noreferrer">`;
  return fmt.tag ? `<${fmt.tag}>` : "";
}

/** A piece of text struck through when an edit deletes it, else highlighted when a comment marks it. */
function markPiece(piece, del, hl) {
  // Struck and highlighted text are the document's own words, so hiding comments only plains them.
  if (del) return `<del class="tc-del" data-comment="plain">${piece}</del>`;
  return hl ? `<mark class="hl" data-comment="plain">${piece}</mark>` : piece;
}

/** A painted line in its wrapper: a break's rule, code, a quote, or a list item with its marker or checkbox. */
function wrapLine(shape, html) {
  if (shape.wrap === "break") return `<hr class="ln-break">${html}`;
  if (shape.wrap === "code") return `<code class="ln-code">${html}</code>`;
  if (shape.wrap === "quote") return `<span class="ln-quote">${html}</span>`;
  if (shape.wrap !== "list") return html;
  const box = shape.task
    ? `<input type="checkbox" class="ln-check nosrc" disabled${shape.task === "done" ? " checked" : ""} aria-label="${shape.task === "done" ? "Done" : "Not done"}">`
    : "";
  const marker = shape.marker ? `<span class="ln-marker nosrc" aria-hidden="true">${esc(shape.marker)}</span>` : `<span class="ln-marker nosrc">${box}</span>`;
  return `<span class="ln-list" style="--indent:${Number(shape.indent) || 0}">${marker}<span class="ln-body">${shape.marker ? box : ""}${html}</span></span>`;
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

/**
 * A selection [start, end) in source offsets, widened so it never cuts a formatted run's markers.
 * It takes in the innermost run the selection sits in, and any run whose markers it cuts, so the
 * quote stays balanced markdown: "new" in `**Ship the *new* flow**` quotes `*new*`.
 */
export function widen(text, block, start, end) {
  const seen = new Set();
  for (const r of layout(text, block).runs) {
    for (let f = r.fmt; f && !seen.has(f); f = f.parent) seen.add(f);
  }
  // Innermost first: a run sits strictly inside any run around it, so it is shorter.
  const fmts = [...seen].sort((a, b) => a.re - a.rs - (b.re - b.rs));
  const inner = fmts.find((f) => f.rs <= start && end <= f.re && (start > f.rs || end < f.re));
  if (inner) ({ rs: start, re: end } = inner);
  for (const f of fmts) {
    if (cutsStart(f, start, end)) start = f.rs;
    if (cutsEnd(f, start, end)) end = f.re;
  }
  return { start, end };
}

/** Whether a selection's start cuts a run: inside its opening marker, or inside it while the end is past it. */
const cutsStart = (f, start, end) => start > f.rs && (start < f.cs || (start < f.re && end > f.re));
/** Whether a selection's end cuts a run: inside its closing marker, or inside it while the start is before it. */
const cutsEnd = (f, start, end) => end < f.re && (end > f.ce || (end > f.rs && start < f.rs));

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
