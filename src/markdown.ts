import type { Item, ReviewDoc } from "./contract.js";

/** Joins the source lines of one block (a wrapped paragraph, a code fence, a list item) into one line. */
export const JOIN = " ";

const ATX = /^\s{0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const SETEXT = /^\s{0,3}(=+|-+)\s*$/;
const BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s/;
const QUOTE = /^\s{0,3}>/;
const TABLE_DELIM = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

export type MarkdownOptions = { title?: string; tldr?: string; slug?: string; channel?: "local" | "github"; review_id?: string };

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document";

type Section = { title: string; level: number; lines: string[] };

/**
 * Turns any markdown document into a review document (FR-16). The first `#` heading is the title;
 * every other heading starts a section; text before the first section is an untitled introduction.
 * Each block is one commentable line that keeps its exact source text: a paragraph (wrapped lines
 * joined with U+2028), a list item with its continuation lines, a quote line, a table row, a whole
 * code block, or a thematic break. Blank lines between blocks are kept, so an unedited document
 * exports back byte for byte (setext headings are written back in `#` form).
 */
export function parseMarkdown(markdown: string, opts: MarkdownOptions = {}): ReviewDoc {
  const src = markdown.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  let title = opts.title;
  let titled = false; // the title came from a "#" heading, so the source's spacing can be kept exactly
  const sections: Section[] = [{ title: "Introduction", level: 0, lines: [] }];
  const cur = () => sections.at(-1)!;
  let block: string[] = [];
  let kind: "para" | "item" | "code" | "" = "";
  const flush = () => {
    if (block.length) cur().lines.push(block.join(JOIN));
    block = [];
    kind = "";
  };
  const heading = (level: number, text: string) => {
    flush();
    const t = text.trim() || "(untitled)";
    if (level === 1 && title === undefined) {
      title = t;
      titled = true;
      if (!sections[0]!.lines.some((l) => l.trim())) sections[0]!.lines = []; // blank lines before the title
    }
    else sections.push({ title: t, level, lines: [] });
  };
  for (let i = 0; i < src.length; i++) {
    const raw = src[i]!;
    if (FENCE.test(raw)) {
      flush();
      const fence = raw.match(FENCE)![1]!;
      const code = [raw];
      while (++i < src.length) {
        code.push(src[i]!);
        if (src[i]!.trim().startsWith(fence)) break;
      }
      cur().lines.push(code.join(JOIN));
      continue;
    }
    if (!raw.trim()) {
      flush();
      cur().lines.push("");
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
      cur().lines.push(raw);
      continue;
    }
    if (ITEM.test(raw)) {
      flush();
      block = [raw];
      kind = "item";
      continue;
    }
    if (kind === "item" && /^\s{2,}\S/.test(raw)) {
      block.push(raw); // continuation of the list item
      continue;
    }
    if (kind === "" && /^( {4}|\t)/.test(raw)) {
      block = [raw];
      kind = "code";
      continue;
    }
    if (kind === "code" && /^( {4}|\t)/.test(raw)) {
      block.push(raw);
      continue;
    }
    const tableRow = raw.includes("|") && (TABLE_DELIM.test(src[i + 1] ?? "") || TABLE_DELIM.test(raw) || /\|/.test(cur().lines.at(-1) ?? "") && kind === "");
    if (QUOTE.test(raw) || tableRow) {
      flush();
      cur().lines.push(raw);
      continue;
    }
    if (kind !== "para") flush();
    block.push(raw);
    kind = "para";
  }
  flush();
  // Blank lines are kept as "" body lines, including those around headings ("exact" spacing);
  // an introduction with no text (only blank lines after the title) is dropped.
  if (!sections[0]!.lines.some((l) => l.trim())) sections[0]!.lines = [];
  const used = sections.filter((s, i) => i > 0 || s.lines.length);
  const offset = sections[0]!.lines.length ? 0 : 1;
  const items: Item[] = used.map((s, i) => ({
    id: `S-${i + offset}`, type: "section", title: s.title, level: s.level,
    ...(s.lines.length ? { body: s.lines.join("\n") } : {}),
  }));
  const firstPara = used.flatMap((s) => s.lines).find((l) => l && !ITEM.test(l) && !FENCE.test(l) && !QUOTE.test(l) && !l.includes("|") && !BREAK.test(l));
  const docTitle = title ?? "Untitled document";
  const auto = opts.tldr === undefined;
  const summary = (firstPara ?? "").split(JOIN).map((l) => l.trim()).join(" ");
  return {
    schema: "hoop/review@0", kind: "doc", channel: opts.channel ?? "local",
    slug: opts.slug ?? slugify(docTitle), title: docTitle,
    tldr: opts.tldr ?? (summary.length > 280 ? `${summary.slice(0, 279)}…` : summary || docTitle),
    ...(auto ? { tldr_auto: true } : {}),
    ...(titled ? { spacing: "exact" as const } : {}),
    items: items.length ? items : [{ id: "S-1", type: "section", title: docTitle, level: 0 }],
    ...(opts.review_id ? { review_id: opts.review_id } : {}),
  };
}

/**
 * The document as markdown without hoop's item IDs (FR-17). Documents parsed with a title heading
 * (`spacing: "exact"`) export each line's source text and every blank line as they were. Others,
 * including documents stored before CR-2, get one blank line around headings. Structured reviews
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
      if (item.choices?.length) out.push("", ...item.choices.map((c) => `- ${c.label}${c.recommended ? " (recommended)" : ""}`));
      if (item.check) out.push("", `_Check: ${item.check}_`);
    });
    return out.join("\n") + "\n";
  }
  for (const item of doc.items) {
    const level = item.level ?? 2;
    if (level > 0) out.push("", `${"#".repeat(level)} ${item.title}`);
    const body = (item.body ?? "").split("\n");
    if (body.some((l) => l.trim())) out.push("", ...body.map((l) => l.split(JOIN).join("\n")));
    if (item.choices?.length) out.push("", ...item.choices.map((c) => `- ${c.label}${c.recommended ? " (recommended)" : ""}`));
    if (item.check) out.push("", `_Check: ${item.check}_`);
  }
  return out.join("\n") + "\n";
}

/**
 * Keeps section IDs stable across revisions of a document: a section whose heading matches one in
 * the previous revision keeps its ID, so comments and their scopes stay on the same section; new
 * sections get IDs never used before.
 */
export function keepIds(prior: ReviewDoc, next: ReviewDoc): ReviewDoc {
  const free = new Map<string, string[]>();
  for (const i of prior.items) free.set(i.title, [...(free.get(i.title) ?? []), i.id]);
  const num = (id: string) => Number(id.match(/^S-(\d+)$/)?.[1] ?? -1);
  let max = Math.max(...prior.items.map((i) => num(i.id)));
  const items = next.items.map((i) => ({ ...i, id: free.get(i.title)?.shift() ?? `S-${++max}` }));
  return { ...next, items };
}
