// The build page's formatting toolbar: each button turns a block's text and its selection into new
// text and a new selection. The text stays markdown, so what the buttons make exports as written.
// Pure functions of `(text, start, end)`, so the page and the tests share them.

/** The toolbar's buttons, in order: [name, the label people read]. */
export const TOOLS = [
  ["bold", "Bold"],
  ["italic", "Italic"],
  ["link", "Link"],
  ["bullets", "Bulleted list"],
  ["numbers", "Numbered list"],
  ["table", "Table"],
  ["code", "Code"],
];

const BULLET = /^(\s*)[-*+]\s+/;
const NUMBER = /^(\s*)\d+[.)]\s+/;

/** Wraps the selection in `mark`, or inserts `mark` + `placeholder` + `mark` with the placeholder selected. */
function wrap(text, start, end, mark, placeholder) {
  const inner = text.slice(start, end) || placeholder;
  const out = text.slice(0, start) + mark + inner + mark + text.slice(end);
  return { text: out, start: start + mark.length, end: start + mark.length + inner.length };
}

/** The start of the line holding `at`, and the end of the line holding `to`. */
function lineSpan(text, at, to) {
  const last = to > at && text[to - 1] === "\n" ? to - 1 : to;
  const s = text.lastIndexOf("\n", at - 1) + 1;
  const n = text.indexOf("\n", last);
  return [s, n < 0 ? text.length : n];
}

/** Makes the selected lines a list with `marker(k)` before each, or plain lines again when they already are one. */
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
  return { text: text.slice(0, s) + body + text.slice(e), start: s, end: s + body.length };
}

/** Inserts `block` as its own block after the line holding the cursor, with a blank line on each side; `pick` is the part selected. */
function insertBlock(text, end, block, pick) {
  const [, e] = lineSpan(text, end, end);
  const before = text.slice(0, e);
  const after = text.slice(e);
  const lead = !before.trim() ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = !after.trim() ? "" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const at = before.length + lead.length;
  const from = at + block.indexOf(pick);
  return { text: before + lead + block + trail + after, start: from, end: from + pick.length };
}

/**
 * A heading's markdown from the words in its box, at `level` (1 for the title): the box holds only
 * the words, so the `#`s come back, unless the person typed them. Any other block's text (level 0)
 * stays as typed.
 */
export function headingSource(level, words) {
  if (!level || /^\s{0,3}#/.test(words) || !words.trim()) return words;
  return `${"#".repeat(level)} ${words.replace(/\s+/g, " ").trim()}`;
}

/**
 * Applies toolbar button `tool` to `text` with `[start, end)` selected, and returns the new text and
 * what to select in it: Bold and Italic wrap the selection, Link makes it a link with its address
 * selected, the lists mark each selected line (or unmark them), Table adds a table, and Code marks
 * words on one line as code or makes lines a code block.
 */
export function applyTool(tool, text, start, end) {
  if (tool === "bold") return wrap(text, start, end, "**", "bold text");
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
    if (!chosen.includes("\n")) return wrap(text, start, end, "`", "code");
    const [s, e] = lineSpan(text, start, end);
    const body = text.slice(s, e);
    const fenced = `\`\`\`\n${body}\n\`\`\``;
    return { text: text.slice(0, s) + fenced + text.slice(e), start: s + 4, end: s + 4 + body.length };
  }
  throw new Error(`no tool ${tool}`);
}
