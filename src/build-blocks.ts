// The blocks of a build's markdown: their kinds, and the split of a markdown file into them.
import { ATX, FENCE, headingLevel, ITEM, subtitleWords, TABLE_DELIM } from "../web/blocks.js";

/** The blocks a build is made of: the blocks a markdown file has. A subtitle is one line of emphasis, which under the title is the document's subtitle. */
export const BLOCK_KINDS = ["h1", "subtitle", "h2", "h3", "paragraph", "list", "table", "code", "diagram"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** A heading's kind by its level: below `##`, every heading is a subsection. */
const HEADINGS = ["h1", "h2"] as const;
const MERMAID = /^\s{0,3}(```|~~~)\s*mermaid\s*$/;

/** Whether block `i` sits right under a title that starts the document, where a subtitle goes. */
export const underTitle = (blocks: { kind: BlockKind }[], i: number) => i === 1 && blocks[0]!.kind === "h1";

/** Gives each prose block its kind for where it now sits: the subtitle under the title, a paragraph elsewhere. */
export function settleKinds<B extends { kind: BlockKind; text: string }>(blocks: B[]): B[] {
  blocks.forEach((b, i) => {
    if (b.kind === "subtitle" || b.kind === "paragraph") b.kind = kindOf(b.text, underTitle(blocks, i));
  });
  return blocks;
}

/**
 * A block's kind, from its first lines. Headings below `###` count as subsections. A short line of
 * emphasis is the subtitle only right under the title (`underTitle`); anywhere else it is a paragraph.
 */
export function kindOf(text: string, underTitle = false): BlockKind {
  const [first = "", second = ""] = text.split("\n");
  const h = first.match(ATX);
  if (h) return HEADINGS[h[1]!.length - 1] ?? "h3";
  if (MERMAID.test(first)) return "diagram";
  if (FENCE.test(first)) return "code";
  if (underTitle && subtitleWords(text) !== undefined) return "subtitle";
  if (ITEM.test(first)) return "list";
  if (first.includes("|") && TABLE_DELIM.test(second)) return "table";
  return "paragraph";
}

/** A heading block's level, or 0 for any other block. */
export const levelOf = headingLevel;

/**
 * Splits markdown into blocks: blank lines separate blocks outside code fences, and a heading is
 * always a block of its own. Each block keeps the exact text that follows it (`sep`), and the text
 * before the first and after the last is `lead` and `tail`, so `joinBlocks` gives the input back
 * byte for byte.
 */
export function splitBlocks(markdown: string): { lead: string; tail: string; blocks: { kind: BlockKind; text: string; sep: string }[] } {
  const lines = markdown.split("\n");
  const spans = blockSpans(lines);
  const at = (line: number) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
  // A block's end offset excludes the newline after its last line.
  const ends = spans.map(([s, e]) => [at(s), at(e) - 1] as const);
  if (!spans.length) return { lead: markdown, tail: "", blocks: [] };
  const blocks = ends.map(([s, e], k) => {
    const text = markdown.slice(s, Math.min(e, markdown.length));
    const sep = k + 1 < ends.length ? markdown.slice(Math.min(e, markdown.length), ends[k + 1]![0]) : "";
    return { kind: kindOf(text), text, sep };
  });
  settleKinds(blocks);
  return { lead: markdown.slice(0, ends[0]![0]), tail: markdown.slice(Math.min(ends.at(-1)![1], markdown.length)), blocks };
}

/** Each block of `splitBlocks` as [first line, line after its last]. */
function blockSpans(lines: string[]): [number, number][] {
  const spans: [number, number][] = [];
  let start = -1;
  let fence = "";
  const close = (end: number) => {
    if (start >= 0) spans.push([start, end]);
    start = -1;
  };
  // A line inside a code fence: the closing one ends the block.
  const fenced = (line: string, i: number) => {
    if (!line.trim().startsWith(fence)) return;
    fence = "";
    close(i + 1);
  };
  lines.forEach((line, i) => {
    if (fence) return fenced(line, i);
    if (!line.trim()) return close(i);
    const opens = FENCE.exec(line)?.[1];
    if (opens || ATX.test(line)) close(i);
    if (start < 0) start = i;
    if (opens) fence = opens;
    else if (ATX.test(line)) close(i + 1);
  });
  close(lines.length);
  return spans;
}
