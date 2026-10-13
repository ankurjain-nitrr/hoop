import { mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { validateFeedback, validateReview, type Feedback, type FieldError, type ReviewDoc } from "./contract.js";
import { Store, type ReviewMeta } from "./store.js";
import { renderMarkdown } from "./render.js";
import { exportMarkdown } from "./markdown.js";
import { GitHub } from "./github.js";
import { anchorText, inScope, scopeOf } from "./contract.js";
import { applyEdit, EditError, locate, narrow, wordStats, type WordStats } from "./edit.js";
import type { Applied, Proposal } from "./store.js";

export const PORT = Number(process.env.HOOP_PORT ?? 4747);
export const reviewUrl = (id: string) => `http://localhost:${PORT}/r/${id}`;

export class HoopError extends Error {
  constructor(message: string, readonly errors: FieldError[] = []) {
    super(message);
  }
}

export type SubmitResult = { review_id: string; revision: number; url: string; status: ReviewMeta["status"]; supersedes?: string };

export type FeedbackResult =
  | { status: "pending"; review_id: string; revision: number; url: string; answers?: Answer[]; applied?: Applied[]; edits?: Proposal[] }
  | {
      status: "reviewed"; review_id: string; revision: number; url: string; approved: boolean; feedback: Feedback[];
      /** GitHub: the PR was closed without merging, so the decision was rejected. */
      closed?: boolean;
      decision_files?: string[];
      /** GitHub: answers ticked in the PR description. */
      answers?: Answer[];
      /** Comments materialized into the document, with the revision each produced. */
      applied?: Applied[];
      /** Edits Claude proposed, with the reviewer's decision on each. */
      edits?: Proposal[];
    };

type Answer = { item: string; choice: string };

/** The operations behind the MCP tools and the CLI, independent of transport. */
export class Hoop {
  constructor(readonly store = new Store(), readonly github = new GitHub()) {}

  /** Submit over either channel. GitHub reviews also open or update their decision PR. */
  async submitAny(input: unknown): Promise<SubmitResult> {
    const v = validateReview(input);
    if (!v.ok) throw new HoopError("invalid review document", v.errors);
    if (v.value.channel !== "github") return this.submit(v.value);
    const doc = v.value;
    const prior = doc.review_id ? this.existing(doc.review_id) : undefined;
    if (prior && prior.status !== "approved") {
      if (!prior.github) throw new HoopError(`review ${prior.id} is local; submit revisions on the local channel`);
      // Push to the PR first, so a failed push leaves the store unchanged.
      const github = await this.github.revise(prior.github, { ...doc, review_id: prior.id }, prior.revisions + 1);
      const meta = this.store.addRevision(prior.id, doc);
      this.store.update(meta.id, { github });
      return { review_id: meta.id, revision: meta.revisions, url: prior.github.url, status: meta.status };
    }
    const repo_dir = process.env.HOOP_REPO_DIR ?? process.cwd();
    const github = await this.github.open(repo_dir, doc);
    const meta = this.store.create(doc, { repo_dir, github, ...(prior ? { supersedes: prior.id } : {}) });
    return { review_id: meta.id, revision: 1, url: github.url, status: meta.status, ...(prior ? { supersedes: prior.id } : {}) };
  }

  submit(input: unknown): SubmitResult {
    const v = validateReview(input);
    if (!v.ok) throw new HoopError("invalid review document", v.errors);
    const doc: ReviewDoc = v.value;
    const prior = doc.review_id ? this.existing(doc.review_id) : undefined;
    if (prior?.github && prior.status === "open")
      throw new HoopError(`review ${prior.id} is on GitHub; submit its revisions with channel "github"`);
    const repo_dir = process.env.HOOP_REPO_DIR ?? process.cwd();
    // An approved review is frozen: a later submit starts a new review that supersedes it (FR-7).
    const meta = prior && prior.status !== "approved"
      ? this.store.addRevision(prior.id, doc)
      : this.store.create(doc, { repo_dir, ...(prior ? { supersedes: prior.id } : {}) });
    return { review_id: meta.id, revision: meta.revisions, url: reviewUrl(meta.id), status: meta.status, ...(meta.supersedes ? { supersedes: meta.supersedes } : {}) };
  }

  /** Re-reads a GitHub review's PR into the store; merged means approved (FR-15). No-op for local reviews. */
  async refresh(reviewId: string): Promise<void> {
    const meta = this.existing(reviewId);
    if (!meta.github || meta.status !== "open") return;
    const revisions = Array.from({ length: meta.revisions }, (_, i) => this.store.revision(meta.id, i + 1));
    const state = await this.github.sync(meta.github, meta.id, revisions);
    this.store.setFeedback(meta.id, state.feedback);
    this.store.update(meta.id, { pr_answers: state.answers });
    if (state.closed) this.store.update(meta.id, { status: "closed" });
    if (state.merged) {
      const slug = revisions.at(-1)!.slug;
      this.store.update(meta.id, { status: "approved", decision_files: [`decisions/${slug}.json`, `decisions/${slug}.md`] });
    }
  }

  async feedbackAny(reviewId: string): Promise<FeedbackResult> {
    await this.refresh(reviewId);
    const result = this.feedback(reviewId);
    const meta = this.store.meta(reviewId);
    return meta.github ? { ...result, url: meta.github.url, answers: meta.pr_answers ?? [] } : result;
  }

  async replyAny(thread: string, body: string) {
    const gh = thread.match(/^gh_(\d+)$/);
    if (!gh) return this.reply(thread, body);
    const id = this.store.findThread(thread);
    const ref = id ? this.store.meta(id).github : undefined;
    if (!id || !ref) throw new HoopError(`no thread ${thread}`);
    const posted = await this.github.reply(ref, Number(gh[1]), body);
    this.store.update(id, { github: { ...ref, own_comments: [...(ref.own_comments ?? []), posted] } });
    return this.reply(thread, body);
  }

  /** Feedback on the latest revision; "pending" until someone submits a review. */
  feedback(reviewId: string): FeedbackResult {
    const meta = this.existing(reviewId);
    const base = { review_id: meta.id, revision: meta.revisions, url: reviewUrl(meta.id) };
    const feedback = this.store.feedback(meta.id);
    const applied = this.store.applied(meta.id);
    const proposals = this.store.proposals(meta.id);
    const extra = { ...(applied.length ? { applied } : {}), ...(proposals.length ? { edits: proposals } : {}) };
    if (!feedback.length && meta.status === "open") return { status: "pending", ...base, ...extra };
    return {
      status: "reviewed", ...base, approved: meta.status === "approved", feedback,
      ...extra,
      ...(meta.status === "closed" ? { closed: true } : {}),
      ...(meta.decision_files ? { decision_files: meta.decision_files } : {}),
    };
  }

  /** A reviewer's submitted review on the latest revision, from the review page. */
  review(reviewId: string, input: Record<string, unknown>): Feedback {
    const meta = this.existing(reviewId);
    if (meta.status === "approved") throw new HoopError(`review ${meta.id} is approved and frozen`);
    if (meta.github) throw new HoopError(`review ${meta.id} is reviewed on GitHub: ${meta.github.url}`);
    const known = new Set(this.store.allFeedback(meta.id).flatMap((f) => f.comments.map((c) => c.thread)));
    // A thread id the review doesn't have is dropped, so the store assigns a fresh one.
    const comments = (Array.isArray(input.comments) ? (input.comments as { thread?: string }[]) : []).map((c) =>
      c.thread && !known.has(c.thread) ? { ...c, thread: undefined } : c);
    const fb: Record<string, unknown> = {
      answers: [], resolved_threads: [], viewed: [], ...input, comments,
      schema: "hoop/feedback@0", review_id: meta.id, revision: meta.revisions,
      reviewer: typeof input.reviewer === "string" && input.reviewer ? input.reviewer : userInfo().username,
      at: new Date().toISOString(), source: { channel: "local" },
    };
    // Replies keep their thread's original anchor, which a later revision may have changed, so only
    // new comments are checked against the current revision's lines.
    const v = validateFeedback({ ...fb, comments: comments.filter((c) => !c.thread) }, this.store.revision(meta.id));
    if (!v.ok) throw new HoopError("invalid feedback", v.errors);
    const all = validateFeedback(fb);
    if (!all.ok) throw new HoopError("invalid feedback", all.errors);
    const stored = this.store.addFeedback(meta.id, all.value);
    if (stored.verdict === "approved") {
      this.store.update(meta.id, { status: "approved" });
      this.writeDecision(meta.id, stored);
    }
    return stored;
  }

  /** Writes the approved revision to <repo>/decisions/<slug>.{json,md} for Claude to commit (FR-10). */
  writeDecision(reviewId: string, approval: Feedback): string[] {
    const meta = this.store.meta(reviewId);
    if (!meta.repo_dir) return [];
    const doc = this.store.revision(reviewId);
    const dir = join(meta.repo_dir, "decisions");
    mkdirSync(dir, { recursive: true });
    const decision = { ...doc, approved: { by: approval.reviewer, at: approval.at, summary: approval.summary, supersedes: meta.supersedes } };
    const files = [join(dir, `${doc.slug}.json`), join(dir, `${doc.slug}.md`)];
    writeFileSync(files[0]!, JSON.stringify(decision, null, 2) + "\n");
    // Documents are written back as clean markdown; structured reviews keep the line-numbered view.
    writeFileSync(files[1]!, doc.kind === "doc" ? exportMarkdown(doc) : renderMarkdown(doc, doc.revision ?? meta.revisions).markdown);
    this.store.update(reviewId, { decision_files: files });
    return files;
  }

  /**
   * Applies a reviewer's exact suggestion (FR-18): replaces just the suggested span in a new
   * revision and marks the thread applied. Everything else in the document is unchanged (FR-22).
   */
  applySuggestion(reviewId: string, thread: string, by = userInfo().username): { revision: number; applied: Applied; words: WordStats } {
    const meta = this.existing(reviewId);
    if (meta.status !== "open") throw new HoopError(`review ${meta.id} is ${meta.status}`);
    if (meta.github) throw new HoopError(`review ${meta.id} is reviewed on GitHub; use Commit suggestion there`);
    if (this.store.applied(meta.id).some((a) => a.thread === thread)) throw new HoopError(`thread ${thread} is already applied`);
    const entry = this.store.allFeedback(meta.id).flatMap((f) => f.comments.map((c) => ({ c, rev: f.revision })))
      .filter(({ c }) => c.thread === thread && c.suggestion !== undefined).at(-1);
    if (!entry) throw new HoopError(`thread ${thread} has no suggestion to apply`);
    const root = this.store.allFeedback(meta.id).flatMap((f) => f.comments).find((x) => x.thread === thread)!;
    const { rev } = entry;
    // The thread's root anchor is authoritative; a reply's own item and line are client-supplied.
    const c = { ...entry.c, item: root.item, line: root.line, range: entry.c === root ? root.range : entry.c.range };
    const doc = this.store.revision(meta.id);
    const now = anchorText(doc, c.item, c.line);
    const then = anchorText(this.store.revision(meta.id, rev), c.item, c.line);
    if (now === undefined || now !== then) throw new HoopError("the text this suggestion was made on has changed; suggest again on the current text");
    const edit = c.range
      ? { item: c.item, line: c.line, start: c.range.start, find: c.range.quote, replace: c.suggestion! }
      : { item: c.item, line: c.line, ...narrow(now, c.suggestion!) };
    if (!edit.find || edit.find === edit.replace) throw new HoopError("the suggestion matches the current text");
    let next: ReviewDoc, located: { start: number; end: number };
    try {
      ({ doc: next, located } = applyEdit(doc, edit));
    } catch (err) {
      if (err instanceof EditError) throw new HoopError(err.message, [{ path: err.field, message: err.message }]);
      throw err;
    }
    const after = this.store.addRevision(meta.id, next);
    this.rebaseProposals(meta.id, c.item, c.line, located, edit.replace, anchorText(next, c.item, c.line)!);
    const applied: Applied = { thread, revision: after.revisions, by, at: new Date().toISOString(), kind: "suggestion", item: c.item, line: c.line, find: edit.find, replace: edit.replace };
    this.store.addApplied(meta.id, applied);
    return { revision: after.revisions, applied, words: wordStats(edit.find, edit.replace, now) };
  }

  /**
   * Claude's edits for an instruction comment (FR-20): span replacements on the latest revision,
   * each inside the thread's scope (a line, a section for heading comments, the document for title
   * and TL;DR comments) and each with a `find` that occurs exactly once in its line. All or nothing.
   */
  proposeEdits(reviewId: string, thread: string, edits: unknown, note?: string): { proposals: Proposal[] } {
    const meta = this.existing(reviewId);
    if (meta.status !== "open") throw new HoopError(`review ${meta.id} is ${meta.status}`);
    if (meta.github) throw new HoopError(`review ${meta.id} is reviewed on GitHub; push a revision instead`);
    const rooted = this.store.allFeedback(meta.id).flatMap((f) => f.comments.map((c) => ({ c, rev: f.revision }))).find(({ c }) => c.thread === thread);
    if (!rooted) throw new HoopError(`no thread ${thread} in review ${meta.id}`);
    const root = rooted.c;
    if (this.store.applied(meta.id).some((a) => a.thread === thread)) throw new HoopError(`thread ${thread} is already applied`);
    const latest = this.store.revision(meta.id);
    // The comment must still point at what the reviewer saw: the same line text, or the same section.
    if (root.item !== "DOC" && !latest.items.some((i) => i.id === root.item))
      throw new HoopError(`the section this comment is on (${root.item}) no longer exists; reply on the thread instead`);
    if (root.line > 0 && root.item !== "DOC" && anchorText(latest, root.item, root.line) !== anchorText(this.store.revision(meta.id, rooted.rev), root.item, root.line))
      throw new HoopError("the text this comment is on has changed since; reply on the thread instead");
    if (!Array.isArray(edits) || !edits.length) throw new HoopError("edits must be a non-empty array", [{ path: "edits", message: "expected at least one edit" }]);
    const scope = scopeOf(root);
    const doc = this.store.revision(meta.id);
    const errors: FieldError[] = [];
    const located: { i: number; item: string; line: number; find: string; replace: string; start: number; end: number }[] = [];
    edits.forEach((raw, i) => {
      const e = raw as Record<string, unknown>;
      const at = (f: string, message: string) => errors.push({ path: `edits.${i}.${f}`, message });
      if (typeof e?.item !== "string") return at("item", "expected an item id");
      if (!Number.isInteger(e.line) || (e.line as number) < 0) return at("line", "expected a line number (0 for the heading)");
      if (typeof e.find !== "string" || !e.find) return at("find", "expected the exact text to replace");
      if (typeof e.replace !== "string") return at("replace", "expected the replacement text");
      if (e.find === e.replace) return at("replace", "replace is the same as find");
      const edit = { item: e.item, line: e.line as number, find: e.find, replace: e.replace };
      if (!inScope(scope, edit))
        return at("item", scope.kind === "line"
          ? `this comment is on ${scope.item} line ${scope.line}; edits must stay on that line`
          : `this comment covers section ${(scope as { item: string }).item}; edits must stay in it`);
      try {
        const { located: l } = applyEdit(doc, edit);
        located.push({ i, ...edit, start: l.start, end: l.end });
      } catch (err) {
        if (err instanceof EditError) return at(err.field, err.message);
        throw err;
      }
    });
    located.forEach((a, k) => located.slice(k + 1).forEach((b) => {
      if (a.item === b.item && a.line === b.line && a.start < b.end && b.start < a.end)
        errors.push({ path: `edits.${b.i}.find`, message: `overlaps edit ${a.i} on the same text` });
    }));
    if (errors.length) throw new HoopError("invalid edits", errors);
    const existing = this.store.proposals(meta.id);
    const now = new Date().toISOString();
    const proposals: Proposal[] = located.map((l, k) => ({
      id: `ed_${meta.id.slice(3)}_${existing.length + k + 1}`, thread, revision: meta.revisions,
      item: l.item, line: l.line, find: l.find, replace: l.replace, start: l.start, ...(note ? { note } : {}), at: now,
      line_text: anchorText(doc, l.item, l.line)!,
      words: wordStats(l.find, l.replace, anchorText(doc, l.item, l.line)!), status: "proposed",
    }));
    this.store.writeProposals(meta.id, [...existing, ...proposals]);
    return { proposals };
  }

  /** Where a proposed edit sits in the latest revision, or null if its text has changed (stale). */
  editPosition(reviewId: string, p: Proposal): { start: number; end: number } | null {
    const now = anchorText(this.store.revision(reviewId), p.item, p.line);
    if (now === undefined || now !== p.line_text || now.slice(p.start, p.start + p.find.length) !== p.find) return null;
    return { start: p.start, end: p.start + p.find.length };
  }

  /**
   * After a span on a line is applied through hoop, other undecided edits on that line follow it:
   * edits before or after the span keep (or shift) their position; overlapping ones go stale.
   */
  private rebaseProposals(reviewId: string, item: string, line: number, applied: { start: number; end: number }, replace: string, newText: string) {
    const list = this.store.proposals(reviewId);
    const delta = replace.length - (applied.end - applied.start);
    let changed = false;
    for (const p of list) {
      if (p.status !== "proposed" || p.item !== item || p.line !== line) continue;
      const end = p.start + p.find.length;
      if (end <= applied.start) Object.assign(p, { line_text: newText });
      else if (p.start >= applied.end) Object.assign(p, { line_text: newText, start: p.start + delta });
      else continue; // overlaps: its text is gone, so it stays stale
      changed = true;
    }
    if (changed) this.store.writeProposals(reviewId, list);
  }

  /**
   * The reviewer's decision on a proposed edit (FR-21). Accepting applies just that span to the
   * latest revision as a new revision and marks the thread applied; rejecting records it.
   */
  decideEdit(reviewId: string, editId: string, action: "accept" | "reject", by = userInfo().username): { proposal: Proposal; revision: number } {
    const meta = this.existing(reviewId);
    if (meta.status !== "open") throw new HoopError(`review ${meta.id} is ${meta.status}`);
    const list = this.store.proposals(meta.id);
    const p = list.find((x) => x.id === editId);
    if (!p) throw new HoopError(`no edit ${editId}`);
    if (p.status !== "proposed") throw new HoopError(`edit ${editId} is already ${p.status}`);
    const decided = { decided_by: by, decided_at: new Date().toISOString() };
    if (action === "reject") {
      Object.assign(p, { status: "rejected" }, decided);
      this.store.writeProposals(meta.id, list);
      return { proposal: p, revision: meta.revisions };
    }
    const pos = this.editPosition(meta.id, p);
    if (!pos) throw new HoopError(`the text edit ${editId} changes has changed since; ask Claude to propose it again`);
    const { doc } = applyEdit(this.store.revision(meta.id), { item: p.item, line: p.line, find: p.find, replace: p.replace, start: pos.start });
    const after = this.store.addRevision(meta.id, doc);
    Object.assign(p, { status: "accepted", applied_revision: after.revisions }, decided);
    this.store.writeProposals(meta.id, list);
    this.rebaseProposals(meta.id, p.item, p.line, pos, p.replace, anchorText(doc, p.item, p.line)!);
    this.store.addApplied(meta.id, { thread: p.thread, revision: after.revisions, by, at: decided.decided_at, kind: "edit", item: p.item, line: p.line, find: p.find, replace: p.replace, edit_id: p.id });
    return { proposal: p, revision: after.revisions };
  }

  /** The agent's reply in a comment thread. */
  reply(thread: string, body: string, author = "claude") {
    if (!body.trim()) throw new HoopError("a reply needs text");
    const id = this.store.findThread(thread);
    if (!id) throw new HoopError(`no thread ${thread}`);
    const reply = { thread, author, body, at: new Date().toISOString() };
    this.store.addReply(id, reply);
    return { review_id: id, ...reply };
  }

  private existing(id: string): ReviewMeta {
    try {
      return this.store.meta(id);
    } catch {
      throw new HoopError(`no review ${id}`);
    }
  }
}
