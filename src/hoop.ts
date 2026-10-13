import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateFeedback, validateReview, type Feedback, type ReviewDoc } from "./contract.js";
import { Store, type ReviewMeta } from "./store.js";
import { renderMarkdown } from "./render.js";
import { exportMarkdown, keepIds } from "./markdown.js";
import { checkDoc, gatedChanges } from "./sequence.js";
import { audit } from "./audit.js";
import { editable, existing, threadIds } from "./rules.js";
import { currentUser, HoopError, repoDir } from "./util.js";
import { GitHub } from "./github.js";
import { Materializer } from "./materialize.js";
import type { Applied, Proposal } from "./store.js";

export const PORT = Number(process.env.HOOP_PORT ?? 4747);
export const reviewUrl = (id: string) => `http://localhost:${PORT}/r/${id}`;

export { HoopError };

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
  readonly materializer: Materializer;

  constructor(readonly store = new Store(), readonly github = new GitHub()) {
    this.materializer = new Materializer(store);
  }

  /**
   * Submit over either channel. With a change, or as a revision of a review linked to one, the
   * sequencer first checks the document before it is approved and current (CR-3 FR-4).
   */
  async submitAny(input: unknown, opts: { change?: { cr: string; doc: string } } = {}): Promise<SubmitResult> {
    const id = (input as { review_id?: unknown } | null)?.review_id;
    const prior = typeof id === "string" ? this.linkOf(id) : undefined;
    // A review stays with the change and document it was opened for, so one approval can't count twice.
    if (prior && opts.change && (prior.cr !== opts.change.cr || prior.doc !== opts.change.doc))
      throw new HoopError(`review ${id} is the ${prior.doc.toUpperCase()} of ${prior.cr}; submit without review_id to start a review for ${opts.change.cr} ${String(opts.change.doc).toUpperCase()}`,
        [{ path: "change", message: `review ${id} belongs to ${prior.cr} ${prior.doc}` }]);
    const link = prior ?? opts.change;
    if (!link) return this.submitChannel(input);
    const doc = checkDoc(link.doc);
    // A linked review's change lives in the repository it was opened in.
    const repo = prior?.repo ?? repoDir();
    const { changes, sequencer } = gatedChanges(this.store, repo);
    changes.get(link.cr);
    const blockers = sequencer.blockers(link.cr, doc);
    if (blockers.length) {
      audit("submit", { ok: false, actor: "claude", cr: link.cr, doc, errors: blockers });
      const err = new HoopError(`can't open the ${doc.toUpperCase()} review for ${link.cr}: ${blockers.join("; ")}`, blockers.map((m) => ({ path: "change", message: m })));
      err.audited = true;
      throw err;
    }
    const result = await this.submitChannel(input);
    this.store.update(result.review_id, { change: { cr: link.cr, doc, repo } });
    await sequencer.link(link.cr, doc, result.review_id);
    return result;
  }

  private linkOf(reviewId: string): ReviewMeta["change"] {
    try { return this.store.meta(reviewId).change; } catch { return undefined; }
  }

  private async submitChannel(input: unknown): Promise<SubmitResult> {
    const v = validateReview(input);
    if (!v.ok) throw new HoopError("invalid review document", v.errors);
    if (v.value.channel !== "github") return this.submit(v.value);
    const doc = v.value;
    const prior = doc.review_id ? existing(this.store, doc.review_id) : undefined;
    if (prior && prior.status !== "approved") {
      if (!prior.github) throw new HoopError(`review ${prior.id} is local; submit revisions on the local channel`);
      // Push to the PR first, so a failed push leaves the store unchanged.
      const revised = doc.kind === "doc" ? keepIds(this.store.revision(prior.id), doc) : doc;
      const github = await this.github.revise(prior.github, { ...revised, review_id: prior.id }, prior.revisions + 1);
      const meta = this.store.addRevision(prior.id, revised);
      this.store.update(meta.id, { github });
      audit("submit", { review_id: meta.id, revision: meta.revisions, actor: "claude", kind: doc.kind, channel: "github", items: doc.items.length });
      return { review_id: meta.id, revision: meta.revisions, url: prior.github.url, status: meta.status };
    }
    const repo_dir = repoDir();
    const github = await this.github.open(repo_dir, doc);
    const meta = this.store.create(doc, { repo_dir, github, ...(prior ? { supersedes: prior.id } : {}) });
    audit("submit", { review_id: meta.id, revision: 1, actor: "claude", kind: doc.kind, channel: "github", items: doc.items.length });
    return { review_id: meta.id, revision: 1, url: github.url, status: meta.status, ...(prior ? { supersedes: prior.id } : {}) };
  }

  submit(input: unknown): SubmitResult {
    const v = validateReview(input);
    if (!v.ok) throw new HoopError("invalid review document", v.errors);
    const doc: ReviewDoc = v.value;
    const prior = doc.review_id ? existing(this.store, doc.review_id) : undefined;
    if (prior?.github && prior.status === "open")
      throw new HoopError(`review ${prior.id} is on GitHub; submit its revisions with channel "github"`);
    const repo_dir = repoDir();
    // An approved review is frozen: a later submit starts a new review that supersedes it (FR-7).
    // A document's sections keep their IDs across revisions, so comments stay on the same section.
    const revised = prior && doc.kind === "doc" ? keepIds(this.store.revision(prior.id), doc) : doc;
    const meta = prior && prior.status !== "approved"
      ? this.store.addRevision(prior.id, revised)
      : this.store.create(doc, { repo_dir, ...(prior ? { supersedes: prior.id } : {}) });
    audit("submit", { review_id: meta.id, revision: meta.revisions, actor: "claude", kind: doc.kind, channel: doc.channel, items: doc.items.length });
    return { review_id: meta.id, revision: meta.revisions, url: reviewUrl(meta.id), status: meta.status, ...(meta.supersedes ? { supersedes: meta.supersedes } : {}) };
  }

  /** Re-reads a GitHub review's PR into the store; merged means approved (FR-15). No-op for local reviews. */
  async refresh(reviewId: string): Promise<void> {
    const meta = existing(this.store, reviewId);
    if (!meta.github || meta.status !== "open") return;
    const revisions = Array.from({ length: meta.revisions }, (_, i) => this.store.revision(meta.id, i + 1));
    const state = await this.github.sync(meta.github, meta.id, revisions);
    this.store.setFeedback(meta.id, state.feedback);
    this.store.update(meta.id, { pr_answers: state.answers });
    if (state.closed) this.store.update(meta.id, { status: "closed" });
    if (state.merged) {
      const slug = revisions.at(-1)!.slug;
      this.store.update(meta.id, { status: "approved", approved_at: state.merged_at ?? new Date().toISOString(), decision_files: [`decisions/${slug}.json`, `decisions/${slug}.md`] });
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
    const meta = existing(this.store, reviewId);
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
    const meta = editable(this.store, reviewId, { frozen: true, github: (m) => `review ${m.id} is reviewed on GitHub: ${m.github!.url}` });
    const known = threadIds(this.store, meta.id);
    // A thread id the review doesn't have is dropped, so the store assigns a fresh one.
    const comments = (Array.isArray(input.comments) ? (input.comments as { thread?: string }[]) : []).map((c) =>
      c.thread && !known.has(c.thread) ? { ...c, thread: undefined } : c);
    const fb: Record<string, unknown> = {
      answers: [], resolved_threads: [], viewed: [], ...input, comments,
      schema: "hoop/feedback@0", review_id: meta.id, revision: meta.revisions,
      reviewer: typeof input.reviewer === "string" && input.reviewer ? input.reviewer : currentUser(),
      at: new Date().toISOString(), source: { channel: "local" },
    };
    // Replies keep their thread's original anchor, which a later revision may have changed, so only
    // new comments are checked against the current revision's lines.
    const v = validateFeedback({ ...fb, comments: comments.filter((c) => !c.thread) }, this.store.revision(meta.id));
    if (!v.ok) throw new HoopError("invalid feedback", v.errors);
    const all = validateFeedback(fb);
    if (!all.ok) throw new HoopError("invalid feedback", all.errors);
    const stored = this.store.addFeedback(meta.id, all.value);
    audit("review", {
      review_id: meta.id, revision: meta.revisions, actor: stored.reviewer, verdict: stored.verdict, comments: stored.comments.length,
      suggestions: stored.comments.filter((c) => c.suggestion !== undefined).length, on_text: stored.comments.filter((c) => c.range).length,
      answers: stored.answers.length,
    });
    if (stored.verdict === "approved") {
      this.store.update(meta.id, { status: "approved", approved_at: stored.at });
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

  /** Applies a reviewer's exact suggestion as a new revision (FR-18). */
  applySuggestion(reviewId: string, thread: string, by = currentUser()) {
    return this.materializer.applySuggestion(reviewId, thread, by);
  }

  /** The agent's span edits for a comment, shown to the reviewer as tracked changes (FR-20). */
  proposeEdits(reviewId: string, thread: string, edits: unknown, note?: string) {
    return this.materializer.proposeEdits(reviewId, thread, edits, note);
  }

  /** Where a proposed edit sits in the latest revision, or null if its text has changed. */
  editPosition(reviewId: string, p: Proposal) {
    return this.materializer.editPosition(reviewId, p);
  }

  /** The reviewer's accept or reject of a proposed edit (FR-21). */
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
