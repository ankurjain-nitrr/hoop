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
    if (!raw.trim()) { open = ""; return; }
    const segs = raw.split(JOIN);
    const first = segs[0];
    const prev = rawLines[i - 1] ?? "";
    // The parser looks one source line ahead: the block's next source line, or the next stored line.
    const next = segs.length > 1 ? segs[1] : (rawLines[i + 1] ?? "").split(JOIN)[0];
    const table = first.includes("|") && (TABLE_DELIM.test(next) || TABLE_DELIM.test(first) || (prev.includes("|") && open === ""));
    const kind = FENCE.test(first) ? "code"
      : open === "" && BREAK.test(first) ? "break"
      : ITEM.test(first) ? "list"
      : open === "" && INDENTED.test(first) ? "indented"
      : QUOTE.test(first) ? "quote"
      : table ? "table"
      : "paragraph";
    // A fence, quote, table row or break closes itself; the others stay open for the next line.
    open = kind === "list" || kind === "indented" || kind === "paragraph" ? kind : "";
    out.push({ kind: kind === "indented" ? "code" : kind, indent: kind === "list" ? first.match(/^\s*/)[0].length : 0 });
  });
  return out;
}
