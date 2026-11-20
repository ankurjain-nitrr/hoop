// A review's lines that aren't a section's text, shared by the pages and the server: the document's
// own lines (item DOC: 1 its title, 2 its TL;DR, 3 its subtitle), and a question's choices as lines.

/**
 * The DOC item's lines, in order: the document field each shows, and its name.
 * @type {readonly { field: "title" | "tldr" | "subtitle"; name: string }[]}
 */
export const DOC_LINES = [
  { field: "title", name: "title" },
  { field: "tldr", name: "TL;DR" },
  { field: "subtitle", name: "subtitle" },
];

/**
 * The text of DOC line `line` (from 1) in `doc`; undefined for any other line.
 * @param {{ title: string; tldr: string; subtitle?: string }} doc
 * @param {number} line
 * @returns {string | undefined}
 */
export const docLineText = (doc, line) => {
  const l = DOC_LINES[line - 1];
  return l ? doc[l.field] : undefined;
};

/**
 * DOC line `line`'s name in words: "the title", "the TL;DR" or "the subtitle".
 * @param {number} line
 */
export const docLineName = (line) => `the ${DOC_LINES[line - 1]?.name}`;

/** What a question's recommended choice ends with as a line. */
export const RECOMMENDED = " (recommended)";

/**
 * A question's choice as its line reads: `A) Label`, and ` (recommended)` on the recommended one.
 * @param {{ id: string; label: string; recommended?: boolean }} c
 */
export const choiceLine = (c) => `${c.id}) ${c.label}${c.recommended ? RECOMMENDED : ""}`;
