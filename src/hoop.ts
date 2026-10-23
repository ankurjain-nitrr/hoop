import { commentScope, validateFeedback, validateReview, type Feedback, type ReviewDoc } from "./contract.js";
import { resolveQuote } from "./quote.js";
import { Store, type ReviewMeta } from "./store.js";
import { matchSections } from "./markdown.js";
import { editable, existing, mustOwn, NO_SESSION, signedVerdict, thread, threadIds } from "./rules.js";
import { ownerOf, sessionFromEnv, sessionLabel } from "./owner.js";
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
  /** The session that owns the review, as `<name> (<id8>)`. */
  owner?: string;
};

export type FeedbackResult =
  | {
      status: "pending";
      review_id: string;
      revision: number;
      url: string;
      cursor: string;
      owner?: string;
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
      /** The session that submitted the review, as `<name> (<id8>)`; only it may revise, reply or propose edits. */
      owner?: string;
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

  /**
   * `session` is the Claude Code session this process acts for (`CLAUDE_CODE_SESSION_ID`); without
   * one (null), as in a person's terminal, hoop only reads.
   */
  constructor(
    readonly store = new Store(),
    readonly session: string | null = sessionFromEnv() ?? null,
  ) {
    this.materializer = new Materializer(store);
  }

  /** This process's session, or the refusal for a process outside one. */
  private needSession(): string {
    if (!this.session) throw new HoopError(NO_SESSION);
    return this.session;
  }

  /** Under the review's lock: refuses an owner's action from another session, and makes this session the owner of a review that has none. */
  private claim(id: string, action: "reply" | "propose"): ReviewMeta {
    const meta = this.store.meta(id);
    mustOwn(meta, this.session ?? undefined, action);
    return meta.owner ? meta : this.store.update(id, { owner: ownerOf(this.needSession()) });
  }

  submit(input: unknown): SubmitResult {
    const v = validateReview(input);
    if (!v.ok) throw new HoopError("invalid review document", v.errors);
    const doc: ReviewDoc = v.value;
    const session = this.needSession();
    const repo_dir = repoDir();
    if (!doc.review_id) return this.result(this.store.create(doc, { repo_dir, owner: ownerOf(session) }), "created");
    const id = existing(this.store, doc.review_id).id;
    return this.store.lock(id, () => {
      const prior = this.store.meta(id);
      mustOwn(prior, session, "revise");
      // The owner's name is read again, so a session renamed since shows its new title.
      const owner = ownerOf(session);
      // An approved review is frozen: a later submit starts a new review that supersedes it.
      if (prior.status === "approved") {
        const meta = this.store.create(doc, { repo_dir, owner, supersedes: prior.id });
        this.store.update(prior.id, { superseded_by: meta.id });
        return this.result(meta, "superseded");
      }
      // A document's sections keep their IDs across revisions, so comments stay on the same section.
      const matched = doc.kind === "doc" ? matchSections(this.store.revision(prior.id), doc) : { doc, renamed: {} };
      const revised = this.store.addRevision(id, matched.doc);
      this.store.saveRenamed(id, revised.revisions, matched.renamed);
      return this.result(this.store.update(id, { owner }), "revised");
    });
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
      ...(meta.owner ? { owner: sessionLabel(meta.owner) } : {}),
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
      ...(meta.owner ? { owner: sessionLabel(meta.owner) } : {}),
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
    return this.store.lock(existing(this.store, reviewId).id, () => this.addReview(reviewId, input, auth));
  }

  private addReview(reviewId: string, input: Record<string, unknown>, auth?: { login?: string; signin: { enabled: boolean } }): Feedback {
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
      return { ...rest, ...resolveQuote(doc, { item: c.item, words }, { path: `comments.${i}.words` }) };
    });
    // The sign-in comes only from the browser's sign-in, and a session only from hoop_comment, never from what the page sent.
    const { signed_in: _s, session: _c, ...sent } = input;
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
    if (stored.verdict === "approved") this.store.update(meta.id, { status: "approved", approved_at: stored.at });
    return stored;
  }

  /**
   * A comment from a Claude Code session, as comment-only feedback named after the session. Any
   * session may comment; it is how a session that doesn't own a review takes part in it.
   */
  comment(reviewId: string, c: { item?: string; line?: number; words?: string; thread?: string; body: string }): Feedback {
    const owner = ownerOf(this.needSession());
    if (!c.body.trim()) throw new HoopError("a comment needs text", [{ path: "body", message: "required" }]);
    if (!c.thread && c.words === undefined && (c.item === undefined || c.line === undefined))
      throw new HoopError("a comment needs an item and a line, words to quote, or a thread to answer", [{ path: "line", message: "required" }]);
    const comment = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined));
    return this.review(reviewId, {
      verdict: "comment",
      reviewer: sessionLabel(owner),
      session: { id: owner.session, ...(owner.name ? { name: owner.name } : {}) },
      comments: [comment],
    });
  }

  /** Applies a reviewer's exact suggestion as a new revision. */
  applySuggestion(reviewId: string, thread: string, by = currentUser()) {
    return this.store.lock(existing(this.store, reviewId).id, () => this.materializer.applySuggestion(reviewId, thread, by));
  }

  /** The agent's span edits for a comment, shown to the reviewer as tracked changes. Only the review's owner may propose. */
  proposeEdits(reviewId: string, thread: string, edits: unknown, note?: string) {
    const id = existing(this.store, reviewId).id;
    return this.store.lock(id, () => {
      this.claim(id, "propose");
      return this.materializer.proposeEdits(reviewId, thread, edits, note);
    });
  }

  /** Where a proposed edit sits in the latest revision, or null if its text has changed. */
  editPosition(reviewId: string, p: Proposal) {
    return this.materializer.editPosition(reviewId, p);
  }

  /** The reviewer's accept or reject of a proposed edit. */
  decideEdit(reviewId: string, editId: string, action: "accept" | "reject", by = currentUser()) {
    return this.store.lock(existing(this.store, reviewId).id, () => this.materializer.decideEdit(reviewId, editId, action, by));
  }

  /** The owner's reply in a comment thread, named after the owner's session. */
  reply(thread: string, body: string) {
    if (!body.trim()) throw new HoopError("a reply needs text");
    const id = this.store.findThread(thread);
    if (!id) throw new HoopError(`no thread ${thread}`);
    return this.store.lock(id, () => {
      const meta = this.claim(id, "reply");
      const reply = { thread, author: sessionLabel(meta.owner!), body, at: new Date().toISOString() };
      this.store.addReply(id, reply);
      return { review_id: id, ...reply };
    });
  }
}
