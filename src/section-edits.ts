// A revision written as edits to sections of the latest one, instead of the whole document again.
// The edits apply in order to a copy of the document, all of them or none: any edit hoop can't apply
// refuses the whole list. Sections are named by ID, so repeated headings are no problem, and every
// section an edit doesn't touch keeps its exact text and its ID.
import { type Item, type ReviewDoc, removalProblem, withoutSection } from "./contract.js";
import { exportMarkdown, JOIN, parseMarkdown } from "./markdown.js";
import { HoopError } from "./util.js";

export const SECTION_OPS = ["replace_section", "insert_section", "delete_section", "replace_text"] as const;

/**
 * One edit. `replace_section` sets a section's text under its heading (`markdown`) and may rename it
 * (`title`); `insert_section` adds a section after `section` and the sections nested in it;
 * `delete_section` removes a section with the sections nested in it; `replace_text` replaces `find`,
 * which must occur exactly once in the section's text, with `replace`.
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

/** The edited document, with each section's ID set, and the sections renamed, by ID, with their old headings. */
export type Edited = { doc: ReviewDoc; renamed: Record<string, string> };

const blank = (l: string) => !l.trim();
const linesOf = (item: Item) => (item.body === undefined ? [] : item.body.split("\n"));
/** A section's text as markdown: its body lines with each block's source lines apart again. */
const sourceOf = (lines: string[]) => lines.map((l) => l.split(JOIN).join("\n")).join("\n");

/** `text` as a section's body lines without blank lines around them, or the refusal when it holds a heading. */
function bodyLines(text: string): string[] {
  const doc = parseMarkdown(`# x\n\n## x\n\n${text}`);
  if (doc.items.length !== 1) throw new HoopError("the text has a heading in it; add a section with insert_section instead");
  const lines = linesOf(doc.items[0]!);
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return [];
  return lines.slice(first, lines.length - [...lines].reverse().findIndex((l) => !blank(l)));
}

/** A body of `core` lines with the blank lines `old` had around its text, or one blank line on each side (none after the document's last line). */
function framed(old: string[], core: string[], last: boolean): string | undefined {
  const first = old.findIndex((l) => !blank(l));
  const end = old.length - [...old].reverse().findIndex((l) => !blank(l));
  const lead = first < 0 ? [""] : old.slice(0, first);
  const trail = first < 0 ? (last ? [] : [""]) : old.slice(end);
  if (!core.length) return last ? undefined : "";
  return [...lead, ...core, ...trail].join("\n");
}

const withBody = (item: Item, body: string | undefined): Item => {
  const { body: _, ...rest } = item;
  return body === undefined ? rest : { ...rest, body };
};

/**
 * Applies `edits` in order to `doc`, a markdown document, and returns the new revision. After each
 * edit the document must read back the same from its markdown: the same sections with the same
 * text, so an edit can't add a heading, open a code block that swallows the next section, or
 * change the title. New sections get IDs no section of `doc` has.
 */
export function applySectionEdits(doc: ReviewDoc, edits: SectionEdit[]): Edited {
  if (doc.kind !== "doc" || doc.spacing !== "exact")
    throw new HoopError("section edits need a markdown document; send the whole document as markdown with hoop_submit");
  if (!edits.length) throw new HoopError("no edits", [{ path: "edits", message: "at least one edit" }]);
  const num = (id: string) => Number(id.match(/^S-(\d+)$/)?.[1] ?? -1);
  let max = Math.max(...doc.items.map((i) => num(i.id)));
  let items = doc.items.map((i) => ({ ...i }));
  const renamed: Record<string, string> = {};
  edits.forEach((e, k) => {
    const where = `edit ${k + 1} (${e.op} ${e.section})`;
    const fail = (why: string): never => {
      throw new HoopError(`hoop applied none of the edits: ${where}: ${why}`, [{ path: `edits.${k}`, message: why }]);
    };
    const at = items.findIndex((i) => i.id === e.section);
    if (at < 0) fail(`the document has no section ${e.section}; hoop_export lists its sections`);
    const item = items[at]!;
    const last = (i: number) => i === items.length - 1;
    const lines = (text: string | undefined, what: string) => {
      if (text === undefined) fail(`${what} is required`);
      try {
        return bodyLines(text!);
      } catch (err) {
        return fail((err as Error).message);
      }
    };
    const heading = (t: string | undefined) => {
      const title = t?.trim();
      if (!title || /[\n\r\u2028]/.test(title)) fail("title must be one line of text");
      return title!;
    };
    if (e.op === "replace_section") {
      let next = withBody(item, framed(linesOf(item), lines(e.markdown, "markdown"), last(at)));
      if (e.title !== undefined) {
        if (!item.level) fail("the introduction has no heading to rename");
        const title = heading(e.title);
        if (title !== item.title) {
          renamed[item.id] ??= item.title;
          next = { ...next, title };
        }
      }
      items[at] = next;
    } else if (e.op === "replace_text") {
      if (!e.find) fail("find is required");
      if (e.replace === undefined) fail("replace is required");
      const text = sourceOf(linesOf(item));
      const count = text.split(e.find!).length - 1;
      if (count !== 1) fail(count ? `find occurs ${count} times in the section; make it longer so it occurs once` : "find doesn't occur in the section's text");
      items[at] = withBody(
        item,
        framed(
          linesOf(item),
          lines(
            text.replace(e.find!, () => e.replace!),
            "replace",
          ),
          last(at),
        ),
      );
    } else if (e.op === "insert_section") {
      const title = heading(e.title);
      const level = e.level ?? (item.level || 2);
      if (!Number.isInteger(level) || level < 1 || level > 6) fail("level must be 1 to 6");
      let to = at + 1;
      while (to < items.length && (items[to]!.level ?? 0) > level) to++;
      // The heading needs a blank line before it, in the section it follows.
      const before = items[to - 1]!;
      if (linesOf(before).at(-1) !== "") items[to - 1] = withBody(before, [...linesOf(before), ""].join("\n"));
      const added: Item = { id: `S-${++max}`, type: "section", title, level };
      items.splice(to, 0, withBody(added, framed([], lines(e.markdown ?? "", "markdown"), to === items.length)));
    } else if (e.op === "delete_section") {
      const why = removalProblem({ ...doc, items }, e.section);
      if (why) fail(why);
      items = withoutSection({ ...doc, items }, e.section);
    } else fail("op must be one of " + SECTION_OPS.join(", "));
    const problem = changesStructure({ ...doc, items });
    if (problem) fail(problem);
  });
  const back = parseMarkdown(exportMarkdown({ ...doc, items }), { slug: doc.slug, ...(doc.tldr_auto ? {} : { tldr: doc.tldr }) });
  return { doc: { ...back, items: back.items.map((i, k) => ({ ...i, id: items[k]!.id })) }, renamed };
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
  return `it changes the document's structure at section ${at.id} "${at.title}" (a heading, or a code block or list left open); send the whole document as markdown with hoop_submit to restructure it`;
}
