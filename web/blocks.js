// What kind of markdown block each document line is. One module holds the rule, so the server's
// parser, line splitter and edit engine, and the pages, can't disagree. A document line joins its
// source lines with U+2028 (JOIN).

export const JOIN = " ";
export const FENCE = /^\s{0,3}(```|~~~)/;
export const ITEM = /^(\s*)([-*+]|\d+[.)])\s/;
export const QUOTE = /^\s{0,3}>/;
export const BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
export const INDENTED = /^( {4}|\t)/;
/** A markdown table's delimiter row, e.g. `|---|:-:|` (GFM: at least one dash per cell). */
export const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The markers that start a line's source lines; an edit that changes them changes the structure. */
const MARKER = /^\s*(#{1,6}\s|```|~~~|[-*+]\s|\d+[.)]\s|>|\|)/;
export const pieceMarker = (piece) => piece.split(JOIN).map((l) => l.match(MARKER)?.[1]?.trim() ?? "");

/**
 * Each non-blank line's kind and indent, parallel to the item's commentable body lines. `rawLines`
 * are the stored body lines, untrimmed, with blank lines kept, so indents and table neighbors are
 * known. Kinds: paragraph, list, quote, code, break and table. Indent counts the leading spaces of
 * the line's first source line. A line that fits no other kind is a paragraph.
 */
export function blockKinds(rawLines) {
  const out = [];
  let prev = ""; // the kind of the line just before, or "" after a blank line
  rawLines.forEach((raw, i) => {
    if (!raw.trim()) { prev = ""; return; }
    const first = raw.split(JOIN)[0];
    const indent = first.match(/^\s*/)[0].length;
    const table = raw.includes("|") && (TABLE_DELIM.test(raw) || TABLE_DELIM.test(rawLines[i + 1] ?? "") || (rawLines[i - 1] ?? "").includes("|"));
    // "- - -" right after a paragraph, list item or indented code starts a list item, not a break.
    const open = prev === "paragraph" || prev === "list" || prev === "indented";
    const kind = FENCE.test(first) ? "code"
      : BREAK.test(raw) && !(open && ITEM.test(first)) ? "break"
      : ITEM.test(first) ? "list"
      : INDENTED.test(first) ? "indented"
      : QUOTE.test(first) ? "quote"
      : table ? "table"
      : "paragraph";
    prev = kind;
    out.push({ kind: kind === "indented" ? "code" : kind, indent: kind === "list" ? indent : 0 });
  });
  return out;
}
