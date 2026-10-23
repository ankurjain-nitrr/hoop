import { commentScope, validateFeedback, validateReview, type Feedback, type ReviewDoc } from "./contract.js";
import { resolveQuote } from "./quote.js";
import { receiptKey, Store, type ReviewMeta } from "./store.js";
import { exportMarkdown, matchSections, parseMarkdown } from "./markdown.js";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type BlockKind, type Build, type BuildChange, Builds, type GenTask, joinBlocks } from "./build.js";
import { editable, existing, mustOwn, NO_SESSION, notBuilding, thread, threadIds } from "./rules.js";
import { agentFromEnv, ownerNow, ownerOf, sessionHoop, sessionLabel, type Agent, type Owner } from "./owner.js";
import { currentUser, gitRoot, HoopError, repoDir } from "./util.js";
import { Materializer } from "./materialize.js";
import { cursorOf } from "./wait.js";
import type { Applied, Proposal } from "./store.js";

export const PORT = Number(process.env.HOOP_PORT ?? 4747);
export const reviewUrl = (id: string) => `http://localhost:${PORT}/r/${id}`;

export { HoopError };

/**
 * What a submit did: `created` a review, `revised` one, or `superseded` an approved one with a new
 * review; `hoop open` on a file that hasn't changed leaves its review `unchanged`. `next_review_id`
 * is the review to use from now on.
 */
export type SubmitResult = {
  review_id: string;
  revision: number;
  url: string;
  status: ReviewMeta["status"];
  outcome: "created" | "revised" | "superseded" | "unchanged";
  next_review_id: string;
  cursor: string;
  supersedes?: string;
  /** The session that owns the review, as `<name> (<id8>)`. */
  owner?: string;
  /** The person who opened the review from a file with `hoop open`. */
  opened_by?: string;
};

export type FeedbackResult =
  | {
      status: "pending";
      review_id: string;
      revision: number;
      url: string;
      cursor: string;
      owner?: string;
      opened_by?: string;
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
      /** The person who opened the review from a file; any session may reply in its threads, and no session may revise it. */
      opened_by?: string;
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
  readonly builds: Builds;
  private agent: Agent | null;

  /**
   * `agent` is the session this process acts for (`agentFromEnv`); a string names a Claude Code
   * session. Without one (null), as in a person's terminal, hoop only reads.
   */
  constructor(
    readonly store = new Store(),
    agent: string | Agent | null = agentFromEnv() ?? null,
  ) {
    this.materializer = new Materializer(store);
    this.builds = new Builds(store);
    this.agent = typeof agent === "string" ? { session: agent, claude: true } : agent;
  }

  /** The session this process acts for, with its kind, or null. */
  get actor(): Agent | null {
    return this.agent;
  }

  /** The session ID this process acts for, or null. */
  get session(): string | null {
    return this.agent?.session ?? null;
  }

  /** Acts for `agent` from now on, unless this process already acts for a session. */
  adopt(agent: Agent): void {
    this.agent ??= agent;
  }

  /** The owner record for a session, named as it is now. */
  private ownerOf(agent: Agent): Owner {
    return ownerOf(agent, this.store.home);
  }

  /** Where a session's new reviews live: a Claude Code session's own folder when hoop can find it, else the hoop home folder. */
  private folderOf(agent: Agent): string | undefined {
    return agent.claude ? sessionHoop(agent.session) : undefined;
  }

  /** A review's owner as people read it, with the session's name as it is now. */
  ownerLabel(owner: Owner): string {
    return sessionLabel(ownerNow(owner, this.store.home));
  }

  /** This process's session, or the refusal for a process outside one. */
  private needAgent(): Agent {
    if (!this.agent) throw new HoopError(NO_SESSION);
    return this.agent;
  }

  /**
   * Under the review's lock: refuses an owner's action from another session, and makes this session
   * the owner of a review that has none. A review a person opened stays theirs.
   */
  private claim(id: string, action: "reply" | "propose"): ReviewMeta {
    const meta = this.store.meta(id);
    mustOwn(meta, this.session ?? undefined, action);
    return meta.owner || meta.opened_by ? meta : this.store.update(id, { owner: this.ownerOf(this.needAgent()) });
  }

  submit(input: unknown): SubmitResult {
    const v = validateReview(input);
    if (!v.ok) throw new HoopError("invalid review document", v.errors);
    const doc: ReviewDoc = v.value;
    const agent = this.needAgent();
    const session = agent.session;
    const place = this.place();
    if (!doc.review_id) return this.result(this.store.create(doc, { ...place, owner: this.ownerOf(agent) }, this.folderOf(agent)), "created");
    const id = existing(this.store, doc.review_id).id;
    return this.store.lock(id, () => {
      const prior = this.store.meta(id);
      mustOwn(prior, session, "revise");
      notBuilding(prior);
      // The owner's name is read again, so a session renamed since shows its new title.
      return this.revise(prior, doc, { ...place, owner: this.ownerOf(agent) }, this.folderOf(agent));
    });
  }

  /**
   * Under the review's lock: a new revision of `prior`, or, when it is approved and so frozen, a new
   * review in `folder` that supersedes it. `extra` updates the review's metadata either way.
   */
  private revise(prior: ReviewMeta, doc: ReviewDoc, extra: Partial<ReviewMeta>, folder?: string): SubmitResult {
    if (prior.status === "approved") {
      const meta = this.store.create(doc, { ...extra, supersedes: prior.id }, folder);
      this.store.update(prior.id, { superseded_by: meta.id });
      return this.result(meta, "superseded");
    }
    // A document's sections keep their IDs across revisions, so comments stay on the same section.
    const matched = doc.kind === "doc" ? matchSections(this.store.revision(prior.id), doc) : { doc, renamed: {} };
    const revised = this.store.addRevision(prior.id, matched.doc);
    this.store.saveRenamed(prior.id, revised.revisions, matched.renamed);
    return this.result(this.store.update(prior.id, extra), "revised");
  }

  /**
   * Opens a markdown file for review as the person at the terminal, with no session: the review is
   * theirs (`opened_by`) and lives in the hoop home folder. Opening the same file again revises its
   * review when the file's text changed since, and otherwise only gives its link.
   */
  open(file: string, opts: { title?: string } = {}): SubmitResult {
    let path: string, text: string;
    try {
      path = realpathSync(resolve(file));
      text = readFileSync(path, "utf8");
    } catch {
      throw new HoopError(`can't read ${file}`, [{ path: "file", message: "not a readable file" }]);
    }
    const source = { path, sha256: createHash("sha256").update(text).digest("hex") };
    const doc = parseMarkdown(text, opts.title ? { title: opts.title } : {});
    const repo = gitRoot(dirname(path));
    const extra = { repo_dir: dirname(path), ...(repo ? { repo } : {}), opened_by: currentUser(), source };
    const prior = this.store.list().find((m) => m.source?.path === path && !m.superseded_by);
    if (!prior) return this.result(this.store.create(doc, extra), "created");
    return this.store.lock(prior.id, () => {
      const meta = this.store.meta(prior.id);
      if (meta.source?.sha256 === source.sha256) return this.result(meta, "unchanged");
      return this.revise(meta, doc, extra);
    });
  }

  /** The folder the session works in, and its git repository: details on a review. */
  private place(): Pick<ReviewMeta, "repo_dir" | "repo"> {
    const repo_dir = repoDir();
    const repo = gitRoot(repo_dir);
    return { repo_dir, ...(repo ? { repo } : {}) };
  }

  /**
   * Starts building a document with the person: a review whose page lets them add, edit, move and
   * remove blocks, starting from Claude's `markdown` (a working title and an outline).
   */
  startBuild(markdown: string): SubmitResult {
    const agent = this.needAgent();
    const doc = parseMarkdown(markdown);
    const v = validateReview(doc);
    if (!v.ok) throw new HoopError("invalid document", v.errors);
    const meta = this.store.create(v.value, { ...this.place(), owner: this.ownerOf(agent), build: "open" }, this.folderOf(agent));
    this.store.lock(meta.id, () => this.builds.create(meta.id, markdown, "claude"));
    return this.result(this.store.meta(meta.id), "created");
  }

  /** A person's change to a build from the page. */
  buildChange(id: string, change: BuildChange): Build {
    const meta = existing(this.store, id);
    if (meta.build !== "open") throw new HoopError(`${meta.id} is not a document being built`);
    if (!change || typeof change !== "object") throw new HoopError("expected a change");
    const c = change as Record<string, unknown>;
    const str = (k: string) => {
      if (typeof c[k] !== "string") throw new HoopError(`expected ${k}`, [{ path: k, message: "required" }]);
      return c[k] as string;
    };
    if (c.op === "add")
      return this.builds.change(meta.id, { op: "add", kind: str("kind") as BlockKind, ...(c.after !== undefined ? { after: str("after") } : {}) });
    if (c.op === "edit") return this.builds.change(meta.id, { op: "edit", block: str("block"), text: str("text") });
    if (c.op === "move") {
      if (c.to !== "up" && c.to !== "down") throw new HoopError('expected to: "up" or "down"');
      return this.builds.change(meta.id, { op: "move", block: str("block"), to: c.to });
    }
    if (c.op === "remove") return this.builds.change(meta.id, { op: "remove", block: str("block") });
    if (c.op === "generate")
      return this.builds.change(meta.id, { op: "generate", block: str("block"), ...(c.note !== undefined ? { note: str("note") } : {}) });
    if (c.op === "undo") return this.builds.change(meta.id, { op: "undo", block: str("block") });
    throw new HoopError('expected op "add", "edit", "move", "remove", "generate" or "undo"');
  }

  /**
   * The person's Finish: the build's markdown becomes the review's next revision, and the build page
   * becomes the review page. Sections keep their IDs by heading, as in any revision.
   */
  finishBuild(id: string): SubmitResult {
    const meta = existing(this.store, id);
    return this.store.lock(meta.id, () => {
      const now = this.store.meta(meta.id);
      if (now.build !== "open") throw new HoopError(`${meta.id} is not a document being built`);
      const doc = parseMarkdown(joinBlocks(this.builds.read(meta.id)));
      const v = validateReview(doc);
      if (!v.ok) throw new HoopError("the document can't be reviewed yet", v.errors);
      const matched = matchSections(this.store.revision(meta.id), v.value);
      const revised = this.store.addRevision(meta.id, matched.doc);
      this.store.saveRenamed(meta.id, revised.revisions, matched.renamed);
      this.builds.save(meta.id, this.builds.read(meta.id), "person", "finished the build");
      return this.result(this.store.update(meta.id, { build: undefined }), "revised");
    });
  }

  /** A build that only its owner's session may write into, or the refusal. */
  private ownBuild(id: string): ReviewMeta {
    const meta = existing(this.store, id);
    mustOwn(meta, this.session ?? undefined, "revise");
    if (meta.build !== "open") throw new HoopError(`${meta.id} is not a document being built`);
    return meta;
  }

  /** Takes the person's queued Generate requests on a build. Only the build's owner may. */
  takeRequests(id: string): GenTask[] {
    return this.builds.take(this.ownBuild(id).id);
  }

  /** Claude's text for a section of a build. Only the build's owner may write. */
  buildWrite(id: string, section: string, markdown: string): Build {
    return this.builds.write(this.ownBuild(id).id, section, markdown);
  }

  /** The markdown of a review's latest revision, or of a build as it stands. */
  markdownOf(id: string): string {
    const meta = existing(this.store, id);
    return meta.build === "open" ? joinBlocks(this.builds.read(meta.id)) : exportMarkdown(this.store.revision(meta.id));
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
      ...(meta.owner ? { owner: this.ownerLabel(meta.owner) } : {}),
      ...(meta.opened_by ? { opened_by: meta.opened_by } : {}),
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
      ...(meta.owner ? { owner: this.ownerLabel(meta.owner) } : {}),
      ...(meta.opened_by ? { opened_by: meta.opened_by } : {}),
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
   * Feedback as the agent receives it: `feedback`, with a receipt for each submitted review in it,
   * so the page can show that the agent read them. hoop_wait, hoop_feedback, `hoop wait` and the
   * plan hook read feedback this way; the pages never do.
   */
  receive(reviewId: string): FeedbackResult {
    const result = this.feedback(reviewId);
    if (result.status !== "reviewed" || !result.feedback.length) return result;
    const keys = result.feedback.map((_, i) => receiptKey(result.revision, i));
    const have = this.store.receipts(result.review_id);
    if (keys.some((k) => !have[k])) this.store.addReceipts(result.review_id, keys, this.reader());
    return result;
  }

  /** Who receives feedback in this process: its session as people read it, or "agent" outside a session. */
  private reader(): string {
    return this.agent ? sessionLabel(ownerOf(this.agent, this.store.home)) : "agent";
  }

  /**
   * A reviewer's submitted review on the latest revision. `fromPage` marks a review sent from the
   * pages, which can't name a session: only hoop_comment does.
   */
  review(reviewId: string, input: Record<string, unknown>, fromPage = false): Feedback {
    return this.store.lock(existing(this.store, reviewId).id, () => this.addReview(reviewId, input, fromPage));
  }

  private addReview(reviewId: string, input: Record<string, unknown>, fromPage: boolean): Feedback {
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
    const { session: _c, ...sent } = input;
    const fb: Record<string, unknown> = {
      answers: [],
      resolved_threads: [],
      viewed: [],
      ...(fromPage ? sent : input),
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
    const owner = this.ownerOf(this.needAgent());
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

  /** The owner's reply in a comment thread, named after the owner's session; on a review a person opened, after the replying session. */
  reply(thread: string, body: string) {
    if (!body.trim()) throw new HoopError("a reply needs text");
    const id = this.store.findThread(thread);
    if (!id) throw new HoopError(`no thread ${thread}`);
    return this.store.lock(id, () => {
      const meta = this.claim(id, "reply");
      const reply = { thread, author: sessionLabel(meta.owner ?? this.ownerOf(this.needAgent())), body, at: new Date().toISOString() };
      this.store.addReply(id, reply);
      return { review_id: id, ...reply };
    });
  }
}
