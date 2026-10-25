// What kind of markdown block each document line is. One module holds the rule, so the server's
// parser, line splitter and edit engine, and the pages, can't disagree. A document line joins its
// source lines with U+2028 (JOIN).

export const JOIN = "\u2028";
export const FENCE = /^\s{0,3}(```|~~~)/;
export const ITEM = /^(\s*)([-*+]|\d+[.)])\s/;
export const QUOTE = /^\s{0,3}>/;
export const BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
export const INDENTED = /^( {4}|\t)/;
/** A markdown table's delimiter row, e.g. `|---|:-:|` (GFM: at least one dash per cell). */
export const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** One source line of emphasis, `*words*` or `_words_`: no line break inside, no space at either end. */
export const SUBTITLE = /^\*([^*\s](?:[^*\n\u2028]*[^*\s])?)\*$|^_([^_\s](?:[^_\n\u2028]*[^_\s])?)_$/;
/** A fence that opens a Mermaid diagram. */
const MERMAID = /^\s{0,3}(```|~~~)\s*mermaid\s*$/;
/** Whether a document line is a Mermaid diagram. */
export const isDiagram = (text) => MERMAID.test(text.split(JOIN)[0] ?? "");
/** The longest subtitle, in characters. */
export const SUBTITLE_MAX = 120;

/**
 * A subtitle's words, or undefined: one line of emphasis (`SUBTITLE`) of at most 120 characters
 * that doesn't end a sentence with a period, so a one-sentence italic summary stays the TL;DR.
 */
export function subtitleWords(line) {
  const m = line.match(SUBTITLE);
  const words = m ? (m[1] ?? m[2]) : undefined;
  return words && words.length <= SUBTITLE_MAX && !/(^|[^.])\.$/.test(words) ? words : undefined;
}

/**
 * A table row's cells, split on unescaped pipes, each trimmed with its source offsets: `start` and
 * `end` bound the cell's text in `line`. `\|` escapes stay in the cell.
 */
export function rowCells(line) {
  const cells = [];
  let from = line.length - line.trimStart().length;
  let to = line.trimEnd().length;
  if (line[from] === "|") from++;
  if (to > from && line[to - 1] === "|" && line[to - 2] !== "\\") to--;
  let start = from;
  for (let i = from; i <= to; i++) {
    if (i < to && !(line[i] === "|" && line[i - 1] !== "\\")) continue;
    let s = start,
      e = i;
    while (s < e && /\s/.test(line[s])) s++;
    while (e > s && /\s/.test(line[e - 1])) e--;
    cells.push({ text: line.slice(s, e), start: s, end: e });
    start = i + 1;
  }
  return cells;
}

/** The markers that start a line's source lines; an edit that changes them changes the structure. */
const MARKER = /^\s*(#{1,6}\s|```|~~~|[-*+]\s|\d+[.)]\s|>|\|)/;
export const pieceMarker = (piece) => piece.split(JOIN).map((l) => l.match(MARKER)?.[1]?.trim() ?? "");

/**
 * Each non-blank line's kind and indent, parallel to the item's commentable body lines. `rawLines`
 * are the stored body lines, untrimmed, with blank lines kept. Each stored line is one block, so
 * this replays the parser's state between blocks: whether the block before is still open (a list
 * item, indented code or a paragraph) or a blank line closed it. Kinds: paragraph, list, quote,
 * code, break and table. Indent counts a list item's leading spaces. Anything else is a paragraph.
 */
export function blockKinds(rawLines) {
  const out = [];
  let open = ""; // the block still open before this line: "list", "indented", "paragraph" or ""
  rawLines.forEach((raw, i) => {
    if (!raw.trim()) {
      open = "";
      return;
    }
    const segs = raw.split(JOIN);
    const first = segs[0];
    const prev = rawLines[i - 1] ?? "";
    // The parser looks one source line ahead: the block's next source line, or the next stored line.
    const next = segs.length > 1 ? segs[1] : (rawLines[i + 1] ?? "").split(JOIN)[0];
    const table = first.includes("|") && (TABLE_DELIM.test(next) || TABLE_DELIM.test(first) || (prev.includes("|") && open === ""));
    const kind = FENCE.test(first)
      ? "code"
      : open === "" && BREAK.test(first)
        ? "break"
        : ITEM.test(first)
          ? "list"
          : open === "" && INDENTED.test(first)
            ? "indented"
            : QUOTE.test(first)
              ? "quote"
              : table
                ? "table"
                : "paragraph";
    // A fence, quote, table row or break closes itself; the others stay open for the next line.
    open = kind === "list" || kind === "indented" || kind === "paragraph" ? kind : "";
    out.push({ kind: kind === "indented" ? "code" : kind, indent: kind === "list" ? first.match(/^\s*/)[0].length : 0 });
  });
  return out;
}

// A built document as an outline: a heading block owns every block after it up to the next heading
// at its level or above (H1 > H2 > H3), so a section holds its subsections. The build's server and
// page both use these, so what moves together and where it may go can't disagree.

/** A heading's opening `#`s: `# A` is level 1. */
export const ATX = /^\s{0,3}(#{1,6})(\s|$)/;

/** A block's heading level, 1 to 6, or 0 for a block that isn't a heading. */
export const headingLevel = (block) => block.text.match(ATX)?.[1]?.length ?? 0;

/** The blocks after heading `i` that are its section, as [start, end), subsections included. */
export function sectionRange(blocks, i) {
  const level = headingLevel(blocks[i]);
  let end = i + 1;
  while (end < blocks.length && !(headingLevel(blocks[end]) > 0 && headingLevel(blocks[end]) <= level)) end++;
  return [i + 1, end];
}

/** The blocks that go with block `i` when it moves or is removed with its content: a heading and its section, or the block alone. */
export const unitRange = (blocks, i) => (headingLevel(blocks[i]) ? [i, sectionRange(blocks, i)[1]] : [i, i + 1]);

/** The heading that holds block `i`: the nearest heading before it at a higher level (for any other block, at any level), or -1. */
export function parentOf(blocks, i) {
  const level = headingLevel(blocks[i]) || 7;
  for (let k = i - 1; k >= 0; k--) {
    const l = headingLevel(blocks[k]);
    if (l > 0 && l < level) return k;
  }
  return -1;
}

/**
 * The blocks block `i` trades places with when it moves `to` "up" or "down", as [start, end), or
 * undefined at the edge of its section. A heading trades with the neighbouring section at its own
 * level inside the same parent; any other block trades with the next block of its section's own
 * text, never with a heading.
 */
export function swapRange(blocks, i, to) {
  const level = headingLevel(blocks[i]);
  if (to === "down") {
    const end = unitRange(blocks, i)[1];
    if (end >= blocks.length || headingLevel(blocks[end]) !== level) return undefined;
    return unitRange(blocks, end);
  }
  if (i === 0) return undefined;
  if (!level) return headingLevel(blocks[i - 1]) ? undefined : [i - 1, i];
  let k = i - 1;
  while (k >= 0 && !(headingLevel(blocks[k]) > 0 && headingLevel(blocks[k]) <= level)) k--;
  return k >= 0 && headingLevel(blocks[k]) === level ? [k, i] : undefined;
}
