import { anchorText, DOC, itemLines, type ReviewDoc } from "./contract.js";
import { HoopError } from "./util.js";

export type Place = { item: string; line: number; start: number };

/** Every place `words` occurs in the document's lines, the title and the TL;DR, or in one item. */
export function placesOf(doc: ReviewDoc, words: string, item?: string): Place[] {
  const lines: { item: string; line: number; text: string }[] = [];
  if (!item || item === DOC) {
    lines.push({ item: DOC, line: 1, text: doc.title });
    // An automatic TL;DR repeats the first paragraph, so the words would always occur twice.
    if (!doc.tldr_auto) lines.push({ item: DOC, line: 2, text: doc.tldr });
  }
  for (const it of doc.items) if (!item || it.id === item) itemLines(it).forEach((text, i) => lines.push({ item: it.id, line: i + 1, text }));
  return lines.flatMap(({ item, line, text }) => {
    const found: Place[] = [];
    for (let at = text.indexOf(words); at >= 0; at = text.indexOf(words, at + 1)) found.push({ item, line, start: at });
    return found;
  });
}

const where = (p: Place) => (p.item === DOC ? (p.line === 1 ? "the title" : "the TL;DR") : `${p.item} line ${p.line}`);

/**
 * The anchor for the exact words a comment or edit names, in place of a line number. `item`
 * narrows the search. Words that occur nowhere, or in more than one place, are refused with
 * every place they occur.
 */
export function resolveQuote(doc: ReviewDoc, q: { item?: string; words: string }, ctx: { path?: string } = {}) {
  const path = ctx.path ?? "words";
  const refuse = (message: string) => new HoopError(message, [{ path, message }]);
  if (!q.words) throw refuse("the quoted words are empty");
  if (q.item && q.item !== DOC && !doc.items.some((i) => i.id === q.item)) throw refuse(`unknown item ${q.item}`);
  const places = placesOf(doc, q.words, q.item);
  const scope = q.item ? ` in ${q.item === DOC ? "the title or TL;DR" : q.item}` : "";
  if (!places.length) throw refuse(`"${q.words}" occurs nowhere${scope}; quote the line's text as feedback shows it`);
  if (places.length > 1)
    throw refuse(`"${q.words}" occurs in ${places.length} places${scope}: ${places.map(where).join(", ")}; quote more words, or name the item`);
  const p = places[0]!;
  const text = anchorText(doc, p.item, p.line)!;
  return { item: p.item, line: p.line, range: { start: p.start, end: p.start + q.words.length, quote: text.slice(p.start, p.start + q.words.length) } };
}
