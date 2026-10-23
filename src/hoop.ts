import { commentScope, validateFeedback, validateReview, type Feedback, type ReviewDoc } from "./contract.js";
import { resolveQuote } from "./quote.js";
import { Store, type ReviewMeta } from "./store.js";
import { matchSections } from "./markdown.js";
import { audit } from "./audit.js";
import { editable, existing, signedVerdict, thread, threadIds } from "./rules.js";
import { currentUser, HoopError, repoDir } from "./util.js";
import { Materializer } from "./materialize.js";
import { cursorOf } from "./wait.js";
import type { Applied, Proposal } from "./store.js";

export const PORT = Number(process.env.HOOP_PORT ?? 4747);
export const reviewUrl = (id: string) => `http://localhost:${PORT}/r/${id}`;

export { HoopError };

/**
 * What a submit did: `created` a review, `revised` one, or `superseded` an approved one with a new
 * review. `next_review_id` is the review to use from now on.
 */
export type SubmitResult = {
  review_id: string;
  revision: number;
  url: string;
  status: ReviewMeta["status"];
  outcome: "created" | "revised" | "superseded";
  next_review_id: string;
  cursor: string;
  supersedes?: string;
};

export type FeedbackResult =
  | {
      status: "pending";
      review_id: string;
      revision: number;
      url: string;
      cursor: string;
      superseded_by?: string;
      applied?: Applied[];
      edits?: Proposal[];
    }
  | {
      status: "reviewed";
      review_id: string;
      revision: number;
      url: string;
      approved: boolean;
      cursor: string;
      /** The review that replaced this one; use it from now on. */
      superseded_by?: string;
      feedback: Feedback[];
      /** Comments materialized into the document, with the revision each produced. */
      applied?: Applied[];
      /** Edits Claude proposed, with the reviewer's decision on each. */
      edits?: Proposal[];
    };

/** The operations behind the MCP tools and the CLI, independent of transport. */
export class Hoop {
  readonly materializer: Materializer;

  constructor(readonly store = new Store()) {
    this.materializer = new Materializer(store);
  }

  submit(input: unknown): SubmitResult {
    const v = validateReview(input);
    if (!v.ok) throw new HoopError("invalid review document", v.errors);
    const doc: ReviewDoc = v.value;
    const prior = doc.review_id ? existing(this.store, doc.review_id) : undefined;
    const repo_dir = repoDir();
    // An approved review is frozen: a later submit starts a new review that supersedes it.
    // A document's sections keep their IDs across revisions, so comments stay on the same section.
    const matched = prior && doc.kind === "doc" ? matchSections(this.store.revision(prior.id), doc) : { doc, renamed: {} };
    const revising = Boolean(prior && prior.status !== "approved");
    const meta = revising ? this.store.addRevision(prior!.id, matched.doc) : this.store.create(doc, { repo_dir, ...(prior ? { supersedes: prior.id } : {}) });
    if (revising) this.store.saveRenamed(meta.id, meta.revisions, matched.renamed);
    if (prior && !revising) this.store.update(prior.id, { superseded_by: meta.id });
    audit("submit", { review_id: meta.id, revision: meta.revisions, actor: "claude", kind: doc.kind, items: doc.items.length });
    return this.result(meta, revising ? "revised" : prior ? "superseded" : "created");
  }

  private result(meta: ReviewMeta, outcome: SubmitResult["outcome"]): SubmitResult {
    return {
      review_id: meta.id,
      revision: meta.revisions,
      url: reviewUrl(meta.id),
      status: meta.status,
      outcome,
      next_review_id: meta.id,
      cursor: cursorOf(this, meta.id),
      ...(meta.supersedes ? { supersedes: meta.supersedes } : {}),
    };
  }

  /** Feedback on the latest revision; "pending" until someone submits a review. */
  feedback(reviewId: string): FeedbackResult {
    const meta = existing(this.store, reviewId);
    const base = {
      review_id: meta.id,
      revision: meta.revisions,
      url: reviewUrl(meta.id),
      cursor: cursorOf(this, meta.id),
      ...(meta.superseded_by ? { superseded_by: meta.superseded_by } : {}),
    };
    const doc = this.store.revision(meta.id);
    // Each comment says what its edits may change.
    const feedback = this.store.feedback(meta.id).map((f) => ({ ...f, comments: f.comments.map((c) => ({ ...c, scope: commentScope(doc, c) })) }));
    const applied = this.store.applied(meta.id);
    const proposals = this.store.proposals(meta.id);
    const extra = { ...(applied.length ? { applied } : {}), ...(proposals.length ? { edits: proposals } : {}) };
    if (!feedback.length && meta.status === "open") return { status: "pending", ...base, ...extra };
    return {
      status: "reviewed",
      ...base,
      approved: meta.status === "approved",
      feedback,
      ...extra,
    };
  }

  /**
   * A reviewer's submitted review on the latest revision. From the pages, `auth` says who signed in
   * in the browser and whether the sign-in is on; see `signedVerdict`. Calls inside hoop pass no
   * `auth`, and their verdict stands.
   */
  review(reviewId: string, input: Record<string, unknown>, auth?: { login?: string; signin: { enabled: boolean } }): Feedback {
    const meta = editable(this.store, reviewId);
    const known = threadIds(this.store, meta.id);
    const doc = this.store.revision(meta.id);
    type Incoming = { thread?: string; item?: string; line?: number; words?: unknown };
    const comments = (Array.isArray(input.comments) ? (input.comments as Incoming[]) : []).map((raw, i) => {
      // A thread id the review doesn't have is dropped, so the store assigns a fresh one.
      const c = raw?.thread && !known.has(raw.thread) ? { ...raw, thread: undefined } : raw;
      if (!c || typeof c !== "object" || c.line !== undefined) return c;
      // A reply may leave out its anchor, which is its thread's.
      const rooted = c.thread ? thread(this.store, meta.id, c.thread) : undefined;
      if (rooted) return { ...c, item: rooted.root.item, line: rooted.root.line };
      // A new comment may name its words in place of a line.
      if (typeof c.words !== "string") return c;
      const { words, ...rest } = c;
      return { ...rest, ...resolveQuote(doc, { item: c.item, words }, { review_id: meta.id, path: `comments.${i}.words` }) };
    });
    // The sign-in comes only from the browser's sign-in, never from what the page sent.
    const { signed_in: _s, ...sent } = input;
    const signed = auth ? signedVerdict(input.verdict, auth.login, auth.signin) : undefined;
    const fb: Record<string, unknown> = {
      answers: [],
      resolved_threads: [],
      viewed: [],
      ...(auth ? { ...sent, ...signed } : input),
      comments,
      schema: "hoop/feedback@0",
      review_id: meta.id,
      revision: meta.revisions,
      reviewer: typeof input.reviewer === "string" && input.reviewer ? input.reviewer : currentUser(),
      at: new Date().toISOString(),
    };
    // Replies keep their thread's original anchor, which a later revision may have changed, so only
    // new comments are checked against the current revision's lines.
    const v = validateFeedback({ ...fb, comments: comments.filter((c) => !c.thread) }, this.store.revision(meta.id));
    if (!v.ok) throw new HoopError("invalid feedback", v.errors);
    const all = validateFeedback(fb);
    if (!all.ok) throw new HoopError("invalid feedback", all.errors);
    const stored = this.store.addFeedback(meta.id, all.value);
    audit("review", {
      review_id: meta.id,
      revision: meta.revisions,
      actor: stored.reviewer,
      verdict: stored.verdict,
      comments: stored.comments.length,
      suggestions: stored.comments.filter((c) => c.suggestion !== undefined).length,
      on_text: stored.comments.filter((c) => c.range).length,
      answers: stored.answers.length,
      ...(stored.signed_in ? { signed_in: stored.signed_in.login } : {}),
    });
    if (stored.verdict === "approved") this.store.update(meta.id, { status: "approved", approved_at: stored.at });
    return stored;
  }

  /** Applies a reviewer's exact suggestion as a new revision. */
  applySuggestion(reviewId: string, thread: string, by = currentUser()) {
    return this.materializer.applySuggestion(reviewId, thread, by);
  }

  /** The agent's span edits for a comment, shown to the reviewer as tracked changes. */
  proposeEdits(reviewId: string, thread: string, edits: unknown, note?: string) {
    return this.materializer.proposeEdits(reviewId, thread, edits, note);
  }

  /** Where a proposed edit sits in the latest revision, or null if its text has changed. */
  editPosition(reviewId: string, p: Proposal) {
    return this.materializer.editPosition(reviewId, p);
  }

  /** The reviewer's accept or reject of a proposed edit. */
  decideEdit(reviewId: string, editId: string, action: "accept" | "reject", by = currentUser()) {
    return this.materializer.decideEdit(reviewId, editId, action, by);
  }
  /** The agent's reply in a comment thread. */
  reply(thread: string, body: string, author = "claude") {
    if (!body.trim()) throw new HoopError("a reply needs text");
    const id = this.store.findThread(thread);
    if (!id) throw new HoopError(`no thread ${thread}`);
    const reply = { thread, author, body, at: new Date().toISOString() };
    this.store.addReply(id, reply);
    audit("reply", { review_id: id, actor: author, thread });
    return { review_id: id, ...reply };
  }
}
