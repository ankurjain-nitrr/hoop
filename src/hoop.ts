import { mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { validateFeedback, validateReview, type Feedback, type FieldError, type ReviewDoc } from "./contract.js";
import { Store, type ReviewMeta } from "./store.js";
import { renderMarkdown } from "./render.js";

export const PORT = Number(process.env.HOOP_PORT ?? 4747);
export const reviewUrl = (id: string) => `http://localhost:${PORT}/r/${id}`;

export class HoopError extends Error {
  constructor(message: string, readonly errors: FieldError[] = []) {
    super(message);
  }
}

export type SubmitResult = { review_id: string; revision: number; url: string; status: ReviewMeta["status"]; supersedes?: string };

export type FeedbackResult =
  | { status: "pending"; review_id: string; revision: number; url: string }
  | { status: "reviewed"; review_id: string; revision: number; url: string; approved: boolean; feedback: Feedback[]; decision_files?: string[] };

/** The operations behind the MCP tools and the CLI, independent of transport. */
export class Hoop {
  constructor(readonly store = new Store()) {}

  submit(input: unknown): SubmitResult {
    const v = validateReview(input);
    if (!v.ok) throw new HoopError("invalid review document", v.errors);
    const doc: ReviewDoc = v.value;
    const prior = doc.review_id ? this.existing(doc.review_id) : undefined;
    const repo_dir = process.env.HOOP_REPO_DIR ?? process.cwd();
    // An approved review is frozen: a later submit starts a new review that supersedes it (FR-7).
    const meta = prior && prior.status !== "approved"
      ? this.store.addRevision(prior.id, doc)
      : this.store.create(doc, { repo_dir, ...(prior ? { supersedes: prior.id } : {}) });
    return { review_id: meta.id, revision: meta.revisions, url: reviewUrl(meta.id), status: meta.status, ...(meta.supersedes ? { supersedes: meta.supersedes } : {}) };
  }

  /** Feedback on the latest revision; "pending" until someone submits a review. */
  feedback(reviewId: string): FeedbackResult {
    const meta = this.existing(reviewId);
    const base = { review_id: meta.id, revision: meta.revisions, url: reviewUrl(meta.id) };
    const feedback = this.store.feedback(meta.id);
    if (!feedback.length) return { status: "pending", ...base };
    return { status: "reviewed", ...base, approved: meta.status === "approved", feedback, ...(meta.decision_files ? { decision_files: meta.decision_files } : {}) };
  }

  /** A reviewer's submitted review on the latest revision, from the review page. */
  review(reviewId: string, input: Record<string, unknown>): Feedback {
    const meta = this.existing(reviewId);
    if (meta.status === "approved") throw new HoopError(`review ${meta.id} is approved and frozen`);
    const fb = {
      comments: [], answers: [], resolved_threads: [], viewed: [], ...input,
      schema: "hoop/feedback@0", review_id: meta.id, revision: meta.revisions,
      reviewer: typeof input.reviewer === "string" && input.reviewer ? input.reviewer : userInfo().username,
      at: new Date().toISOString(), source: { channel: "local" },
    };
    // Replies to an existing thread keep the thread's original anchor, which a later revision may
    // have changed, so only new comments are checked against the current revision's lines.
    const known = new Set(this.store.allFeedback(meta.id).flatMap((f) => f.comments.map((c) => c.thread)));
    const comments = Array.isArray(fb.comments) ? (fb.comments as { thread?: string }[]) : [];
    const v = validateFeedback({ ...fb, comments: comments.filter((c) => !c.thread || !known.has(c.thread)) }, this.store.revision(meta.id));
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
    writeFileSync(files[1]!, renderMarkdown(doc, doc.revision ?? meta.revisions).markdown);
    this.store.update(reviewId, { decision_files: files });
    return files;
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
