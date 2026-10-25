// The build page's formatting toolbar: each button turns a block's text and its selection into new
// text and a new selection. The text stays markdown, so what the buttons make exports as written.
// Pure functions of `(text, start, end)`, so the page and the tests share them.

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

/** Whether `mark` sits at `at` in `text` as a whole run: for `*`, not part of a `**`. */
function markAt(text, at, mark) {
  if (at < 0 || text.slice(at, at + mark.length) !== mark) return false;
  const c = mark[0];
  return text[at - 1] !== c && text[at + mark.length] !== c;
}

/**
 * Wraps the selection in `mark`, or inserts `mark` + `placeholder` + `mark` with the placeholder
 * selected. Spaces at the selection's edges stay outside the marks. Pressed again on wrapped text
 * (the marks just outside the selection, or at its edges), it takes the marks away. A selection over
 * several lines is wrapped line by line, since marks can't cross a blank line.
 */
function wrap(text, start, end, mark, placeholder, pad = "") {
  let chosen = text.slice(start, end);
  if (chosen.includes("\n")) {
    const lines = chosen.split("\n").map((l) => {
      // A list item's marker stays outside the marks.
      const head = l.match(/^\s*(?:(?:[-*+]|\d+[.)])\s+)?/)[0];
      const word = l.slice(head.length).trim();
      if (!word) return l;
      const at = l.indexOf(word, head.length);
      return `${l.slice(0, at)}${mark}${word}${mark}${l.slice(at + word.length)}`;
    });
    const body = lines.join("\n");
    return { text: text.slice(0, start) + body + text.slice(end), start, end: start + body.length };
  }
  if (chosen.trim()) {
    start += chosen.length - chosen.trimStart().length;
    end -= chosen.length - chosen.trimEnd().length;
    chosen = text.slice(start, end);
  }
  const m = mark.length;
  if (chosen && markAt(text, start - m, mark) && markAt(text, end, mark)) {
    const out = text.slice(0, start - m) + chosen + text.slice(end + m);
    return { text: out, start: start - m, end: end - m };
  }
  if (chosen.length > 2 * m && markAt(chosen, 0, mark) && markAt(chosen, chosen.length - m, mark)) {
    const inner = chosen.slice(m, -m);
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }
  const inner = chosen || placeholder;
  const out = text.slice(0, start) + mark + pad + inner + pad + mark + text.slice(end);
  const at = start + m + pad.length;
  return { text: out, start: at, end: at + inner.length };
}

/** The longest run of backticks in `text`. */
const longestTicks = (text) => Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));

/** Inline code around the selection, with a backtick run longer than any inside it. */
function inlineCode(text, start, end) {
  const chosen = text.slice(start, end);
  // A selection already wrapped in code: its marks are the run just outside it.
  const outside = text.slice(0, start).match(/`+$/)?.[0] ?? "";
  if (chosen && outside && text.slice(end, end + outside.length) === outside) return wrap(text, start, end, outside, "code");
  const mark = "`".repeat(longestTicks(chosen) + 1);
  const pad = /^`|`$/.test(chosen.trim()) ? " " : "";
  return wrap(text, start, end, mark, "code", pad);
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
  const before = text.slice(0, s);
  const after = text.slice(e);
  const lead = !before.trim() ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = !after.trim() ? "" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return [lead, trail];
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
  return `${"#".repeat(level)} ${words.replace(/\s+/g, " ").trim()}`;
}

/**
 * Applies toolbar button `tool` to `text` with `[start, end)` selected, and returns the new text and
 * what to select in it: Bold and Italic wrap the selection, Link makes it a link with its address
 * selected, the lists mark each selected line (or unmark them), Table adds a table, and Code marks
 * words on one line as code or makes lines a code block.
 */
export function applyTool(tool, text, start, end, { inline = false } = {}) {
  if (tool === "bold") return wrap(text, start, end, "**", "bold text");
  // Italic first takes away a single `*` or `_` around the selection, then adds `*`.
  if (tool === "italic" && text.slice(start, end) && markAt(text, start - 1, "_") && markAt(text, end, "_")) return wrap(text, start, end, "_", "");
  if (tool === "italic") return wrap(text, start, end, "*", "italic text");
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
    if (!chosen.includes("\n")) return inlineCode(text, start, end);
    if (inline) return wrap(text, start, end, "`".repeat(longestTicks(chosen) + 1), "code");
    const [s, e] = lineSpan(text, start, end);
    const body = text.slice(s, e);
    const fence = "`".repeat(Math.max(3, longestTicks(body) + 1));
    const [lead, trail] = apart(text, s, e);
    const at = s + lead.length + fence.length + 1;
    return { text: `${text.slice(0, s)}${lead}${fence}\n${body}\n${fence}${trail}${text.slice(e)}`, start: at, end: at + body.length };
  }
  throw new Error(`no tool ${tool}`);
}
