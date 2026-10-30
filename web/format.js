// The build page's formatting toolbar: each button turns a block's text and its selection into new
// text and a new selection. The text stays markdown, so what the buttons make exports as written.
// Pure functions of `(text, start, end)`, so the page and the tests share them.
import { TABLE_DELIM } from "./blocks.js";

/** The toolbar's buttons, in order: [name, the label people read, its key with Ctrl or Cmd]. */
export const TOOLS = [
  ["bold", "Bold", "b"],
  ["italic", "Italic", "i"],
  ["link", "Link", "k"],
  ["bullets", "Bulleted list"],
  ["numbers", "Numbered list"],
  ["table", "Table"],
  ["code", "Code"],
];

/** The buttons a table's cells take: a table can't hold lists, another table or a code block. */
export const TABLE_TOOLS = ["bold", "italic", "link", "code"];

const BULLET = /^(\s*)[-*+]\s+/;
const NUMBER = /^(\s*)\d+[.)]\s+/;

/** How many `c` characters run back from `at` (before it) and on from `at` (from it). */
const runBack = (text, at, c) => {
  let k = 0;
  while (at - k - 1 >= 0 && text[at - k - 1] === c) k++;
  return k;
};
const runOn = (text, at, c) => {
  let k = 0;
  while (text[at + k] === c) k++;
  return k;
};

/** The lengths of the runs of `c` in `text`. */
const runs = (text, c) => (text.match(new RegExp(`\\${c}+`, "g")) ?? []).map((r) => r.length);

/** The longest run of backticks in `text`. */
const longestTicks = (text) => Math.max(0, ...runs(text, "`"));

/** A letter or digit, which an `_` beside it makes part of a word rather than italic. */
const WORDY = /[\p{L}\p{N}]/u;

/**
 * One kind of inline mark, as Bold, Italic and Code press it: `around(text, start, end)` says how
 * many of its characters wrap the selection just outside it (0 when none), `inside(chosen)` the same
 * for marks at the selection's own edges, `ok(inner)` whether text between marks holds no further
 * run of the mark, so `**a** and **b**` isn't one bold, and `open`/`close` are the marks to add.
 */

/** Bold (`n` 2) or Italic (`n` 1) with `*`: a run of 3 is both, so each button takes its own part away. */
function stars(n) {
  const has = (k) => k === n || k === 3;
  const clean = (inner) => runs(inner, "*").every((r) => (n === 2 ? r < 2 : r === 2));
  return {
    around: (text, s, e) => {
      const k = Math.min(runBack(text, s, "*"), runOn(text, e, "*"));
      return has(k) ? n : 0;
    },
    inside: (chosen) => {
      const k = Math.min(runOn(chosen, 0, "*"), runBack(chosen, chosen.length, "*"));
      return has(k) && chosen.length > 2 * k ? { cut: n, keep: k - n } : null;
    },
    ok: clean,
    open: "*".repeat(n),
    close: "*".repeat(n),
  };
}

/** Italic written with `_`, only where the `_`s aren't part of a word (`snake_case_name`). */
const underscores = {
  around: (text, s, e) =>
    text[s - 1] === "_" && text[e] === "_" && text[s - 2] !== "_" && text[e + 1] !== "_" && !WORDY.test(text[s - 2] ?? "") && !WORDY.test(text[e + 1] ?? "")
      ? 1
      : 0,
  inside: () => null,
  ok: (inner) => !inner.includes("_"),
};

/**
 * Inline code. Marks just outside are a run of backticks, with the one space of padding a code span
 * gets when its text starts or ends with a backtick; new marks are one backtick longer than any run
 * inside the selection.
 */
function ticks(chosen) {
  const mark = "`".repeat(longestTicks(chosen) + 1);
  const pad = /^`|`$/.test(chosen) ? " " : "";
  return {
    around: (text, s, e) => {
      const space = text[s - 1] === " " && text[e] === " " ? 1 : 0;
      const k = runBack(text, s - space, "`");
      return k && runOn(text, e + space, "`") === k && runBack(text, s - space - k, "`") === 0 ? k + space : 0;
    },
    inside: () => null,
    ok: () => true,
    open: mark + pad,
    close: pad + mark,
  };
}

/**
 * Presses an inline mark on the selection. Spaces at its edges stay outside the marks, and a
 * selection of only spaces gets the placeholder. On text the mark already wraps, just outside the
 * selection or at its edges, it takes the mark away; else it adds it. A selection over several
 * lines, or in a table, is marked piece by piece (see `pieces`).
 */
function press(text, start, end, kind, placeholder, table) {
  const chosen = text.slice(start, end);
  if (chosen.includes("\n") || (table && chosen.includes("|"))) return pieces(text, start, end, kind, table);
  if (!chosen.trim()) {
    const k = kind(placeholder);
    const out = text.slice(0, start) + k.open + placeholder + k.close + text.slice(start);
    return { text: out, start: start + k.open.length, end: start + k.open.length + placeholder.length };
  }
  const s = start + chosen.length - chosen.trimStart().length;
  const e = end - (chosen.length - chosen.trimEnd().length);
  const word = text.slice(s, e);
  const k = kind(word);
  const off = k.around(text, s, e);
  if (off && k.ok(word)) return { text: text.slice(0, s - off) + word + text.slice(e + off), start: s - off, end: e - off };
  const edge = k.inside(word);
  if (edge) {
    const inner = word.slice(edge.cut + edge.keep, word.length - edge.cut - edge.keep);
    if (k.ok(inner)) {
      const kept = word.slice(0, edge.keep) + inner + word.slice(word.length - edge.keep);
      return { text: text.slice(0, s) + kept + text.slice(e), start: s, end: s + kept.length };
    }
  }
  const out = text.slice(0, s) + k.open + word + k.close + text.slice(e);
  return { text: out, start: s + k.open.length, end: s + k.open.length + word.length };
}

/** What starts a line and stays outside the marks: a quote's `>`s, then a list item's marker. */
const LEAD = /^\s*(?:>\s?)*(?:(?:[-*+]|\d+[.)])\s+)?/;

/**
 * Marks a selection piece by piece, since marks can't cross a line: each line's words, with what
 * starts the line left outside. In a table, each cell's words, with the `|`s left outside, and never
 * the row under the header that sets the columns, so the table stays a table.
 */
function pieces(text, start, end, kind, table) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let out = "";
  let at = start;
  for (const [k, part] of text.slice(start, end).split("\n").entries()) {
    const from = k ? at : lineStart;
    const lineEnd = text.indexOf("\n", from) < 0 ? text.length : text.indexOf("\n", from);
    if (k) out += "\n";
    if (table && TABLE_DELIM.test(text.slice(from, lineEnd))) out += part;
    // A piece that starts its line leaves what starts the line outside.
    else out += markLine(part, k || start === lineStart, kind, table);
    at += part.length + 1;
  }
  return { text: text.slice(0, start) + out + text.slice(end), start, end: start + out.length };
}

/** One line's piece with its words marked, what starts the line (`whole`) left outside, and in a table each cell's words. */
function markLine(part, whole, kind, table) {
  const head = whole ? (part.match(LEAD)?.[0] ?? "") : "";
  const bits = table ? part.slice(head.length).split(/(?<!\\)(\|)/) : [part.slice(head.length)];
  return head + bits.map((bit) => (bit === "|" || !bit.trim() ? bit : markWords(bit, kind))).join("");
}

/** `bit` with the mark around its words and its edge spaces outside. */
function markWords(bit, kind) {
  const word = bit.trim();
  const k = kind(word);
  const s = bit.indexOf(word);
  return `${bit.slice(0, s)}${k.open}${word}${k.close}${bit.slice(s + word.length)}`;
}

/** The start of the line holding `at`, and the end of the line holding `to`. */
function lineSpan(text, at, to) {
  const last = to > at && text[to - 1] === "\n" ? to - 1 : to;
  const s = text.lastIndexOf("\n", at - 1) + 1;
  const n = text.indexOf("\n", last);
  return [s, n < 0 ? text.length : n];
}

/** Blank lines to put before and after `[s, e)` so it is a block of its own. */
function apart(text, s, e) {
  return [gapBefore(text.slice(0, s)), gapAfter(text.slice(e))];
}

/** The line breaks that make a blank line after `before`, if any text comes before. */
function gapBefore(before) {
  if (!before.trim() || before.endsWith("\n\n")) return "";
  return before.endsWith("\n") ? "\n" : "\n\n";
}

/** The line breaks that make a blank line before `after`, if any text comes after. */
function gapAfter(after) {
  if (!after.trim() || after.startsWith("\n\n")) return "";
  return after.startsWith("\n") ? "\n" : "\n\n";
}

/**
 * Makes the selected lines a list with `marker(k)` before each, or plain lines again when they
 * already are one. The lines become a block of their own, with a blank line on each side, so a
 * list made inside a paragraph reads as a list.
 */
function listLines(text, start, end, pattern, marker) {
  const [s, e] = lineSpan(text, start, end);
  const lines = text.slice(s, e).split("\n");
  const all = lines.every((l) => pattern.test(l) || !l.trim());
  let k = 0;
  const next = lines.map((l) => {
    if (!l.trim()) return l;
    if (all) return l.replace(pattern, "$1");
    const plain = l.replace(BULLET, "$1").replace(NUMBER, "$1");
    return marker(++k) + plain;
  });
  const body = next.join("\n");
  const [lead, trail] = apart(text, s, e);
  const at = s + lead.length;
  return { text: text.slice(0, s) + lead + body + trail + text.slice(e), start: at, end: at + body.length };
}

/** Inserts `block` as its own block after the line holding the cursor, with a blank line on each side; `pick` is the part selected. */
function insertBlock(text, end, block, pick) {
  const [, e] = lineSpan(text, end, end);
  const [lead, trail] = apart(text, e, e);
  const from = e + lead.length + block.indexOf(pick);
  return { text: text.slice(0, e) + lead + block + trail + text.slice(e), start: from, end: from + pick.length };
}

/**
 * A heading's markdown from the words in its box, at `level` (1 for the title): the box holds only
 * the words, so the level's `#`s always go before them, even when the words start with `#` ("#1
 * priority"). Any other block's text (level 0), and an empty box, stay as typed.
 */
export function headingSource(level, words) {
  if (!level || !words.trim()) return words;
  const hashes = "#".repeat(level);
  const text = words.replace(/\s+/g, " ").trim();
  // Words ending in a run of #s ("Learn C #") would read as the heading's closing #s, so the
  // heading gets closing #s of its own, which keep the words' run.
  return /(^|\s)#+$/.test(text) ? `${hashes} ${text} ${hashes}` : `${hashes} ${text}`;
}

/**
 * Applies toolbar button `tool` to `text` with `[start, end)` selected, and returns the new text and
 * what to select in it: Bold and Italic wrap the selection, Link makes it a link with its address
 * selected, the lists mark each selected line (or unmark them), Table adds a table, and Code marks
 * words on one line as code or makes lines a code block.
 */
export function applyTool(tool, text, start, end, { inline = false } = {}) {
  if (tool === "bold") return press(text, start, end, () => stars(2), "bold text", inline);
  if (tool === "italic") {
    // Italic written with `_` comes off as such; else Italic is `*`.
    const chosen = text.slice(start, end).trim();
    const s = start + text.slice(start, end).indexOf(chosen);
    if (chosen && !chosen.includes("\n") && underscores.around(text, s, s + chosen.length) && underscores.ok(chosen))
      return { text: text.slice(0, s - 1) + chosen + text.slice(s + chosen.length + 1), start: s - 1, end: s - 1 + chosen.length };
    return press(text, start, end, () => stars(1), "italic text", inline);
  }
  if (tool === "link") {
    const words = text.slice(start, end) || "link text";
    const url = "https://";
    const out = `${text.slice(0, start)}[${words}](${url})${text.slice(end)}`;
    const at = start + words.length + 3;
    return { text: out, start: at, end: at + url.length };
  }
  if (tool === "bullets") return listLines(text, start, end, BULLET, () => "- ");
  if (tool === "numbers") return listLines(text, start, end, NUMBER, (k) => `${k}. `);
  if (tool === "table") return insertBlock(text, end, "| Column | Column |\n|---|---|\n| Cell | Cell |", "Column");
  if (tool === "code") {
    const chosen = text.slice(start, end);
    if (inline || !chosen.includes("\n")) return press(text, start, end, ticks, "code", inline);
    const [s, e] = lineSpan(text, start, end);
    const body = text.slice(s, e);
    const fence = "`".repeat(Math.max(3, longestTicks(body) + 1));
    const [lead, trail] = apart(text, s, e);
    const at = s + lead.length + fence.length + 1;
    return { text: `${text.slice(0, s)}${lead}${fence}\n${body}\n${fence}${trail}${text.slice(e)}`, start: at, end: at + body.length };
  }
  throw new Error(`no tool ${tool}`);
}
