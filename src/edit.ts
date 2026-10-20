import { anchorText, DOC, itemLines, type Item, type ReviewDoc } from "./contract.js";
import { pieceMarker } from "../web/blocks.js";

/** Replace `find` with `replace` in the text at an anchor. `start` pins the occurrence when known. */
export type Edit = { item: string; line: number; find: string; replace: string; start?: number };
export type Located = Edit & { start: number; end: number; text: string };
export type WordStats = { removed: number; added: number; line_words: number; large: boolean };

/** Every rule an edit must keep, with the sentence the propose tool's description gives for it. */
export const RULES = {
  line_exists: "The item and line exist.",
  find_given: "find gives the exact words to replace.",
  found: "find occurs in the line.",
  once_in_line: "find occurs exactly once in the line; quote more words when it repeats.",
  changes_text: "replace differs from find.",
  no_line_breaks: "replace holds no line break, so an edit never adds or removes lines.",
  not_tldr: "An automatic TL;DR isn't edited, since it repeats the first paragraph; edit that paragraph.",
  not_empty: "A line keeps some text; an edit never removes a whole line.",
  option_label: "An option's edit changes its label, never its letter or marker.",
  editable_in_place: "The line is text that can be edited in place.",
  keeps_markup: "In a document, the line keeps its markdown structure: heading, list, quote, table and code markers.",
  in_scope: "Edits stay in the comment's scope: its line, its section for a heading comment, or the whole document for a title or TL;DR comment.",
  no_overlap: "Two edits in one call never touch the same text.",
  line_unchanged: "An edit applies only while its line reads exactly as when it was proposed.",
} as const;

export type Rule = keyof typeof RULES;

/** The rules as one list, for a tool description. */
export const rulesText = () =>
  Object.entries(RULES)
    .map(([name, text]) => `${name}: ${text}`)
    .join(" ");

/** A refused edit. Its message starts with the rule it broke. */
export class EditError extends Error {
  constructor(
    readonly rule: Rule,
    message: string,
    readonly field = "find",
  ) {
    super(`${rule}: ${message}`);
  }
}

/** Finds the edit's span: at `start` if given, else the single occurrence of `find`. */
export function locate(doc: ReviewDoc, e: Edit): Located {
  const text = anchorText(doc, e.item, e.line);
  if (text === undefined) throw new EditError("line_exists", `no line ${e.line} in ${e.item}`, "line");
  if (!e.find) throw new EditError("find_given", "find must not be empty");
  if (e.start !== undefined) {
    if (text.slice(e.start, e.start + e.find.length) !== e.find) throw new EditError("line_unchanged", "the text changed since this edit was made");
    return { ...e, start: e.start, end: e.start + e.find.length, text };
  }
  const first = text.indexOf(e.find);
  if (first < 0) throw new EditError("found", `"${e.find}" is not in ${e.item} line ${e.line}`);
  if (text.indexOf(e.find, first + 1) >= 0)
    throw new EditError("once_in_line", `"${e.find}" occurs more than once in ${e.item} line ${e.line}; include more words`);
  return { ...e, start: first, end: first + e.find.length, text };
}

/** Where an anchor's text lives in the document, so an edit changes that field and nothing else. */
function setter(doc: ReviewDoc, itemId: string, line: number): { prefix: number; limit: number; set: (s: string) => void } {
  if (itemId === DOC) {
    if (line === 1) return { prefix: 0, limit: Infinity, set: (s) => (doc.title = s) };
    return { prefix: 0, limit: Infinity, set: (s) => (doc.tldr = s) };
  }
  const item = doc.items.find((i) => i.id === itemId) as Item;
  const title = { prefix: 0, limit: Infinity, set: (s: string) => (item.title = s) };
  if (line === 0) return title;
  // itemLines order: non-empty body lines, then (questions) choices, then the check.
  const raw = (item.body ?? "").split("\n");
  const body = raw.map((r, i) => ({ r, i })).filter(({ r }) => r.trim());
  let n = line - 1;
  if (n < body.length) {
    const { r, i } = body[n]!;
    const lead = r.length - r.trimStart().length,
      display = r.trim();
    return {
      prefix: 0,
      limit: Infinity,
      set: (s) => {
        raw[i] = r.slice(0, lead) + s + r.slice(lead + display.length);
        item.body = raw.join("\n");
      },
    };
  }
  n -= body.length;
  if (item.type === "question") {
    if (!body.length) {
      if (n === 0) return title;
      n -= 1;
    }
    const choice = item.choices?.[n];
    if (choice) {
      const prefix = choice.id.length + 2;
      return {
        prefix,
        limit: prefix + choice.label.length,
        set: (s) => (choice.label = s.slice(prefix, s.length - (choice.recommended ? " (recommended)".length : 0))),
      };
    }
    n -= item.choices?.length ?? 0;
  }
  if (item.check && n === 0) return { prefix: "Check: ".length, limit: Infinity, set: (s) => (item.check = s.slice("Check: ".length)) };
  return title; // an item with no lines shows its title as line 1
}

/** A copy of doc with exactly one span replaced; every other character is unchanged. */

export function applyEdit(doc: ReviewDoc, e: Edit): { doc: ReviewDoc; located: Located } {
  if (/[\r\n]/.test(e.replace)) throw new EditError("no_line_breaks", "an edit can't add or remove lines; keep line breaks out of replace", "replace");
  if (e.item === DOC && e.line === 2 && doc.tldr_auto)
    throw new EditError("not_tldr", "the TL;DR repeats the first paragraph; edit that paragraph instead", "line");
  const located = locate(doc, e);
  const changed = located.text.slice(0, located.start) + e.replace + located.text.slice(located.end);
  if (e.item !== DOC && e.line > 0 && !changed.trim())
    throw new EditError("not_empty", "removing a whole line isn't supported; replace its text instead", "replace");
  const next: ReviewDoc = structuredClone(doc);
  const field = setter(next, e.item, e.line);
  if (located.start < field.prefix || located.end > field.limit) throw new EditError("option_label", "edit the option's label, not its letter or marker");
  field.set(located.text.slice(0, located.start) + e.replace + located.text.slice(located.end));
  const after = anchorText(next, e.item, e.line);
  if (after !== located.text.slice(0, located.start) + e.replace + located.text.slice(located.end))
    throw new EditError("editable_in_place", "this text can't be edited in place", "line");
  if (itemLines(next.items.find((i) => i.id === e.item) ?? next.items[0]!).length !== itemLines(doc.items.find((i) => i.id === e.item) ?? doc.items[0]!).length)
    throw new EditError("no_line_breaks", "an edit can't add or remove lines; keep line breaks out of replace", "replace");
  // In a document, an edit changes words, not structure: no new headings, list items, quotes or code fences.
  if (doc.kind === "doc" && e.line > 0 && pieceMarker(changed).join() !== pieceMarker(located.text).join())
    throw new EditError("keeps_markup", "an edit can't change the line's markdown structure (heading, list, quote, table or code markers)", "replace");
  return { doc: next, located };
}

const words = (s: string) => s.match(/\S+/g) ?? [];

/** Words removed and added by replacing find with replace (word-level diff), and whether it's a large rewrite. */
export function wordStats(find: string, replace: string, lineText: string): WordStats {
  const a = words(find),
    b = words(replace);
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const common = dp[0]![0]!,
    line_words = Math.max(1, words(lineText).length);
  const removed = a.length - common,
    added = b.length - common;
  return { removed, added, line_words, large: Math.max(removed, added) > line_words / 2 };
}

/** Shrinks a whole-line replacement to the words that actually differ. */
export function narrow(text: string, replacement: string): { start: number; find: string; replace: string } {
  let p = 0;
  while (p < text.length && p < replacement.length && text[p] === replacement[p]) p++;
  while (p > 0 && /\S/.test(text[p - 1]!)) p--; // back to a word boundary
  let s = 0;
  while (s < text.length - p && s < replacement.length - p && text[text.length - 1 - s] === replacement[replacement.length - 1 - s]) s++;
  while (s > 0 && /\S/.test(text[text.length - s]!)) s--;
  return { start: p, find: text.slice(p, text.length - s), replace: replacement.slice(p, replacement.length - s) };
}
