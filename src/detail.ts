import { itemBlocks, itemLines, type ReviewDoc } from "./contract.js";

/** A list item needs at least this many to judge a document by its list items. */
const MIN_ITEMS = 3;
/** Backticked words that read as code: a path, a file name, a file:line reference or a call. */
const CODE = /`([^`\s]*(?:\/|\w\.[A-Za-z]{1,4}(?::\d+)?|:\d+|\w\(\))[^`\s]*)`/g;
/** A file:line reference written without backticks. */
const FILE_LINE = /\b[\w./-]+\.[A-Za-z]{1,4}:\d+\b/g;

function codeIn(line: string): string[] {
  return [...[...line.matchAll(CODE)].map((m) => m[1]!), ...[...line.matchAll(FILE_LINE)].map((m) => m[0])];
}

/**
 * A note for Claude when more than a third of a document's list items (at least three of them) name
 * code: file paths, file:line references or function calls. It names up to three of them. A
 * person reviews decisions; that detail belongs in the pull requests.
 */
export function codeDetail(doc: ReviewDoc): string | undefined {
  let items = 0;
  const hits: string[] = [];
  let codeItems = 0;
  for (const item of doc.items) {
    const kinds = itemBlocks(item);
    itemLines(item).forEach((line, i) => {
      if (kinds[i]?.kind !== "list") return;
      items++;
      const code = codeIn(line);
      if (!code.length) return;
      codeItems++;
      for (const c of code) if (hits.length < 3 && !hits.includes(c)) hits.push(c);
    });
  }
  if (items < MIN_ITEMS || codeItems * 3 <= items) return undefined;
  return (
    `${codeItems} of this document's ${items} list items name code, such as ${hits.map((h) => `\`${h}\``).join(", ")}. ` +
    "Write for the person deciding: behaviour, choices and how you'll know it works; file names, functions and line counts belong in the pull requests."
  );
}
