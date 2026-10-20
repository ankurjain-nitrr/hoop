import { mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { commentScope, validateFeedback, validateReview, type Feedback, type ReviewDoc } from "./contract.js";
import { resolveQuote } from "./quote.js";
import { Store, type ReviewMeta } from "./store.js";
import { renderMarkdown } from "./render.js";
import { exportMarkdown, linePlaces, matchSections, type MarkdownOptions } from "./markdown.js";
import { repoCommand, runCheck, type CheckOutcome } from "./checks.js";
import { checkDoc, gatedChanges } from "./sequence.js";
import { audit } from "./audit.js";
import { editable, existing, thread, threadIds } from "./rules.js";
import { currentUser, HoopError, repoDir } from "./util.js";
import { GitHub } from "./github.js";
import { Materializer } from "./materialize.js";
import { cursorOf } from "./wait.js";
import type { Applied, Proposal } from "./store.js";

export const PORT = Number(process.env.HOOP_PORT ?? 4747);
export const reviewUrl = (id: string) => `http://localhost:${PORT}/r/${id}`;

export { HoopError };

/**
 * What a submit did: `created` a review, `revised` one, or `superseded` an approved one with a new
 * review. `next_review_id` is the review to use from now on. `warnings` lead when a check didn't run.
 */
export type SubmitResult = {
  warnings?: string[];
  review_id: string;
  revision: number;
  url: string;
  status: ReviewMeta["status"];
  outcome: "created" | "revised" | "superseded";
  next_review_id: string;
  cursor: string;
  supersedes?: string;
  checks?: CheckOutcome;
};

/** Decision files as names in the repository; older reviews stored them as absolute paths. */
export function decisionNames(meta: Pick<ReviewMeta, "decision_files" | "repo_dir">): string[] | undefined {
  return meta.decision_files?.map((f) => {
    if (!isAbsolute(f)) return f;
    const rel = meta.repo_dir ? relative(meta.repo_dir, f) : "..";
    return rel.startsWith("..") || isAbsolute(rel) ? `decisions/${basename(f)}` : rel.split(sep).join("/");
  });
}

/** The agent's warning for a check that didn't run, or none. */
function checkWarning(checks: CheckOutcome | undefined): string | undefined {
  if (!checks || checks.ran || checks.reason === "running") return undefined;
  if (checks.reason === "not_allowed")
    return "This repository's check didn't run: it isn't allowed on this machine yet. Ask the user to run `hoop allow-check` in this repository, in a terminal.";
  return `This repository's check didn't run: ${checks.message ?? checks.reason}`;
}

/** A markdown submission's source, so hoop can check it and place the findings. */
export type MarkdownSource = { markdown: string; options: MarkdownOptions };

export type FeedbackResult =
  | {
      status: "pending";
      review_id: string;
      revision: number;
      url: string;
      cursor: string;
      superseded_by?: string;
      answers?: Answer[];
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

  constructor(
    readonly store = new Store(),
    readonly github = new GitHub(),
  ) {
    this.materializer = new Materializer(store);
  }

  /**
   * Submit over either channel. With a change, or as a revision of a review linked to one, the
   * sequencer first checks the document before it is approved and current.
   */
  async submitAny(input: unknown, opts: { change?: { cr: string; doc: string }; source?: MarkdownSource } = {}): Promise<SubmitResult> {
    const result = await this.submitLinked(input, opts);
    if (!opts.source) return result;
    const checks = await this.check(result.review_id, result.revision, opts.source);
    if (!checks) return result;
    const warning = checkWarning(checks);
    return warning ? { warnings: [warning], ...result, checks } : { ...result, checks };
  }

  /**
   * Checks a stored markdown revision with the project's command, when the user allows it. A
   * `running` outcome is stored first, so the page can say a check is under way. Each finding is
   * placed on the stored revision's item line. It never throws.
   */
  private async check(id: string, revision: number, source: MarkdownSource): Promise<CheckOutcome | undefined> {
    const repo = this.store.meta(id).repo_dir ?? repoDir();
    if (!repoCommand(repo)) return undefined;
    const started = new Date().toISOString();
    this.store.saveCheck(id, revision, { ran: false, reason: "running", message: "The check is running.", findings: [], started });
    const outcome = (await runCheck(repo, source.markdown, this.store.home)) ?? {
      ran: false,
      reason: "failed" as const,
      message: "The check command went away.",
      findings: [],
    };
    const items = this.store.revision(id, revision).items;
    let places = new Map<number, { index: number; line: number }>();
    try {
      places = linePlaces(source.markdown, source.options);
    } catch {
      /* findings stay unplaced */
    }
    for (const f of outcome.findings) {
      const at = f.line ? places.get(f.line) : undefined;
      const item = at ? items[at.index] : undefined;
      if (at && item) f.place = { item: item.id, line: at.line };
    }
    const stored = { ...outcome, started };
    this.store.saveCheck(id, revision, stored);
    audit("check", { review_id: id, revision, ok: true, ran: outcome.ran, reason: outcome.reason, findings: outcome.findings.length, ms: outcome.ms });
    return stored;
  }

  private async submitLinked(input: unknown, opts: { change?: { cr: string; doc: string } }): Promise<SubmitResult> {
    const id = (input as { review_id?: unknown } | null)?.review_id;
    const prior = typeof id === "string" ? this.linkOf(id) : undefined;
    // A review stays with the change and document it was opened for, so one approval can't count twice.
    if (prior && opts.change && (prior.cr !== opts.change.cr || prior.doc !== opts.change.doc))
      throw new HoopError(
        `review ${id} is the ${prior.doc.toUpperCase()} of ${prior.cr}; submit without review_id to start a review for ${opts.change.cr} ${String(opts.change.doc).toUpperCase()}`,
        [{ path: "change", message: `review ${id} belongs to ${prior.cr} ${prior.doc}` }],
      );
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
      const err = new HoopError(
        `can't open the ${doc.toUpperCase()} review for ${link.cr}: ${blockers.join("; ")}`,
        blockers.map((m) => ({ path: "change", message: m })),
      );
      err.audited = true;
      throw err;
    }
    const result = await this.submitChannel(input);
    this.store.update(result.review_id, { change: { cr: link.cr, doc, repo } });
    await sequencer.link(link.cr, doc, result.review_id);
    return result;
  }

  private linkOf(reviewId: string): ReviewMeta["change"] {
    try {
      return this.store.meta(reviewId).change;
    } catch {
      return undefined;
    }
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
      const matched = doc.kind === "doc" ? matchSections(this.store.revision(prior.id), doc) : { doc, renamed: {} };
      const revised = matched.doc;
      const github = await this.github.revise(prior.github, { ...revised, review_id: prior.id }, prior.revisions + 1);
      const meta = this.store.addRevision(prior.id, revised);
      this.store.saveRenamed(meta.id, meta.revisions, matched.renamed);
      this.store.update(meta.id, { github });
      audit("submit", { review_id: meta.id, revision: meta.revisions, actor: "claude", kind: doc.kind, channel: "github", items: doc.items.length });
      return this.result(meta, prior.github.url, "revised");
    }
    const repo_dir = repoDir();
    const github = await this.github.open(repo_dir, doc);
    const meta = this.store.create(doc, { repo_dir, github, ...(prior ? { supersedes: prior.id } : {}) });
    if (prior) this.store.update(prior.id, { superseded_by: meta.id });
    audit("submit", { review_id: meta.id, revision: 1, actor: "claude", kind: doc.kind, channel: "github", items: doc.items.length });
    return this.result(meta, github.url, prior ? "superseded" : "created");
  }

  submit(input: unknown): SubmitResult {
    const v = validateReview(input);
    if (!v.ok) throw new HoopError("invalid review document", v.errors);
    const doc: ReviewDoc = v.value;
    const prior = doc.review_id ? existing(this.store, doc.review_id) : undefined;
    if (prior?.github && prior.status === "open") throw new HoopError(`review ${prior.id} is on GitHub; submit its revisions with channel "github"`);
    const repo_dir = repoDir();
    // An approved review is frozen: a later submit starts a new review that supersedes it (FR-7).
    // A document's sections keep their IDs across revisions, so comments stay on the same section.
    const matched = prior && doc.kind === "doc" ? matchSections(this.store.revision(prior.id), doc) : { doc, renamed: {} };
    const revising = Boolean(prior && prior.status !== "approved");
    const meta = revising ? this.store.addRevision(prior!.id, matched.doc) : this.store.create(doc, { repo_dir, ...(prior ? { supersedes: prior.id } : {}) });
    if (revising) this.store.saveRenamed(meta.id, meta.revisions, matched.renamed);
    if (prior && !revising) this.store.update(prior.id, { superseded_by: meta.id });
    audit("submit", { review_id: meta.id, revision: meta.revisions, actor: "claude", kind: doc.kind, channel: doc.channel, items: doc.items.length });
    return this.result(meta, reviewUrl(meta.id), revising ? "revised" : prior ? "superseded" : "created");
  }

  private result(meta: ReviewMeta, url: string, outcome: SubmitResult["outcome"]): SubmitResult {
    return {
      review_id: meta.id,
      revision: meta.revisions,
      url,
      status: meta.status,
      outcome,
      next_review_id: meta.id,
      cursor: cursorOf(this, meta.id),
      ...(meta.supersedes ? { supersedes: meta.supersedes } : {}),
    };
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
      this.store.update(meta.id, {
        status: "approved",
        approved_at: state.merged_at ?? new Date().toISOString(),
        decision_files: [`decisions/${slug}.json`, `decisions/${slug}.md`],
      });
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
      ...(meta.status === "closed" ? { closed: true } : {}),
      ...(meta.decision_files ? { decision_files: decisionNames(meta) } : {}),
    };
  }

  /** A reviewer's submitted review on the latest revision, from the review page. */
  review(reviewId: string, input: Record<string, unknown>): Feedback {
    const meta = editable(this.store, reviewId, { frozen: true, github: (m) => `review ${m.id} is reviewed on GitHub: ${m.github!.url}` });
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
    const fb: Record<string, unknown> = {
      answers: [],
      resolved_threads: [],
      viewed: [],
      ...input,
      comments,
      schema: "hoop/feedback@0",
      review_id: meta.id,
      revision: meta.revisions,
      reviewer: typeof input.reviewer === "string" && input.reviewer ? input.reviewer : currentUser(),
      at: new Date().toISOString(),
      source: { channel: "local" },
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
    this.store.update(reviewId, { decision_files: [`decisions/${doc.slug}.json`, `decisions/${doc.slug}.md`] });
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
