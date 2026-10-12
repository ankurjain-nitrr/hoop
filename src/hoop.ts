import { validateReview, type Feedback, type FieldError, type ReviewDoc } from "./contract.js";
import { Store, type ReviewMeta } from "./store.js";

export const PORT = Number(process.env.HOOP_PORT ?? 4747);
export const reviewUrl = (id: string) => `http://localhost:${PORT}/r/${id}`;

export class HoopError extends Error {
  constructor(message: string, readonly errors: FieldError[] = []) {
    super(message);
  }
}

export type SubmitResult = { review_id: string; revision: number; url: string; status: ReviewMeta["status"] };

export type FeedbackResult =
  | { status: "pending"; review_id: string; revision: number; url: string }
  | { status: "reviewed"; review_id: string; revision: number; url: string; approved: boolean; feedback: Feedback[] };

/** The operations behind the MCP tools and the CLI, independent of transport. */
export class Hoop {
  constructor(readonly store = new Store()) {}

  submit(input: unknown): SubmitResult {
    const v = validateReview(input);
    if (!v.ok) throw new HoopError("invalid review document", v.errors);
    const doc: ReviewDoc = v.value;
    const meta = doc.review_id ? this.store.addRevision(this.existing(doc.review_id).id, doc) : this.store.create(doc);
    return { review_id: meta.id, revision: meta.revisions, url: reviewUrl(meta.id), status: meta.status };
  }

  /** Feedback on the latest revision; "pending" until someone submits a review. */
  feedback(reviewId: string): FeedbackResult {
    const meta = this.existing(reviewId);
    const base = { review_id: meta.id, revision: meta.revisions, url: reviewUrl(meta.id) };
    const feedback = this.store.feedback(meta.id);
    if (!feedback.length) return { status: "pending", ...base };
    return { status: "reviewed", ...base, approved: meta.status === "approved", feedback };
  }

  private existing(id: string): ReviewMeta {
    try {
      return this.store.meta(id);
    } catch {
      throw new HoopError(`no review ${id}`);
    }
  }
}
