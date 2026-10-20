import { z } from "zod";
import { blockKinds, type Block } from "../web/blocks.js";

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/, "use letters, digits and hyphens, starting with a letter");

export const Choice = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  recommended: z.boolean().optional(),
});

export const Item = z.object({
  id,
  type: z.enum(["requirement", "slice", "step", "question", "option", "note", "section"]),
  title: z.string().min(1),
  body: z.string().optional(),
  check: z.string().optional(),
  choices: z.array(Choice).optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
  depends_on: z.array(z.string()).optional(),
  /** Markdown heading level for documents (0: no heading, as for an introduction). */
  level: z.number().int().min(0).max(6).optional(),
});

export const ReviewDoc = z.object({
  schema: z.literal("hoop/review@0"),
  review_id: z.string().nullable().optional(),
  revision: z.number().int().min(1).optional(),
  kind: z.enum(["requirements", "slice_map", "plan", "questions", "decision", "doc"]),
  channel: z.enum(["local", "github"]).default("local"),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lowercase letters, digits and hyphens"),
  title: z.string().min(1),
  tldr: z.string().min(1).max(600),
  context: z.object({ repo: z.string().optional(), branch: z.string().optional(), links: z.array(z.string()).optional() }).optional(),
  items: z.array(Item).min(1),
  asks: z.enum(["approve_all", "per_item", "choose"]).optional(),
  /** True when the TL;DR was copied from the first paragraph: edit that paragraph, not the TL;DR. */
  tldr_auto: z.boolean().optional(),
  /** "exact": blank lines around headings are kept in section bodies and exported as they are. */
  spacing: z.literal("exact").optional(),
});

export const Range = z
  .object({ start: z.number().int().min(0), end: z.number().int().min(1), quote: z.string().min(1) })
  .refine((r) => r.end > r.start, { message: "end must be greater than start", path: ["end"] });

export const Comment = z
  .object({
    thread: z.string().optional(),
    item: z.string().min(1),
    line: z.number().int().min(0),
    range: Range.optional(),
    body: z.string().optional(),
    suggestion: z.string().optional(),
  })
  .refine((c) => Boolean(c.body?.trim() || c.suggestion !== undefined), {
    message: "a comment needs a body or a suggestion",
    path: ["body"],
  });

export const Feedback = z.object({
  schema: z.literal("hoop/feedback@0"),
  review_id: z.string().min(1),
  revision: z.number().int().min(1),
  verdict: z.enum(["comment", "approved", "changes_requested"]),
  summary: z.string().optional(),
  comments: z.array(Comment).default([]),
  answers: z.array(z.object({ item: z.string().min(1), choice: z.string().min(1) })).default([]),
  resolved_threads: z.array(z.string()).default([]),
  viewed: z.array(z.string()).default([]),
  reviewer: z.string().min(1),
  at: z.string().min(1),
  /** The person's GitHub login, when the verdict came with their sign-in in the browser. */
  signed_in: z.object({ login: z.string().min(1) }).optional(),
  /** A verdict made with the sign-in turned off in the person's own settings. */
  unverified: z.boolean().optional(),
  /** An approve sent without a sign-in: stored as a comment, so it never freezes the review. */
  agent_approval: z.boolean().optional(),
  /** A request for changes sent without a sign-in, stored as a comment. */
  changes_requested_by_agent: z.boolean().optional(),
  source: z
    .object({
      channel: z.enum(["local", "github"]),
      pr: z.number().int().optional(),
      review_id: z.number().int().optional(),
      comment_ids: z.array(z.number().int()).optional(),
    })
    .optional(),
});

export type ReviewDoc = z.infer<typeof ReviewDoc>;
export type Item = z.infer<typeof Item>;
export type Feedback = z.infer<typeof Feedback>;
export type Comment = z.infer<typeof Comment>;

export type FieldError = { path: string; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

function issues(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message }));
}

/**
 * Comment anchors: `{item, line}` with line n >= 1 is an item line; line 0 is the item's heading and
 * covers its section; item `DOC` line 1 is the title and line 2 the TL;DR, and they cover the
 * whole document.
 */
export const DOC = "DOC";

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

/** The text at an anchor, or undefined if the anchor doesn't exist in doc. */
export function anchorText(doc: ReviewDoc, item: string, line: number): string | undefined {
  if (item === DOC) return line === 1 ? doc.title : line === 2 ? doc.tldr : undefined;
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
 * Each of `itemLines(item)`'s lines' kind and indent, in the same order (D-5). Body lines get their
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
  const seen = new Set<string>();
  doc.items.forEach((item, i) => {
    if (item.id === DOC) errors.push({ path: `items.${i}.id`, message: `${DOC} is reserved for comments on the title and TL;DR` });
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
  if (!doc) return { ok: true, value: fb };
  const errors: FieldError[] = [];
  const byId = new Map(doc.items.map((i) => [i.id, i]));
  fb.comments.forEach((c, i) => {
    if (c.item !== DOC && !byId.has(c.item)) return errors.push({ path: `comments.${i}.item`, message: `unknown item ${c.item}` });
    const text = anchorText(doc, c.item, c.line);
    if (text === undefined) {
      const n = c.item === DOC ? 2 : itemLines(byId.get(c.item)!).length;
      return errors.push({ path: `comments.${i}.line`, message: `${c.item} has lines ${c.item === DOC ? "1-2" : `0-${n}`}` });
    }
    if (c.range && text.slice(c.range.start, c.range.end) !== c.range.quote)
      errors.push({ path: `comments.${i}.range.quote`, message: "quote does not match the text at start..end" });
  });
  fb.answers.forEach((a, i) => {
    const item = byId.get(a.item);
    if (!item?.choices?.some((c) => c.id === a.choice)) errors.push({ path: `answers.${i}`, message: `${a.item} has no choice ${a.choice}` });
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: fb };
}
