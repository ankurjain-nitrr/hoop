import { subtitleLine, type Choice, type Item, type ReviewDoc } from "./contract.js";
import { clip, slugify } from "./util.js";
import { BREAK, FENCE, INDENTED, ITEM, JOIN, QUOTE, subtitleWords, TABLE_DELIM, type BlockKind } from "../web/blocks.js";

/** Joins the source lines of one block (a wrapped paragraph, a code fence, a list item) into one line. */
export { JOIN };

const ATX = /^\s{0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const SETEXT = /^\s{0,3}(=+|-+)\s*$/;
/** At most this many characters of a document's first paragraph make its TL;DR when none is given. */
export const TLDR_MAX = 280;
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
  review_id?: string;
  /** Called with the kind of each body line as the parser decides it; tests compare it with `blockKinds`. */
  onBlock?: (kind: BlockKind) => void;
};

/** A section's body lines. */
type Section = { title: string; level: number; lines: string[] };

const KINDS = { para: "paragraph", item: "list", code: "code" } as const;

/** `parseMarkdown`'s pass over the source lines: the sections so far, and the block it is gathering. */
class Scanner {
  title: string | undefined;
  titled = false; // the title came from a "#" heading, so the source's spacing can be kept exactly
  titledFirst = false; // and that heading came before any other
  readonly sections: Section[] = [{ title: "Introduction", level: 0, lines: [] }];
  block: string[] = [];
  kind: "para" | "item" | "code" | "" = "";

  constructor(
    readonly src: string[],
    readonly opts: MarkdownOptions,
  ) {
    this.title = opts.title;
  }

  cur() {
    return this.sections.at(-1)!;
  }

  push(text: string) {
    this.cur().lines.push(text);
  }

  flush() {
    if (this.block.length) {
      this.push(this.block.join(JOIN));
      if (this.kind) this.opts.onBlock?.(KINDS[this.kind]);
    }
    this.block = [];
    this.kind = "";
  }

  heading(level: number, text: string) {
    this.flush();
    const t = text.trim() || "(untitled)";
    if (level !== 1 || this.title !== undefined) {
      this.sections.push({ title: t, level, lines: [] });
      return;
    }
    const intro = this.sections[0]!;
    this.title = t;
    this.titled = true;
    if (!intro.lines.some((l) => l.trim())) Object.assign(intro, { lines: [] }); // blank lines before the title
    this.titledFirst = this.sections.length === 1 && !intro.lines.length;
  }

  /** Starts a new block of `kind` with this line. */
  start(raw: string, kind: "item" | "code") {
    this.block = [raw];
    this.kind = kind;
  }

  /** Takes the line at `i`; returns the index of the last line it took (a code fence takes several). */
  line(i: number): number {
    const raw = this.src[i]!;
    if (FENCE.test(raw)) return this.fence(i);
    if (!raw.trim()) {
      this.flush();
      this.push("");
    } else if (!this.headingLine(raw) && !this.blockLine(raw, i)) this.paragraphLine(raw);
    return i;
  }

  /** A fenced code block, through its closing fence or the end. */
  fence(i: number): number {
    const src = this.src;
    this.flush();
    const fence = src[i]!.match(FENCE)![1]!;
    const code = [src[i]!];
    while (++i < src.length) {
      code.push(src[i]!);
      if (src[i]!.trim().startsWith(fence)) break;
    }
    this.push(code.join(JOIN));
    this.opts.onBlock?.("code");
    return i;
  }

  /** An ATX heading, or a setext underline that makes the paragraph above it a heading. */
  headingLine(raw: string): boolean {
    const atx = raw.match(ATX);
    if (atx) {
      this.heading(atx[1]!.length, atx[2] ?? "");
      return true;
    }
    if (this.kind !== "para" || !SETEXT.test(raw)) return false;
    const text = this.block.join(" ");
    this.block = [];
    this.heading(raw.trim()[0] === "=" ? 1 : 2, text);
    return true;
  }

  /** A thematic break, list item, indented code, quote line or table row. */
  blockLine(raw: string, i: number): boolean {
    const kind = this.kind;
    if (kind === "" && BREAK.test(raw)) {
      this.push(raw);
      this.opts.onBlock?.("break");
    } else if (ITEM.test(raw)) {
      this.flush();
      this.start(raw, "item");
    } else if ((kind === "item" && /^\s{2,}\S/.test(raw)) || (kind === "code" && INDENTED.test(raw))) {
      this.block.push(raw); // continuation of the list item or the indented code
    } else if (kind === "" && INDENTED.test(raw)) {
      this.start(raw, "code");
    } else if (QUOTE.test(raw) || this.tableRow(raw, i)) {
      this.flush();
      this.push(raw);
      this.opts.onBlock?.(QUOTE.test(raw) ? "quote" : "table");
    } else return false;
    return true;
  }

  tableRow(raw: string, i: number): boolean {
    return (
      raw.includes("|") && (TABLE_DELIM.test(this.src[i + 1] ?? "") || TABLE_DELIM.test(raw) || (/\|/.test(this.cur().lines.at(-1) ?? "") && this.kind === ""))
    );
  }

  paragraphLine(raw: string) {
    if (this.kind !== "para") this.flush();
    this.block.push(raw);
    this.kind = "para";
  }
}

/**
 * A subtitle is a short line of emphasis right after the title (`subtitleWords`), after one blank
 * line and before a blank line or the end; the blank line before it goes with it, and it is
 * exported back the same way.
 */
function takeSubtitle(scan: Scanner): { text: string; mark: string | undefined } | undefined {
  const intro = scan.sections[0]!.lines;
  const sub = scan.titledFirst && intro[1] !== undefined ? subtitleWords(intro[1]) : undefined;
  const apart = intro[2] === "" || (intro.length === 2 && scan.sections.length === 1);
  if (!sub || intro[0] !== "" || !apart) return undefined;
  const subtitle = { text: sub, mark: intro[1]![0] };
  intro.splice(0, 2);
  return subtitle;
}

/** The document's sections as items, numbered from S-1 when there is no introduction. */
function sectionItems(used: Section[], offset: number): Item[] {
  return used.map((s, i) => {
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
}

/** The first paragraph's text on one line, for a TL;DR when none is given. */
function firstParagraph(used: Section[]): string {
  const firstPara = used.flatMap((s) => s.lines).find((l) => l && !ITEM.test(l) && !FENCE.test(l) && !QUOTE.test(l) && !l.includes("|") && !BREAK.test(l));
  return (firstPara ?? "")
    .split(JOIN)
    .map((l) => l.trim())
    .join(" ");
}

/**
 * Turns any markdown document into a review document. The first `#` heading is the title;
 * every other heading starts a section; text before the first section is an untitled introduction.
 * Each block is one commentable line that keeps its exact source text: a paragraph (wrapped lines
 * joined with U+2028), a list item with its continuation lines, a quote line, a table row, a whole
 * code block, or a thematic break. Blank lines between blocks are kept, so an unedited document
 * exports back byte for byte (setext headings are written back in `#` form).
 */
export function parseMarkdown(markdown: string, opts: MarkdownOptions = {}): ReviewDoc {
  const src = markdown.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const scan = new Scanner(src, opts);
  for (let i = 0; i < src.length; i++) i = scan.line(i);
  scan.flush();
  const { sections, title, titled } = scan;
  const subtitle = takeSubtitle(scan);
  // Blank lines are kept as "" body lines, including those around headings ("exact" spacing);
  // an introduction with no text (only blank lines after the title) is dropped.
  if (!sections[0]!.lines.some((l) => l.trim())) Object.assign(sections[0]!, { lines: [] });
  const used = sections.filter((s, i) => i > 0 || s.lines.length);
  const items = sectionItems(used, sections[0]!.lines.length ? 0 : 1);
  const docTitle = title ?? "Untitled document";
  const auto = opts.tldr === undefined;
  const summary = firstParagraph(used);
  const doc: ReviewDoc = {
    schema: "hoop/review@0",
    kind: "doc",
    slug: opts.slug ?? slugify(docTitle, { max: 60, fallback: "document" }),
    title: docTitle,
    ...(subtitle ? { subtitle: subtitle.text, ...(subtitle.mark === "_" ? { subtitle_mark: "_" as const } : {}) } : {}),
    tldr: opts.tldr ?? (clip(summary, TLDR_MAX) || docTitle),
    ...(auto ? { tldr_auto: true } : {}),
    ...(titled ? { spacing: "exact" as const } : {}),
    items: items.length ? items : [{ id: "S-1", type: "section", title: docTitle, level: 0 }],
    ...(opts.review_id ? { review_id: opts.review_id } : {}),
  };
  return doc;
}

/**
 * The document as markdown without hoop's item IDs. Documents parsed with a title heading
 * (`spacing: "exact"`) export each line's source text and every blank line as they were. Others,
 * including documents stored before that rule, get one blank line around headings. Structured reviews
 * (requirements, plans) export their items as `##` sections with options and checks.
 */
export function exportMarkdown(doc: ReviewDoc): string {
  const out = [`# ${doc.title}`];
  if (doc.subtitle !== undefined) out.push("", subtitleLine(doc)!);
  if (doc.spacing === "exact" && doc.kind === "doc") {
    // Each section's body carries its own blank lines, before and after the heading.
    doc.items.forEach((item, i) => {
      const level = item.level ?? 2;
      if (i === 0 && level > 0) out.push(""); // no introduction: one blank line after the title
      if (level > 0) out.push(`${"#".repeat(level)} ${item.title}`);
      if (item.body !== undefined) out.push(...item.body.split("\n").map((l) => l.split(JOIN).join("\n")));
      out.push(...itemEnd(item));
    });
    return out.join("\n") + "\n";
  }
  for (const item of doc.items) {
    const level = item.level ?? 2;
    if (level > 0) out.push("", `${"#".repeat(level)} ${item.title}`);
    const body = (item.body ?? "").split("\n");
    if (body.some((l) => l.trim())) out.push("", ...body.map((l) => l.split(JOIN).join("\n")));
    out.push(...itemEnd(item));
  }
  return out.join("\n") + "\n";
}

/** The lines that end an item's export: a question's options, then its check. */
function itemEnd(item: Item): string[] {
  const out: string[] = [];
  if (item.type === "question" && item.choices?.length) out.push("", ...item.choices.map((c) => `- ${c.label}${c.recommended ? " (recommended)" : ""}`));
  if (item.check) out.push("", `_Check: ${item.check}_`);
  return out;
}

/** The highest section number (`S-<n>`) in `docs`, or -1: a new section's ID goes above every one a revision used. */
export function highestSection(docs: ReviewDoc[]): number {
  return Math.max(-1, ...docs.flatMap((d) => d.items.map((i) => Number(i.id.match(/^S-(\d+)$/)?.[1] ?? -1))));
}

/**
 * Keeps section IDs stable across revisions of a document, so comments and their scopes stay on the
 * same section: by heading, then by place for a renamed heading (see `matchSections`). New sections
 * get IDs above `prior`'s and above `floor`; pass the highest one any revision used
 * (`highestSection`), or a deleted section's ID comes back with its old comments.
 */
export function keepIds(prior: ReviewDoc, next: ReviewDoc, floor = -1): ReviewDoc {
  return matchSections(prior, next, floor).doc;
}

/**
 * Matches a new revision's sections to the previous one's, in two passes. The first keeps an ID by
 * heading. The second gives a section left unmatched the ID of an unmatched old section at the same
 * level, under the same parent, in the same place among its siblings: a renamed heading. `renamed`
 * maps each section matched by place to its old heading. A structured document's items have no
 * places to match (a decision document revised into markdown), so only headings carry IDs from it.
 * New sections get IDs above `prior`'s and above `floor` (see `keepIds`).
 */
export function matchSections(prior: ReviewDoc, next: ReviewDoc, floor = -1): { doc: ReviewDoc; renamed: Record<string, string> } {
  const free = new Map<string, string[]>();
  for (const i of prior.items) free.set(i.title, [...(free.get(i.title) ?? []), i.id]);
  const ids: (string | undefined)[] = next.items.map((i) => free.get(i.title)?.shift());
  const used = new Set(ids.filter(Boolean));
  const oldPlaces = places(prior.items.map((i) => ({ id: i.id, level: i.level ?? 0 })));
  const unmatchedOld = new Map(oldPlaces.filter((p) => !used.has(p.id)).map((p) => [`${p.level}|${p.parent ?? ""}|${p.index}`, p.id]));
  const renamed: Record<string, string> = {};
  if (unmatchedOld.size && prior.kind === "doc") {
    // In order, so a parent renamed just before its sections already carries its old ID.
    const placer = sectionPlacer();
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
  let max = Math.max(floor, highestSection([prior]));
  const items = next.items.map((i, k) => ({ ...i, id: ids[k] ?? `S-${++max}` }));
  return { doc: { ...next, items }, renamed };
}

/** Each section's level, its parent's ID (the nearest earlier section with a lower level), and its index among its parent's sections. */
function places(items: { id: string; level: number }[]): { id: string; level: number; parent?: string; index: number }[] {
  const placer = sectionPlacer();
  return items.map((i) => ({ ...i, ...placer.add(i.id, i.level) }));
}

/** Walks sections in order and says where each one sits. */
function sectionPlacer() {
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
