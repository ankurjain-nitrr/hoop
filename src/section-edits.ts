// A revision written as edits to sections of the latest one, instead of the whole document again.
// The edits apply in order to a copy of the document, all of them or none: any edit hoop can't apply
// refuses the whole list. Sections are named by ID, so repeated headings are no problem, and every
// section an edit doesn't touch keeps its exact text and its ID.
import { FENCE } from "../web/blocks.js";
import { type Item, type ReviewDoc, removalProblem, sectionItems, withoutSection } from "./contract.js";
import { exportMarkdown, highestSection, JOIN, parseMarkdown } from "./markdown.js";
import { HoopError } from "./util.js";

export const SECTION_OPS = ["replace_section", "insert_section", "delete_section", "replace_text"] as const;

/**
 * One edit. `replace_section` sets a section's text under its heading (`markdown`), renames it
 * (`title`), or both; `insert_section` adds a section after `section` and the sections nested in it
 * (and after the sections earlier edits inserted there); `delete_section` removes a section with the
 * sections nested in it; `replace_text` replaces `find`, which must occur exactly once in the
 * section's text, with `replace`.
 */
export type SectionEdit = {
  op: (typeof SECTION_OPS)[number];
  section: string;
  markdown?: string;
  title?: string;
  level?: number;
  find?: string;
  replace?: string;
};

/** The fields each edit takes besides `op` and `section`. */
const FIELDS: Record<SectionEdit["op"], (keyof SectionEdit)[]> = {
  replace_section: ["markdown", "title"],
  insert_section: ["title", "level", "markdown"],
  delete_section: [],
  replace_text: ["find", "replace"],
};

/** The edited document, with each section's ID set, and the sections renamed, by ID, with their old headings. */
export type Edited = { doc: ReviewDoc; renamed: Record<string, string> };

const blank = (l: string) => !l.trim();
const linesOf = (item: Item) => (item.body === undefined ? [] : item.body.split("\n"));
/** A section's text as markdown: its body lines with each block's source lines apart again. */
const sourceOf = (lines: string[]) => lines.map((l) => l.split(JOIN).join("\n")).join("\n");

/** `text` as a section's body lines without blank lines around them, or the refusal when it holds a heading or an unclosed code block. */
function bodyLines(text: string): string[] {
  const doc = parseMarkdown(`# x\n\n## x\n\n${text}`);
  if (doc.items.length !== 1) throw new HoopError("the text has a heading in it; add a section with insert_section instead");
  const lines = linesOf(doc.items[0]!);
  for (const l of lines) {
    const parts = l.split(JOIN);
    const fence = parts[0]!.match(FENCE)?.[1];
    if (fence && (parts.length < 2 || !parts.at(-1)!.trim().startsWith(fence))) throw new HoopError(`the text has a code block with no closing ${fence} line`);
  }
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return [];
  return lines.slice(first, lines.length - [...lines].reverse().findIndex((l) => !blank(l)));
}

/** A body of `core` lines with the blank lines `old` had around its text, or one blank line on each side (none after the document's last line). */
function framed(old: string[], core: string[], last: boolean): string | undefined {
  if (!core.length) return last ? undefined : "";
  const first = old.findIndex((l) => !blank(l));
  if (first < 0) return ["", ...core, ...(last ? [] : [""])].join("\n");
  const end = old.length - [...old].reverse().findIndex((l) => !blank(l));
  return [...old.slice(0, first), ...core, ...old.slice(end)].join("\n");
}

const withBody = (item: Item, body: string | undefined): Item => {
  const { body: _, ...rest } = item;
  return body === undefined ? rest : { ...rest, body };
};

/** The document as the edits so far left it. */
type EditState = {
  doc: ReviewDoc;
  items: Item[];
  max: number;
  renamed: Record<string, string>;
  /** The last section inserted after each section, so several inserts after one section keep their order. */
  insertedAfter: Map<string, string>;
};

/** One edit as it applies: its section's place and item, and helpers that refuse the whole list. */
type EditAt = {
  e: SectionEdit;
  at: number;
  item: Item;
  fail: (why: string) => never;
  /** `text` as the section's body lines, or the edit's refusal. */
  lines: (text: string) => string[];
  /** A heading's text, or the edit's refusal. */
  heading: (t: string | undefined) => string;
  /** Whether the section at `i` is the document's last. */
  last: (i: number) => boolean;
};

function replaceSection(s: EditState, { e, at, item, fail, lines, heading, last }: EditAt) {
  if (e.markdown === undefined && e.title === undefined) fail("replace_section needs markdown, title or both");
  let next = e.markdown === undefined ? item : withBody(item, framed(linesOf(item), lines(e.markdown), last(at)));
  if (e.title !== undefined) {
    if (!item.level) fail("the introduction has no heading to rename");
    const title = heading(e.title);
    if (title !== item.title) {
      s.renamed[item.id] ??= item.title;
      next = { ...next, title };
    }
  }
  s.items[at] = next;
}

function replaceText(s: EditState, { e, at, item, fail, lines, last }: EditAt) {
  if (!e.find) fail("find is required");
  if (e.replace === undefined) fail("replace is required");
  const text = sourceOf(linesOf(item));
  const count = text.split(e.find!).length - 1;
  if (count !== 1) fail(count ? `find occurs ${count} times in the section; make it longer so it occurs once` : "find doesn't occur in the section's text");
  s.items[at] = withBody(item, framed(linesOf(item), lines(text.replace(e.find!, () => e.replace!)), last(at)));
}

function insertSection(s: EditState, { e, item, fail, lines, heading }: EditAt) {
  const items = s.items;
  const title = heading(e.title);
  const level = e.level ?? (item.level || 2);
  if (!Number.isInteger(level) || level < 1 || level > 6) fail("level must be 1 to 6");
  // After the section and everything nested in it, and after what earlier edits inserted there.
  const prev = s.insertedAfter.get(item.id);
  const after = prev && items.some((i) => i.id === prev) ? prev : item.id;
  const nested = sectionItems({ ...s.doc, items }, after);
  const to = items.findIndex((i) => i.id === nested.at(-1)) + 1;
  // The heading needs a blank line before it, in the section it follows.
  const before = items[to - 1]!;
  if (linesOf(before).at(-1) !== "") items[to - 1] = withBody(before, [...linesOf(before), ""].join("\n"));
  const added: Item = { id: `S-${++s.max}`, type: "section", title, level };
  items.splice(to, 0, withBody(added, framed([], lines(e.markdown ?? ""), to === items.length)));
  s.insertedAfter.set(item.id, added.id);
}

function deleteSection(s: EditState, { e, fail }: EditAt) {
  const why = removalProblem({ ...s.doc, items: s.items }, e.section);
  if (why) fail(why);
  s.items = withoutSection({ ...s.doc, items: s.items }, e.section);
}

/** How each op applies; any other is delete_section. */
const APPLY = new Map<string, (s: EditState, at: EditAt) => void>([
  ["replace_section", replaceSection],
  ["replace_text", replaceText],
  ["insert_section", insertSection],
]);

/** Edit `k` as it applies to the document as it stands, after checking its op, fields and section. */
function editAt(s: EditState, e: SectionEdit, k: number): EditAt {
  const where = `edit ${k + 1} (${e.op} ${e.section})`;
  const fail = (why: string): never => {
    throw new HoopError(`hoop applied none of the edits: ${where}: ${why}`, [{ path: `edits.${k}`, message: why }]);
  };
  if (!(e.op in FIELDS)) fail(`op must be one of ${SECTION_OPS.join(", ")}`);
  const extra = (["markdown", "title", "level", "find", "replace"] as const).filter((f) => e[f] !== undefined && !FIELDS[e.op].includes(f));
  if (extra.length) fail(`${e.op} doesn't take ${extra.join(" or ")}`);
  const at = s.items.findIndex((i) => i.id === e.section);
  if (at < 0) fail(`the document has no section ${e.section}; the submit result and hoop_export list its sections`);
  const item = s.items[at]!;
  const lines = (text: string) => {
    try {
      const core = bodyLines(text);
      if (!core.length && !item.level && e.op !== "insert_section") fail("the introduction can't be empty");
      return core;
    } catch (err) {
      if (err instanceof HoopError && err.message.startsWith("hoop applied none")) throw err;
      return fail((err as Error).message);
    }
  };
  // A heading's closing #s aren't part of it, as markdown reads it.
  const heading = (t: string | undefined) => {
    const title = t
      ?.trim()
      .replace(/(^|\s)#+$/, "")
      .trim();
    if (!title || /[\n\r\u2028]/.test(title)) fail("title must be one line of text");
    return title!;
  };
  return { e, at, item, fail, lines, heading, last: (i) => i === s.items.length - 1 };
}

/**
 * Applies `edits` in order to `doc`, a markdown document, and returns the new revision. After each
 * edit the document must read back the same from its markdown: the same sections with the same
 * text, so an edit can't add a heading, open a code block that swallows the next section, or
 * change the title. New sections get IDs above `doc`'s and above `floor`, the highest any revision
 * used (`highestSection`), so none takes a deleted section's ID and its comments.
 */
export function applySectionEdits(doc: ReviewDoc, edits: SectionEdit[], floor = -1): Edited {
  if (doc.kind !== "doc") throw new HoopError("section edits need a markdown document; revise a decision document with hoop_submit");
  if (doc.spacing !== "exact") throw new HoopError("this document has no # title, so hoop can't keep its text byte for byte; revise it with hoop_submit");
  if (!edits.length) throw new HoopError("no edits", [{ path: "edits", message: "at least one edit" }]);
  const s: EditState = { doc, items: doc.items.map((i) => ({ ...i })), max: Math.max(floor, highestSection([doc])), renamed: {}, insertedAfter: new Map() };
  edits.forEach((e, k) => {
    const at = editAt(s, e, k);
    (APPLY.get(e.op) ?? deleteSection)(s, at);
    const problem = changesStructure({ ...doc, items: s.items });
    if (problem) at.fail(problem);
  });
  const items = s.items;
  const back = parseMarkdown(exportMarkdown({ ...doc, items }), { slug: doc.slug, ...(doc.tldr_auto ? {} : { tldr: doc.tldr }) });
  return { doc: { ...back, items: back.items.map((i, k) => ({ ...i, id: items[k]!.id })) }, renamed: s.renamed };
}

/** Why `doc` doesn't read back the same from its markdown, or undefined. */
function changesStructure(doc: ReviewDoc): string | undefined {
  const back = parseMarkdown(exportMarkdown(doc));
  if (back.title !== doc.title || back.subtitle !== doc.subtitle) return "it changes the document's title";
  const k = doc.items.findIndex((i, n) => {
    const b = back.items[n];
    return !b || b.title !== i.title || (b.level ?? 0) !== (i.level ?? 0) || b.body !== i.body;
  });
  if (k < 0 && back.items.length === doc.items.length) return undefined;
  const at = doc.items[k < 0 ? doc.items.length - 1 : k]!;
  return `it changes the document's structure at section ${at.id} "${at.title}"; send the whole document as markdown with hoop_submit to restructure it`;
}
