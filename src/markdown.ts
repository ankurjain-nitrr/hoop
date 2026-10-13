import type { Item, ReviewDoc } from "./contract.js";

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LISTISH = /^\s*([-*+]|\d+[.)]|>|\|)\s?/; // list items, quotes and table rows stay one line each
const FENCE = /^\s*(```|~~~)/;

export type MarkdownOptions = { title?: string; tldr?: string; slug?: string; channel?: "local" | "github"; review_id?: string };

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document";

/**
 * Turns any markdown document into a review document (FR-16): the first `#` heading is the title,
 * every other heading starts a section, and each paragraph, list item, quote line, table row or code
 * line is one commentable line. Text before the first section is an untitled introduction.
 * Paragraphs that wrap over several source lines become one line.
 */
export function parseMarkdown(markdown: string, opts: MarkdownOptions = {}): ReviewDoc {
  const src = markdown.replace(/\r\n?/g, "\n").split("\n");
  let title = opts.title;
  const sections: { title: string; level: number; lines: string[] }[] = [{ title: "Introduction", level: 0, lines: [] }];
  let para: string[] = [];
  let fenced = false;
  const flush = () => {
    if (para.length) sections.at(-1)!.lines.push(para.join(" "));
    para = [];
  };
  for (const raw of src) {
    if (FENCE.test(raw)) {
      flush();
      fenced = !fenced;
      sections.at(-1)!.lines.push(raw);
      continue;
    }
    if (fenced) {
      if (raw.trim()) sections.at(-1)!.lines.push(raw);
      continue;
    }
    const h = raw.match(HEADING);
    if (h) {
      flush();
      if (h[1]!.length === 1 && title === undefined) title = h[2]!;
      else sections.push({ title: h[2]!, level: h[1]!.length, lines: [] });
      continue;
    }
    if (!raw.trim()) flush();
    else if (LISTISH.test(raw)) {
      flush();
      sections.at(-1)!.lines.push(raw.trimEnd());
    } else para.push(raw.trim());
  }
  flush();
  const used = sections.filter((s, i) => i > 0 || s.lines.length);
  const items: Item[] = used.map((s, i) => ({
    id: `S-${sections[0]!.lines.length ? i : i + 1}`,
    type: "section",
    title: s.title,
    level: s.level,
    ...(s.lines.length ? { body: s.lines.join("\n") } : {}),
  }));
  const firstPara = used.flatMap((s) => s.lines).find((l) => !LISTISH.test(l) && !FENCE.test(l)) ?? "";
  const docTitle = title ?? "Untitled document";
  const tldr = opts.tldr ?? (firstPara.length > 280 ? `${firstPara.slice(0, 279)}…` : firstPara || docTitle);
  return {
    schema: "hoop/review@0",
    kind: "doc",
    channel: opts.channel ?? "local",
    slug: opts.slug ?? slugify(docTitle),
    title: docTitle,
    tldr,
    items: items.length ? items : [{ id: "S-1", type: "section", title: docTitle, level: 0 }],
    ...(opts.review_id ? { review_id: opts.review_id } : {}),
  };
}

/**
 * The document as clean markdown, without hoop's item IDs (FR-17). Sections keep their heading
 * level; list, quote, table and code lines stay together, and paragraphs are separated by a blank line.
 * Structured reviews (requirements, plans) export their items as sections with checks and options.
 */
export function exportMarkdown(doc: ReviewDoc): string {
  const out = [`# ${doc.title}`];
  for (const item of doc.items) {
    const level = item.level ?? 2;
    if (level > 0) out.push("", `${"#".repeat(level)} ${item.title}`);
    const lines = (item.body ?? "").split("\n").filter((l) => l.trim());
    let prevBlock = false;
    let fenced = false;
    for (const l of lines) {
      const block = fenced || LISTISH.test(l) || FENCE.test(l);
      if (!(block && prevBlock)) out.push("");
      out.push(l);
      if (FENCE.test(l)) fenced = !fenced;
      prevBlock = block;
    }
    if (item.choices?.length) {
      out.push("");
      for (const c of item.choices) out.push(`- ${c.label}${c.recommended ? " (recommended)" : ""}`);
    }
    if (item.check) out.push("", `_Check: ${item.check}_`);
  }
  return out.join("\n") + "\n";
}
