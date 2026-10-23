import type { Choice, Item, ReviewDoc } from "./contract.js";
import { slugify } from "./util.js";
import { BREAK, FENCE, INDENTED, ITEM, JOIN, QUOTE, TABLE_DELIM, type BlockKind } from "../web/blocks.js";

/** Joins the source lines of one block (a wrapped paragraph, a code fence, a list item) into one line. */
export { JOIN };

const ATX = /^\s{0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const SETEXT = /^\s{0,3}(=+|-+)\s*$/;
/** A section whose heading starts with "Question:" asks the reviewer to pick one of its list items. */
const QUESTION = /^question\s*:/i;
const OPTION = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;
const LETTER = /^(?:\*\*)?\(?([A-Za-z])[.)](?:\*\*)?\s+/;
const RECOMMENDED = /\s*_?\(recommended\)_?\s*$/i;

/**
 * A question section's options: its top-level list items, at least two. An item that starts with a
 * letter ("A." or "B)") takes that letter as its ID; otherwise items take a, b, c in order. An item
 * that ends with "(recommended)" is the recommended one.
 */
function choicesOf(lines: string[]): Choice[] | undefined {
  const items = lines
    .filter((l) => OPTION.test(l))
    .map((l) =>
      l
        .split(JOIN)
        .map((t) => t.trim())
        .join(" ")
        .replace(OPTION, ""),
    );
  if (items.length < 2) return undefined;
  const letters = items.map((t) => t.match(LETTER)?.[1]?.toLowerCase());
  const lettered = letters.every(Boolean) && new Set(letters).size === letters.length;
  return items.map((t, i) => {
    const text = lettered ? t.replace(LETTER, "") : t;
    const recommended = RECOMMENDED.test(text);
    return { id: lettered ? letters[i]! : String.fromCharCode(97 + i), label: text.replace(RECOMMENDED, "").trim(), ...(recommended ? { recommended } : {}) };
  });
}

export type MarkdownOptions = {
  title?: string;
  tldr?: string;
  slug?: string;
  channel?: "local" | "github";
  review_id?: string;
  /** Called with the kind of each body line as the parser decides it; tests compare it with `blockKinds`. */
  onBlock?: (kind: BlockKind) => void;
};

/** A section's body lines, each with the source lines it came from (0-based, inclusive). */
type Section = { title: string; level: number; lines: string[]; spans: [number, number][] };

/** Where a source line sits: the item's position in the document and its line in `itemLines`, both from 0. */
export type LinePlace = { index: number; line: number };

/**
 * Turns any markdown document into a review document (FR-16). The first `#` heading is the title;
 * every other heading starts a section; text before the first section is an untitled introduction.
 * Each block is one commentable line that keeps its exact source text: a paragraph (wrapped lines
 * joined with U+2028), a list item with its continuation lines, a quote line, a table row, a whole
 * code block, or a thematic break. Blank lines between blocks are kept, so an unedited document
 * exports back byte for byte (setext headings are written back in `#` form).
 */
export function parseMarkdown(markdown: string, opts: MarkdownOptions = {}): ReviewDoc {
  return parse(markdown, opts).doc;
}

/**
 * Each source line's place in the document that `parseMarkdown` builds with the same options: a map
 * from the source line number, from 1, to its item and line. A line inside a joined line maps to
 * that joined line. Headings and blank lines have no place.
 */
export function linePlaces(markdown: string, opts: MarkdownOptions = {}): Map<number, LinePlace> {
  return parse(markdown, opts).places;
}

function parse(markdown: string, opts: MarkdownOptions): { doc: ReviewDoc; places: Map<number, LinePlace> } {
  const src = markdown.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  let title = opts.title;
  let titled = false; // the title came from a "#" heading, so the source's spacing can be kept exactly
  const sections: Section[] = [{ title: "Introduction", level: 0, lines: [], spans: [] }];
  const cur = () => sections.at(-1)!;
  let block: string[] = [];
  let from = 0; // the source line where the open block starts
  let kind: "para" | "item" | "code" | "" = "";
  const push = (text: string, start: number, end: number) => {
    cur().lines.push(text);
    cur().spans.push([start, end]);
  };
  const KINDS = { para: "paragraph", item: "list", code: "code" } as const;
  const flush = () => {
    if (block.length) {
      push(block.join(JOIN), from, from + block.length - 1);
      if (kind) opts.onBlock?.(KINDS[kind]);
    }
    block = [];
    kind = "";
  };
  const heading = (level: number, text: string) => {
    flush();
    const t = text.trim() || "(untitled)";
    if (level === 1 && title === undefined) {
      title = t;
      titled = true;
      if (!sections[0]!.lines.some((l) => l.trim())) Object.assign(sections[0]!, { lines: [], spans: [] }); // blank lines before the title
    } else sections.push({ title: t, level, lines: [], spans: [] });
  };
  for (let i = 0; i < src.length; i++) {
    const raw = src[i]!;
    if (FENCE.test(raw)) {
      flush();
      const fence = raw.match(FENCE)![1]!;
      const code = [raw],
        start = i;
      while (++i < src.length) {
        code.push(src[i]!);
        if (src[i]!.trim().startsWith(fence)) break;
      }
      push(code.join(JOIN), start, Math.min(i, src.length - 1));
      opts.onBlock?.("code");
      continue;
    }
    if (!raw.trim()) {
      flush();
      push("", i, i);
      continue;
    }
    const atx = raw.match(ATX);
    if (atx) {
      heading(atx[1]!.length, atx[2] ?? "");
      continue;
    }
    if (kind === "para" && SETEXT.test(raw)) {
      const text = block.join(" ");
      block = [];
      heading(raw.trim()[0] === "=" ? 1 : 2, text);
      continue;
    }
    if (kind === "" && BREAK.test(raw)) {
      push(raw, i, i);
      opts.onBlock?.("break");
      continue;
    }
    if (ITEM.test(raw)) {
      flush();
      block = [raw];
      from = i;
      kind = "item";
      continue;
    }
    if (kind === "item" && /^\s{2,}\S/.test(raw)) {
      block.push(raw); // continuation of the list item
      continue;
    }
    if (kind === "" && INDENTED.test(raw)) {
      block = [raw];
      from = i;
      kind = "code";
      continue;
    }
    if (kind === "code" && INDENTED.test(raw)) {
      block.push(raw);
      continue;
    }
    const tableRow = raw.includes("|") && (TABLE_DELIM.test(src[i + 1] ?? "") || TABLE_DELIM.test(raw) || (/\|/.test(cur().lines.at(-1) ?? "") && kind === ""));
    if (QUOTE.test(raw) || tableRow) {
      flush();
      push(raw, i, i);
      opts.onBlock?.(QUOTE.test(raw) ? "quote" : "table");
      continue;
    }
    if (kind !== "para") {
      flush();
      from = i;
    }
    block.push(raw);
    kind = "para";
  }
  flush();
  // Blank lines are kept as "" body lines, including those around headings ("exact" spacing);
  // an introduction with no text (only blank lines after the title) is dropped.
  if (!sections[0]!.lines.some((l) => l.trim())) Object.assign(sections[0]!, { lines: [], spans: [] });
  const used = sections.filter((s, i) => i > 0 || s.lines.length);
  const offset = sections[0]!.lines.length ? 0 : 1;
  const items: Item[] = used.map((s, i) => {
    const choices = QUESTION.test(s.title) ? choicesOf(s.lines) : undefined;
    return {
      id: `S-${i + offset}`,
      type: "section",
      title: s.title,
      level: s.level,
      ...(s.lines.length ? { body: s.lines.join("\n") } : {}),
      ...(choices ? { choices } : {}),
    };
  });
  // A source line's place counts only non-blank body lines, as `itemLines` does.
  const places = new Map<number, LinePlace>();
  used.forEach((sec, index) => {
    let line = 0;
    sec.lines.forEach((text, j) => {
      if (!text.trim()) return;
      const [start, end] = sec.spans[j]!;
      for (let n = start; n <= end; n++) places.set(n + 1, { index, line });
      line++;
    });
  });
  const firstPara = used.flatMap((s) => s.lines).find((l) => l && !ITEM.test(l) && !FENCE.test(l) && !QUOTE.test(l) && !l.includes("|") && !BREAK.test(l));
  const docTitle = title ?? "Untitled document";
  const auto = opts.tldr === undefined;
  const summary = (firstPara ?? "")
    .split(JOIN)
    .map((l) => l.trim())
    .join(" ");
  const doc: ReviewDoc = {
    schema: "hoop/review@0",
    kind: "doc",
    channel: opts.channel ?? "local",
    slug: opts.slug ?? slugify(docTitle, { max: 60, fallback: "document" }),
    title: docTitle,
    tldr: opts.tldr ?? (summary.length > 280 ? `${summary.slice(0, 279)}…` : summary || docTitle),
    ...(auto ? { tldr_auto: true } : {}),
    ...(titled ? { spacing: "exact" as const } : {}),
    items: items.length ? items : [{ id: "S-1", type: "section", title: docTitle, level: 0 }],
    ...(opts.review_id ? { review_id: opts.review_id } : {}),
  };
  return { doc, places };
}

/**
 * The document as markdown without hoop's item IDs (FR-17). Documents parsed with a title heading
 * (`spacing: "exact"`) export each line's source text and every blank line as they were. Others,
 * including documents stored before that rule, get one blank line around headings. Structured reviews
 * (requirements, plans) export their items as `##` sections with options and checks.
 */
export function exportMarkdown(doc: ReviewDoc): string {
  const out = [`# ${doc.title}`];
  if (doc.spacing === "exact" && doc.kind === "doc") {
    // Each section's body carries its own blank lines, before and after the heading.
    doc.items.forEach((item, i) => {
      const level = item.level ?? 2;
      if (i === 0 && level > 0) out.push(""); // no introduction: one blank line after the title
      if (level > 0) out.push(`${"#".repeat(level)} ${item.title}`);
      if (item.body !== undefined) out.push(...item.body.split("\n").map((l) => l.split(JOIN).join("\n")));
      if (item.type === "question" && item.choices?.length) out.push("", ...item.choices.map((c) => `- ${c.label}${c.recommended ? " (recommended)" : ""}`));
      if (item.check) out.push("", `_Check: ${item.check}_`);
    });
    return out.join("\n") + "\n";
  }
  for (const item of doc.items) {
    const level = item.level ?? 2;
    if (level > 0) out.push("", `${"#".repeat(level)} ${item.title}`);
    const body = (item.body ?? "").split("\n");
    if (body.some((l) => l.trim())) out.push("", ...body.map((l) => l.split(JOIN).join("\n")));
    if (item.type === "question" && item.choices?.length) out.push("", ...item.choices.map((c) => `- ${c.label}${c.recommended ? " (recommended)" : ""}`));
    if (item.check) out.push("", `_Check: ${item.check}_`);
  }
  return out.join("\n") + "\n";
}

/**
 * Keeps section IDs stable across revisions of a document, so comments and their scopes stay on the
 * same section: by heading, then by place for a renamed heading (see `matchSections`). New sections
 * get IDs never used before.
 */
export function keepIds(prior: ReviewDoc, next: ReviewDoc): ReviewDoc {
  return matchSections(prior, next).doc;
}

/**
 * Matches a new revision's sections to the previous one's, in two passes. The first keeps an ID by
 * heading. The second gives a section left unmatched the ID of an unmatched old section at the same
 * level, under the same parent, in the same place among its siblings: a renamed heading. `renamed`
 * maps each section matched by place to its old heading.
 */
export function matchSections(prior: ReviewDoc, next: ReviewDoc): { doc: ReviewDoc; renamed: Record<string, string> } {
  const free = new Map<string, string[]>();
  for (const i of prior.items) free.set(i.title, [...(free.get(i.title) ?? []), i.id]);
  const ids: (string | undefined)[] = next.items.map((i) => free.get(i.title)?.shift());
  const used = new Set(ids.filter(Boolean));
  const oldPlaces = places(prior.items.map((i) => ({ id: i.id, level: i.level ?? 0 })));
  const unmatchedOld = new Map(oldPlaces.filter((p) => !used.has(p.id)).map((p) => [`${p.level}|${p.parent ?? ""}|${p.index}`, p.id]));
  const renamed: Record<string, string> = {};
  if (unmatchedOld.size) {
    // In order, so a parent renamed just before its sections already carries its old ID.
    const placer = placeTracker();
    next.items.forEach((i, k) => {
      const level = i.level ?? 0;
      const at = placer.peek(level);
      const key = `${level}|${at.parent ?? ""}|${at.index}`;
      const old = ids[k] ? undefined : unmatchedOld.get(key);
      if (old) {
        ids[k] = old;
        unmatchedOld.delete(key);
        renamed[old] = prior.items.find((p) => p.id === old)!.title;
      }
      placer.add(ids[k] ?? `?${k}`, level);
    });
  }
  const num = (id: string) => Number(id.match(/^S-(\d+)$/)?.[1] ?? -1);
  let max = Math.max(...prior.items.map((i) => num(i.id)));
  const items = next.items.map((i, k) => ({ ...i, id: ids[k] ?? `S-${++max}` }));
  return { doc: { ...next, items }, renamed };
}

/** Each section's level, its parent's ID (the nearest earlier section with a lower level), and its index among its parent's sections. */
function places(items: { id: string; level: number }[]): { id: string; level: number; parent?: string; index: number }[] {
  const placer = placeTracker();
  return items.map((i) => ({ ...i, ...placer.add(i.id, i.level) }));
}

/** Walks sections in order and says where each one sits. */
function placeTracker() {
  const stack: { id: string; level: number }[] = [];
  const counts = new Map<string, number>();
  const peek = (level: number) => {
    const open = stack.filter((s) => s.level < level);
    const parent = level > 0 ? open.at(-1)?.id : undefined;
    return { parent, index: counts.get(parent ?? "") ?? 0 };
  };
  const add = (id: string, level: number) => {
    const at = peek(level);
    while (stack.length && stack.at(-1)!.level >= level) stack.pop();
    counts.set(at.parent ?? "", at.index + 1);
    if (level > 0) stack.push({ id, level });
    return at;
  };
  return { peek, add };
}
