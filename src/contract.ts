import { z } from "zod";
import { blockKinds, SUBTITLE_MAX, subtitleWords, type Block } from "../web/blocks.js";

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/, "use letters, digits and hyphens, starting with a letter");

// Every field carries its description, which the published JSON Schema files in schemas/ are
// generated from (scripts/schemas.ts).

export const Choice = z.object({
  id: z.string().min(1).describe("The option's letter or short ID, such as a"),
  label: z.string().min(1).describe("The option as the reviewer reads it"),
  recommended: z.boolean().optional().describe("True for the option the agent recommends"),
});

export const Item = z.object({
  id: id.describe("The item's ID, such as FR-3; unique in the document"),
  type: z.enum(["requirement", "slice", "step", "question", "option", "note", "section"]).describe("What the item is"),
  title: z.string().min(1).describe("The item's heading"),
  body: z.string().optional().describe("The item's text; each non-empty line is one line to comment on"),
  check: z.string().optional().describe("How a test or a reviewer checks the item"),
  choices: z.array(Choice).optional().describe("A question's options"),
  risk: z.enum(["low", "medium", "high"]).optional().describe("The agent's estimate of the item's risk"),
  depends_on: z.array(z.string()).optional().describe("IDs of items this one needs first"),
  level: z.number().int().min(0).max(6).optional().describe("A document section's heading level; 0 for text before the first heading"),
});

export const ReviewDoc = z.object({
  schema: z.literal("hoop/review@0").describe("The format and its version"),
  review_id: z.string().nullable().optional().describe("Set to revise an existing review"),
  revision: z.number().int().min(1).optional().describe("Set by hoop: the revision number"),
  kind: z.enum(["requirements", "slice_map", "plan", "questions", "decision", "doc"]).describe("What the document is; doc for any markdown document"),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lowercase letters, digits and hyphens")
    .describe("A short name for the document, such as order-export"),
  title: z.string().min(1).describe("The document's title"),
  subtitle: z
    .string()
    .regex(/^[^\n]+$/, "one line")
    .max(SUBTITLE_MAX)
    .optional()
    .describe(
      "An optional short line under the title, shown in italics: at most 120 characters, not a sentence ending in a period; in markdown, *words* or _words_ on its own line under the # title",
    ),
  subtitle_mark: z.literal("_").optional().describe("Set by hoop: the subtitle was written as _words_ rather than *words*"),
  tldr: z.string().min(1).max(600).describe("One or two sentences for the reviewer"),
  context: z
    .object({ repo: z.string().optional(), branch: z.string().optional(), links: z.array(z.string()).optional() })
    .optional()
    .describe("Where the document comes from: a repository, a branch and links"),
  items: z.array(Item).min(1).describe("The document's items, in order"),
  asks: z.enum(["approve_all", "per_item", "choose"]).optional().describe("What the agent asks the reviewer to do"),
  tldr_auto: z.boolean().optional().describe("True when the TL;DR was copied from the first paragraph: edit that paragraph, not the TL;DR"),
  spacing: z.literal("exact").optional().describe("With exact, blank lines around headings are kept in section bodies and exported as they are"),
});

export const Range = z
  .object({
    start: z.number().int().min(0).describe("The first character, from 0"),
    end: z.number().int().min(1).describe("One past the last character"),
    quote: z.string().min(1).describe("The exact text from start to end"),
  })
  .refine((r) => r.end > r.start, { message: "end must be greater than start", path: ["end"] });

export const Comment = z
  .object({
    thread: z.string().optional().describe("The thread a reply belongs to; leave out for a new comment"),
    item: z.string().min(1).describe("The item's ID, or DOC for the title, TL;DR and subtitle"),
    line: z.number().int().min(0).describe("The line, from 1; 0 is the item's heading, and DOC line 1 is the title, 2 the TL;DR and 3 the subtitle"),
    range: Range.optional().describe("The words the comment is about, inside the line"),
    body: z.string().optional().describe("The comment's text"),
    suggestion: z.string().optional().describe("Replacement text for the range, or for the whole line"),
    remove: z
      .literal(true)
      .optional()
      .describe("On a section's heading (line 0): a suggestion to remove the section, with its subsections and everything under it"),
  })
  .refine((c) => Boolean(c.body?.trim() || c.suggestion !== undefined || c.remove), {
    message: "a comment needs a body or a suggestion",
    path: ["body"],
  })
  .refine((c) => !c.remove || (c.line === 0 && c.item !== DOC && c.suggestion === undefined && !c.range), {
    message: "a removal is suggested on a section's heading (line 0), without a suggestion or a range",
    path: ["remove"],
  });

export const Feedback = z.object({
  schema: z.literal("hoop/feedback@0").describe("The format and its version"),
  review_id: z.string().min(1).describe("The review this feedback is on"),
  revision: z.number().int().min(1).describe("The revision it was given on"),
  verdict: z
    .enum(["comment", "approved", "changes_requested"])
    .describe(
      'The reviewer\'s verdict. A person\'s review is "approved" or "changes_requested", on the review page; "comment" is a session\'s own comment, a quick question\'s answer, or a person\'s review from before hoop offered two verdicts, which asks for changes',
    ),
  summary: z.string().optional().describe("An overall comment, or an approval's notes"),
  comments: z.array(Comment).default([]).describe("Comments and replies"),
  answers: z
    .array(
      z.object({
        item: z.string().min(1),
        choice: z.string().min(1).describe("The chosen option's ID, or \"other\" for the reviewer's own answer"),
        text: z.string().optional().describe('The reviewer\'s own answer, when the choice is "other"'),
        recommended: z
          .boolean()
          .optional()
          .describe(
            "True when the reviewer approved, or pressed Go with your recommendation on a quick question, without picking, and hoop took the agent's recommended option",
          ),
        corrects: z
          .object({ choice: z.string().min(1), text: z.string().optional() })
          .optional()
          .describe("On a quick question: the earlier answer this one replaces, which the agent had already read"),
      }),
    )
    .default([])
    .describe("Answers to questions: each question's ID and the chosen option, or the reviewer's own words"),
  resolved_threads: z.array(z.string()).default([]).describe("Threads this feedback resolves"),
  viewed: z.array(z.string()).default([]).describe("Items the reviewer marked as viewed"),
  reviewer: z.string().min(1).describe("Who gave it, as they named themselves"),
  at: z.string().min(1).describe("When, as an ISO 8601 time"),
  session: z
    .object({ id: z.string().min(1), name: z.string().optional() })
    .optional()
    .describe("The Claude Code session that commented with hoop_comment: its ID and title"),
});

export const AskQuestion = z.object({
  question: z.string().trim().min(1).max(300).describe("The question, in one line"),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(200).describe("The option as the person reads it"),
        recommended: z.boolean().optional().describe("True for the one option you recommend"),
      }),
    )
    .min(2)
    .max(4)
    .describe("Two to four options; exactly one is recommended"),
  context: z.string().trim().max(400).optional().describe("One or two sentences on why it matters"),
});

/** Where a quick question points: a line in an open review, named by its words or by item and line. */
export const AskAnchor = z.object({
  review_id: z.string().min(1).describe("The open review the question is about"),
  words: z.string().optional().describe("Words on the line the question is about, in place of item and line; they must occur once"),
  item: z.string().optional().describe('The item, with line; or with words, to narrow where they occur. "DOC" is the title, TL;DR and subtitle'),
  line: z.number().int().min(0).optional().describe("The line: 0 is an item's heading; DOC line 1 is the title, 2 the TL;DR, 3 the subtitle"),
});

/** A quick question: one to four questions the person answers with one click each, without a document. */
export const Ask = z.object({
  questions: z.array(AskQuestion).min(1).max(4).describe("One to four questions"),
  anchor: AskAnchor.optional().describe("A line in an open review the questions are about; they show beside it on the review's page"),
});

export type ReviewDoc = z.infer<typeof ReviewDoc>;
export type Ask = z.infer<typeof Ask>;
export type AskAnchor = z.infer<typeof AskAnchor>;
export type Item = z.infer<typeof Item>;
export type Choice = z.infer<typeof Choice>;
export type Feedback = z.infer<typeof Feedback>;
export type Comment = z.infer<typeof Comment>;

export type FieldError = { path: string; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

function issues(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message }));
}

/**
 * Comment anchors: `{item, line}` with line n >= 1 is an item line; line 0 is the item's heading and
 * covers its section; item `DOC` line 1 is the title, line 2 the TL;DR and line 3 the subtitle
 * (when there is one), and they cover the whole document. The subtitle comes third, though it shows
 * under the title, so documents without one keep their anchors.
 */
export const DOC = "DOC";

/** The subtitle as its markdown line, `*words*` or `_words_`, or undefined without one. */
export const subtitleLine = (doc: ReviewDoc) => {
  const mark = doc.subtitle_mark ?? "*";
  return doc.subtitle === undefined ? undefined : `${mark}${doc.subtitle}${mark}`;
};

/** The DOC lines a document has, as an error message names them. */
export const docLines = (doc: ReviewDoc) => (doc.subtitle !== undefined ? "1-3" : "1-2");

export type Scope = { kind: "document" } | { kind: "section"; item: string } | { kind: "line"; item: string; line: number };

export function scopeOf(anchor: { item: string; line: number }): Scope {
  if (anchor.item === DOC) return { kind: "document" };
  if (anchor.line === 0) return { kind: "section", item: anchor.item };
  return { kind: "line", item: anchor.item, line: anchor.line };
}

/** What a comment's edits may change, as feedback states it: its line, its section's items, or the whole document. */
export type CommentScope = { kind: "line" } | { kind: "section"; items: string[] } | { kind: "document" };

export function commentScope(doc: ReviewDoc, anchor: { item: string; line: number }): CommentScope {
  const scope = scopeOf(anchor);
  return scope.kind === "section" ? { kind: "section", items: sectionItems(doc, scope.item) } : { kind: scope.kind };
}

/**
 * A section and every section nested in it: the item, then each later item with a deeper heading
 * level, up to the next heading at its level or above. An item without a level is its own section.
 */
export function sectionItems(doc: ReviewDoc, itemId: string): string[] {
  const at = doc.items.findIndex((i) => i.id === itemId);
  if (at < 0) return [itemId];
  const level = doc.items[at]!.level;
  if (!level) return [itemId];
  const ids = [itemId];
  for (const i of doc.items.slice(at + 1)) {
    if (!i.level || i.level <= level) break;
    ids.push(i.id);
  }
  return ids;
}

/** Whether a target anchor lies inside a scope; with the document, a section covers its nested sections. */
export function inScope(scope: Scope, target: { item: string; line: number }, doc?: ReviewDoc): boolean {
  if (scope.kind === "document") return true;
  if (scope.kind === "section") return doc ? sectionItems(doc, scope.item).includes(target.item) : target.item === scope.item;
  return target.item === scope.item && target.line === scope.line;
}

/**
 * Why a section can't be removed, or undefined: only a document's section with a heading can go,
 * and never when nothing would remain: no text before the first heading and no other section. The
 * title and TL;DR are not sections.
 */
export function removalProblem(doc: ReviewDoc, itemId: string): string | undefined {
  const item = doc.items.find((i) => i.id === itemId);
  if (doc.kind !== "doc" || !item?.level) return "only a document's section with a heading can be removed";
  const gone = sectionItems(doc, itemId);
  if (doc.items.every((i) => gone.includes(i.id))) return "the document's last section can't be removed";
  return undefined;
}

/**
 * The document's sections without `itemId` and the sections nested in it. Removing the document's
 * end leaves the section before it last: its trailing blank lines went before the removed heading,
 * so they go too, and the document still ends on text.
 */
export function withoutSection(doc: ReviewDoc, itemId: string): Item[] {
  const gone = sectionItems(doc, itemId);
  const items = doc.items.filter((i) => !gone.includes(i.id));
  if (doc.items.at(-1)!.id === gone.at(-1) && items.length) {
    const last = { ...items.at(-1)! };
    const body = (last.body ?? "").replace(/\n+$/, "");
    if (body.trim()) last.body = body;
    else delete last.body;
    items[items.length - 1] = last;
  }
  return items;
}

/** The text at an anchor, or undefined if the anchor doesn't exist in doc. */
export function anchorText(doc: ReviewDoc, item: string, line: number): string | undefined {
  if (item === DOC) return line === 1 ? doc.title : line === 2 ? doc.tldr : line === 3 ? doc.subtitle : undefined;
  const it = doc.items.find((i) => i.id === item);
  if (!it) return undefined;
  return line === 0 ? it.title : itemLines(it)[line - 1];
}

/** The commentable lines of an item: body lines, choice labels for questions, then the check. */
export function itemLines(item: Item): string[] {
  const lines = (item.body ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (item.type === "question") {
    if (!lines.length) lines.push(item.title);
    for (const c of item.choices ?? []) lines.push(`${c.id}) ${c.label}${c.recommended ? " (recommended)" : ""}`);
  }
  if (item.check) lines.push(`Check: ${item.check}`);
  if (!lines.length) lines.push(item.title);
  return lines;
}

/**
 * Each of `itemLines(item)`'s lines' kind and indent, in the same order. Body lines get their
 * kind from `blockKinds`; question choices, the check and a title shown as a line are paragraphs.
 */
export function itemBlocks(item: Item): Block[] {
  const body = blockKinds((item.body ?? "").split("\n"));
  const n = itemLines(item).length;
  return [...body, ...Array.from({ length: n - body.length }, () => ({ kind: "paragraph" as const, indent: 0 }))];
}

export function validateReview(input: unknown): Result<ReviewDoc> {
  const parsed = ReviewDoc.safeParse(input);
  if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
  const doc = parsed.data;
  const errors: FieldError[] = [];
  // The subtitle exports as one line of emphasis, so it must read back as one.
  if (doc.subtitle !== undefined && subtitleWords(subtitleLine(doc)!) !== doc.subtitle)
    errors.push({
      path: "subtitle",
      message: `a subtitle is at most ${SUBTITLE_MAX} characters, doesn't end with a period, neither starts nor ends with a space, and holds no ${doc.subtitle_mark ?? "*"}`,
    });
  const seen = new Set<string>();
  doc.items.forEach((item, i) => {
    if (item.id === DOC) errors.push({ path: `items.${i}.id`, message: `${DOC} is reserved for comments on the title, TL;DR and subtitle` });
    if (seen.has(item.id)) errors.push({ path: `items.${i}.id`, message: `duplicate item id ${item.id}` });
    seen.add(item.id);
    if (item.type === "question" && !item.choices?.length) errors.push({ path: `items.${i}.choices`, message: "a question needs at least one choice" });
    const choiceIds = new Set<string>();
    item.choices?.forEach((c, j) => {
      if (choiceIds.has(c.id)) errors.push({ path: `items.${i}.choices.${j}.id`, message: `duplicate choice id ${c.id}` });
      choiceIds.add(c.id);
    });
  });
  doc.items.forEach((item, i) =>
    item.depends_on?.forEach((d, j) => {
      if (!seen.has(d)) errors.push({ path: `items.${i}.depends_on.${j}`, message: `unknown item ${d}` });
    }),
  );
  return errors.length ? { ok: false, errors } : { ok: true, value: doc };
}

/** Validates feedback, including that comments and answers point at items, lines and choices that exist. */
export function validateFeedback(input: unknown, doc?: ReviewDoc): Result<Feedback> {
  const parsed = Feedback.safeParse(input);
  if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
  const fb = parsed.data;
  const errors: FieldError[] = [];
  // Only an approval takes the recommended options for the questions it leaves unanswered, or, on a
  // quick question, Go with your recommendation.
  fb.answers.forEach((a, i) => {
    if (a.recommended && fb.verdict !== "approved" && doc?.kind !== "questions")
      errors.push({ path: `answers.${i}.recommended`, message: "only an approval takes a recommended option" });
    if (a.corrects && doc?.kind !== "questions") errors.push({ path: `answers.${i}.corrects`, message: "only a quick question's answer corrects another" });
  });
  if (!doc) return errors.length ? { ok: false, errors } : { ok: true, value: fb };
  const byId = new Map(doc.items.map((i) => [i.id, i]));
  fb.comments.forEach((c, i) => {
    if (c.item !== DOC && !byId.has(c.item)) return errors.push({ path: `comments.${i}.item`, message: `unknown item ${c.item}` });
    const text = anchorText(doc, c.item, c.line);
    if (text === undefined) {
      const n = c.item === DOC ? 2 : itemLines(byId.get(c.item)!).length;
      return errors.push({ path: `comments.${i}.line`, message: `${c.item} has lines ${c.item === DOC ? docLines(doc) : `0-${n}`}` });
    }
    if (c.range && text.slice(c.range.start, c.range.end) !== c.range.quote)
      errors.push({ path: `comments.${i}.range.quote`, message: "quote does not match the text at start..end" });
    const refused = c.remove ? removalProblem(doc, c.item) : undefined;
    if (refused) errors.push({ path: `comments.${i}.remove`, message: refused });
  });
  // Removing a question settles it, so one review doesn't both answer it and remove it.
  const removing = new Set(fb.comments.filter((c) => c.remove && byId.has(c.item)).flatMap((c) => sectionItems(doc, c.item)));
  fb.answers.forEach((a, i) => {
    if (removing.has(a.item))
      errors.push({ path: `answers.${i}`, message: `${a.item} is in a section this review suggests removing: answer it or remove it, not both` });
  });
  fb.answers.forEach((a, i) => {
    const item = byId.get(a.item);
    if (a.choice === "other" && item?.choices?.length) {
      if (!a.text?.trim()) errors.push({ path: `answers.${i}.text`, message: `write the answer, or pick one of ${a.item}'s options` });
    } else if (!item?.choices?.some((c) => c.id === a.choice)) errors.push({ path: `answers.${i}`, message: `${a.item} has no choice ${a.choice}` });
    else if (a.recommended && !item.choices.some((c) => c.id === a.choice && c.recommended))
      errors.push({ path: `answers.${i}.recommended`, message: `${a.choice} isn't ${a.item}'s recommended option` });
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: fb };
}
