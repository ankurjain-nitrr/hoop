import {
  anchorText,
  Ask,
  type AskAnchor,
  commentScope,
  DOC,
  docLines,
  itemLines,
  validateFeedback,
  validateReview,
  type Feedback,
  type Item,
  type ReviewDoc,
  type SectionBrief,
  sectionList,
} from "./contract.js";
import { resolveQuote } from "./quote.js";
import { type AskPlace, receiptKey, receivedBy, Store, type ReviewMeta } from "./store.js";
import { exportMarkdown, highestSection, matchSections, parseMarkdown } from "./markdown.js";
import { type RevisionChanges, revisionChanges } from "./changes.js";
import { applySectionEdits, type Edited, type SectionEdit } from "./section-edits.js";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type BlockKind,
  type Build,
  type BuildChange,
  Builds,
  EXPECTED_OP,
  type GenTask,
  joinBlocks,
  type SuggestedHeading,
  type Suggestion,
} from "./build.js";
import {
  type AskAnswer,
  askAnswers,
  askState,
  type AskState,
  existing,
  mustAsk,
  mustOwn,
  NO_SESSION,
  notAsk,
  notBuilding,
  afterApproval,
  isReopened,
  approvable,
  checkVerdict,
  reviewable,
  thread,
  threadIds,
  threadViews,
  type ThreadView,
} from "./rules.js";
import { agentFromEnv, ownerNow, ownerOf, sessionHoop, sessionLabel, type Agent, type Owner } from "./owner.js";
import { currentUser, gitRoot, HoopError, repoDir, slugify } from "./util.js";
import { Materializer } from "./materialize.js";
import { cursorOf } from "./wait.js";
import { actsAs, processOf } from "./work.js";
import type { Applied, Proposal } from "./store.js";
import type { Remote } from "./remote.js";

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
  /** On a revision: the threads, from any revision, that you haven't answered yet. */
  unanswered_threads?: ThreadBrief[];
  /** On a revision with unanswered threads: one line naming them. */
  reminder?: string;
  /** On a submit: the revision's sections, by ID, heading and level, for section edits. */
  sections?: SectionBrief[];
  /** On a revision: the sections hoop found added, removed and modified since the revision before, with lines added and removed in each. */
  changes?: RevisionChanges;
};

/** A thread named in brief: where it is, and its first comment. */
export type ThreadBrief = { thread: string; revision: number; item: string; line: number; section: string; outdated: boolean; comment?: string };

/**
 * The comment threads on a review, from every revision: `threads` lists each one a reviewer hasn't
 * resolved, with its status, context and entries; `resolved` names the resolved ones in brief.
 * Both are left out on a review with no threads.
 */
export type Threads = { threads?: ThreadView[]; resolved?: ThreadBrief[] };

/** A thread in brief, with its first comment from anyone but the owner. */
const brief = (t: ThreadView): ThreadBrief => {
  const first = t.entries.find((e) => e.role !== "owner") ?? t.entries[0];
  const comment = first?.body ?? first?.suggestion;
  return { thread: t.thread, revision: t.revision, item: t.item, line: t.line, section: t.section, outdated: t.outdated, ...(comment ? { comment } : {}) };
};

/** A review's feedback as Claude reads it, with its threads from every revision. */
export type FeedbackResult = Threads & FeedbackState;

type FeedbackState =
  | {
      status: "pending";
      review_id: string;
      revision: number;
      url: string;
      cursor: string;
      owner?: string;
      opened_by?: string;
      superseded_by?: string;
      /** As on a reviewed result: the revision a person approved, and whether a request for changes since reopened the review. */
      approved_revision?: number;
      reopened?: true;
      applied?: Applied[];
      edits?: Proposal[];
    }
  | {
      status: "reviewed";
      review_id: string;
      revision: number;
      url: string;
      approved: boolean;
      /** The revision a person approved, kept on record after a request for changes reopened the review. */
      approved_revision?: number;
      /** True while a person's request for changes after approval waits for your next revision, which needs approving again. */
      reopened?: true;
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

/** One answer as Claude reads it: the option's ID and label, or the person's own words for "other". */
export type AskReply = {
  choice: string;
  label?: string;
  text?: string;
  /** True when the person pressed Go with your recommendation, so hoop took your recommended option. */
  recommended?: boolean;
  /** The person's note under the question. */
  note?: string;
  by: string;
  at: string;
  /** The earlier answer this one replaces, which you had already read. */
  corrects?: { choice: string; label?: string; text?: string };
};

/** A quick question as Claude reads it: its state, and each question with its latest answer. */
export type AskResult = {
  status: AskState;
  review_id: string;
  url: string;
  cursor: string;
  owner?: string;
  questions: { id: string; question: string; answer?: AskReply }[];
  withdrawn?: { reason: string; at: string };
  /** The review line the ask points at, as it read when asked. */
  anchor?: AskPlace;
};

/** What a person's answer did: the stored feedback, and whether it quietly replaced an answer Claude hadn't read yet. */
export type Answered = { feedback: Feedback; quiet: boolean };

/**
 * Where a session works, as the session itself sees it: its folder, that folder's git repository,
 * and the `.hoop` folder that keeps its reviews. A session sends it with each write, so the pages
 * process records the session's place, not its own.
 */
export type Place = { repo_dir: string; repo?: string; folder?: string };

/**
 * The operations behind the MCP tools and the CLI, independent of transport. A Hoop whose store is
 * writable runs in the pages process, the only writer; a session's or a command's Hoop has a
 * read-only store and a `remote` that sends its writes to the pages process.
 */
export class Hoop {
  readonly materializer: Materializer;
  readonly builds: Builds;
  private agent: Agent | null;
  /** Where this process's writes go when it isn't the pages process. */
  remote?: Remote;

  /**
   * `agent` is the session this process acts for (`agentFromEnv`); a string names a Claude Code
   * session. Without one (null), as in a person's terminal, hoop only reads. `where` is where the
   * session works, when the pages process acts for it; by default this process's own place.
   */
  constructor(
    readonly store = new Store(),
    agent: string | Agent | null = agentFromEnv() ?? null,
    private readonly where?: Place,
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

  /** The owner record for a session, named as it is now, with the Claude Code process it runs in. */
  private ownerOf(agent: Agent): Owner {
    return ownerOf(agent, this.store.home, agent.claude ? processOf(agent.session) : undefined);
  }

  /** Where a session's new reviews live: a Claude Code session's own folder when hoop can find it, else the hoop home folder. */
  private folderOf(agent: Agent): string | undefined {
    if (this.where) return this.where.folder;
    return agent.claude ? sessionHoop(agent.session) : undefined;
  }

  /** Where this process's session keeps its reviews and action items: its `.hoop` folder, or undefined for the hoop home folder. */
  sessionFolder(): string | undefined {
    return this.folderOf(this.needAgent());
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
   * Refuses an owner's action from another session, and makes this session
   * the owner of a review that has none. A review a person opened stays theirs.
   */
  private claim(id: string, action: "reply" | "propose"): ReviewMeta {
    const meta = this.store.meta(id);
    mustOwn(meta, this.session ?? undefined, action);
    return meta.owner || meta.opened_by ? this.noteOwnerId(meta) : this.store.update(id, { owner: this.ownerOf(this.needAgent()) });
  }

  /**
   * Records this session's ID among the owner's (`owners`) the first time it acts as the owner under
   * a new ID (`/clear`), so its comments stay the owner's after its process ends.
   */
  private noteOwnerId(meta: ReviewMeta): ReviewMeta {
    const s = this.session;
    if (!s || !meta.owner || meta.owner.session === s || meta.owners?.includes(s) || !actsAs(meta.owner, s)) return meta;
    return this.store.update(meta.id, { owners: [...(meta.owners ?? []), s] });
  }

  /**
   * Submits a document: a new review, or with `review_id` a new revision of it. `base` is the
   * revision the new text was built on (see `notStale`). `edited`, from section edits, means the
   * document's section IDs are set already, and names the sections it renamed. The result lists the
   * new revision's sections, so the agent can name them in section edits.
   */
  submit(input: unknown, base?: number, edited?: Edited["renamed"]): SubmitResult {
    const res = this.submitted(input, base, edited);
    return { ...res, sections: sectionList(this.store.revision(res.review_id)) };
  }

  private submitted(input: unknown, base?: number, edited?: Edited["renamed"]): SubmitResult {
    const v = validateReview(input);
    if (!v.ok) throw new HoopError("invalid review document", v.errors);
    const doc: ReviewDoc = v.value;
    const agent = this.needAgent();
    const session = agent.session;
    const place = this.place();
    if (!doc.review_id) return this.result(this.store.create(doc, { ...place, owner: this.ownerOf(agent) }, this.folderOf(agent)), "created");
    const id = existing(this.store, doc.review_id).id;
    const prior = this.store.meta(id);
    mustOwn(prior, session, "revise");
    notBuilding(prior);
    notAsk(prior, "revise");
    this.notStale(prior, base);
    // A session that took the review over under a new ID (`/clear`) becomes its owner, and keeps what
    // the old ID already read.
    if (prior.owner && prior.owner.session !== session) {
      const had = this.store.receipts(id);
      const read = Object.keys(had).filter((k) => had[k]!.sessions?.includes(prior.owner!.session));
      this.store.addReceipts(id, read, this.reader(), session);
    }
    // The owner's name is read again, so a session renamed since shows its new title.
    const owners =
      prior.owner && prior.owner.session !== session
        ? { owners: [...new Set([...(prior.owners ?? []), prior.owner.session])].filter((s) => s !== session) }
        : {};
    return this.revise(prior, doc, { ...place, owner: this.ownerOf(agent), ...owners }, this.folderOf(agent), edited);
  }

  /**
   * A new revision of a review made of `edits` to sections of revision `base`, which must be the
   * latest: all of them apply or none do (see `applySectionEdits`). Every other rule of a revision
   * holds as for `submit`.
   */
  reviseSections(reviewId: string, base: number, edits: SectionEdit[]): SubmitResult {
    const prior = this.store.meta(existing(this.store, reviewId).id);
    mustOwn(prior, this.needAgent().session, "revise");
    notBuilding(prior);
    notAsk(prior, "revise");
    this.notStale(prior, base);
    const { doc, renamed } = applySectionEdits(this.store.revision(prior.id), edits, this.highestSection(prior));
    return this.submit({ ...doc, review_id: prior.id }, base, renamed);
  }

  /**
   * Refuses a revision built on any revision but the latest (`base`, when given), or submitted over
   * reviews the agent hasn't received, on any revision: one left on revision 1 is easy to miss once
   * a reviewer's Apply makes revision 2. Only the owner session's receipts count: another session
   * reading the review doesn't read it for the owner. The refusal hands those reviews over in
   * `detail.unread`, shaped as hoop_feedback returns them, and records the owner's receipts, so the
   * agent reads them and submits again.
   */
  private notStale(prior: ReviewMeta, base: number | undefined): void {
    const latest = prior.revisions;
    const had = this.store.receipts(prior.id);
    const all = Array.from({ length: latest }, (_, r) => this.store.feedback(prior.id, r + 1).map((fb, i) => ({ fb, key: receiptKey(r + 1, i) })));
    const missed = all.flat().filter((f) => !receivedBy(had[f.key], prior.owner?.session));
    const behind = base !== undefined && base !== latest;
    if (!behind && !missed.length) return;
    this.store.addReceipts(
      prior.id,
      missed.map((f) => f.key),
      this.reader(),
      this.receivers(prior.id),
    );
    const unread = missed.map(({ fb }) => {
      const doc = this.store.revision(prior.id, fb.revision);
      return { ...fb, comments: fb.comments.map((c) => ({ ...c, scope: commentScope(doc, c) })) };
    });
    const why = [
      ...(behind ? [`it builds on revision ${base}, but revision ${latest} is the latest; read it with hoop_export and build on it`] : []),
      ...(unread.length ? [`it has ${unread.length} review${unread.length > 1 ? "s" : ""} you hadn't read, in detail.unread; read and answer them`] : []),
    ];
    throw new HoopError(`hoop didn't revise ${prior.id}: ${why.join("; ")}. Then submit again with base_revision ${latest}.`, [], {
      latest_revision: latest,
      unread,
    });
  }

  /**
   * A new revision of `prior`, or, when it is approved and so frozen, a new
   * review in `folder` that supersedes it. `extra` updates the review's metadata either way.
   */
  private revise(prior: ReviewMeta, doc: ReviewDoc, extra: Partial<ReviewMeta>, folder?: string, edited?: Edited["renamed"]): SubmitResult {
    if (prior.status === "approved") {
      const meta = this.store.create(doc, { ...extra, supersedes: prior.id }, folder);
      this.store.update(prior.id, { superseded_by: meta.id });
      return this.result(meta, "superseded");
    }
    // A document's sections keep their IDs across revisions, so comments stay on the same section;
    // section edits (`edited`) set them already.
    const before = this.store.revision(prior.id);
    const matched = edited ? { doc, renamed: edited } : doc.kind === "doc" ? matchSections(before, doc, this.highestSection(prior)) : { doc, renamed: {} };
    const revised = this.store.addRevision(prior.id, matched.doc);
    this.store.saveRenamed(prior.id, revised.revisions, matched.renamed);
    // hoop, not the agent, says what changed, so a section dropped by mistake shows.
    const changes = revisionChanges(before, this.store.revision(prior.id), prior.revisions);
    // The owner's revision answers a reopening; a reviewer's Apply makes a revision without answering it.
    return { ...this.result(this.store.update(prior.id, { ...extra, reopened: undefined }), "revised"), ...(changes ? { changes } : {}) };
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
    const meta = this.store.meta(prior.id);
    if (meta.source?.sha256 === source.sha256) return this.result(meta, "unchanged");
    return this.revise(meta, doc, extra);
  }

  /** The folder the session works in, and its git repository: details on a review. */
  private place(): Pick<ReviewMeta, "repo_dir" | "repo"> {
    if (this.where) return { repo_dir: this.where.repo_dir, ...(this.where.repo ? { repo: this.where.repo } : {}) };
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
    this.builds.create(meta.id, markdown, "claude");
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
    if (c.op === "remove") {
      if (c.section !== undefined && typeof c.section !== "boolean") throw new HoopError("expected section: true or false");
      return this.builds.change(meta.id, { op: "remove", block: str("block"), ...(c.section ? { section: true } : {}) });
    }
    if (c.op === "generate")
      return this.builds.change(meta.id, { op: "generate", block: str("block"), ...(c.note !== undefined ? { note: str("note") } : {}) });
    if (c.op === "suggest")
      return this.builds.change(meta.id, {
        op: "suggest",
        block: str("block"),
        kind: str("kind") as Suggestion,
        ...(c.note !== undefined ? { note: str("note") } : {}),
      });
    if (c.op === "accept" || c.op === "dismiss") return this.builds.change(meta.id, { op: c.op, proposal: str("proposal") });
    if (c.op === "retitle") return this.builds.change(meta.id, { op: "retitle", proposal: str("proposal"), title: str("title") });
    if (c.op === "accept_all") return this.builds.change(meta.id, { op: "accept_all", request: str("request") });
    if (c.op === "undo") return this.builds.change(meta.id, { op: "undo", block: str("block") });
    if (c.op === "rewrite") return this.builds.change(meta.id, { op: "rewrite", block: str("block"), ...(c.note !== undefined ? { note: str("note") } : {}) });
    if (c.op === "comment")
      return this.builds.change(meta.id, {
        op: "comment",
        block: str("block"),
        comment: str("comment"),
        ...(c.selection !== undefined ? { selection: str("selection") } : {}),
        ...(c.occurrence !== undefined ? { occurrence: Number(c.occurrence) } : {}),
      });
    if (c.op === "resolve") return this.builds.change(meta.id, { op: "resolve", thread: str("thread") });
    if (c.op === "accept_change" || c.op === "undo_change") return this.builds.change(meta.id, { op: c.op, block: str("block") });
    throw new HoopError(EXPECTED_OP);
  }

  /**
   * The person's Finish: the build's markdown becomes the review's next revision, and the build page
   * becomes the review page. Sections keep their IDs by heading, as in any revision.
   */
  finishBuild(id: string): SubmitResult {
    const meta = existing(this.store, id);
    const now = this.store.meta(meta.id);
    if (now.build !== "open") throw new HoopError(`${meta.id} is not a document being built`);
    const build = this.builds.read(meta.id);
    // Claude's rewrites waiting on the person would otherwise go into the review unseen.
    const here = new Set(build.blocks.map((b) => b.id));
    const waiting = (build.changes ?? []).filter((c) => c.blocks.some((b) => here.has(b))).length;
    if (waiting) throw new HoopError(`Accept or undo Claude's ${waiting} waiting ${waiting === 1 ? "change" : "changes"} first`);
    // Everything is resolved before a review starts, comments included.
    const open = (build.threads ?? []).filter((t) => t.status === "open").length;
    if (open) throw new HoopError(`Resolve ${open} open ${open === 1 ? "comment" : "comments"} first`);
    const doc = parseMarkdown(joinBlocks(build));
    const v = validateReview(doc);
    if (!v.ok) throw new HoopError("the document can't be reviewed yet", v.errors);
    const matched = matchSections(this.store.revision(meta.id), v.value, this.highestSection(now));
    const revised = this.store.addRevision(meta.id, matched.doc);
    this.store.saveRenamed(meta.id, revised.revisions, matched.renamed);
    this.builds.save(meta.id, this.builds.read(meta.id), "person", "finished the build");
    return this.result(this.store.update(meta.id, { build: undefined }), "revised");
  }

  /** The highest section number any revision of the review used, so a new section never takes a deleted one's ID and its comments. */
  private highestSection(meta: ReviewMeta): number {
    return highestSection(Array.from({ length: meta.revisions }, (_, r) => this.store.revision(meta.id, r + 1)));
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

  /** Claude's suggested headings for a suggestion request on a build. Only the build's owner may suggest. */
  buildSuggest(id: string, request: string, headings: SuggestedHeading[]): Build {
    return this.builds.suggest(this.ownBuild(id).id, request, headings);
  }

  /** Claude's text for a section of a build. Only the build's owner may write. */
  buildWrite(id: string, section: string, markdown: string): Build {
    return this.builds.write(this.ownBuild(id).id, section, markdown);
  }

  /** Claude's new text for one block of a build, for Generate again. Only the build's owner may write. */
  buildWriteBlock(id: string, block: string, markdown: string, request?: string): Build {
    return this.builds.writeBlock(this.ownBuild(id).id, block, markdown, request);
  }

  /** The markdown of a review's latest revision, or of a build as it stands. */
  markdownOf(id: string): string {
    const meta = existing(this.store, id);
    return meta.build === "open" ? joinBlocks(this.builds.read(meta.id)) : exportMarkdown(this.store.revision(meta.id));
  }

  private result(meta: ReviewMeta, outcome: SubmitResult["outcome"]): SubmitResult {
    // A revision repeats the threads still unanswered, so a missed comment shows when Claude thinks it's done.
    // Only for a session's own revision: `hoop open` at a terminal revises a review no session answers.
    const unanswered = outcome === "revised" && meta.owner ? (this.threads(meta.id).threads ?? []).filter((t) => t.status === "unanswered").map(brief) : [];
    const list = unanswered.map((t) => `${t.thread} (revision ${t.revision})`).join(", ");
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
      ...(unanswered.length
        ? {
            unanswered_threads: unanswered,
            reminder: `${unanswered.length} ${unanswered.length === 1 ? "thread is" : "threads are"} still unanswered: ${list}. Answer each with hoop_reply, saying how this revision addresses it, or propose edits with hoop_propose_edits.`,
          }
        : {}),
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
      ...(meta.approved_revision ? { approved_revision: meta.approved_revision } : {}),
      ...(isReopened(meta) ? { reopened: true as const } : {}),
    };
    const doc = this.store.revision(meta.id);
    // Each comment says what its edits may change.
    const feedback = this.store.feedback(meta.id).map((f) => ({ ...f, comments: f.comments.map((c) => ({ ...c, scope: commentScope(doc, c) })) }));
    const applied = this.store.applied(meta.id);
    const proposals = this.store.proposals(meta.id);
    const extra = { ...(applied.length ? { applied } : {}), ...(proposals.length ? { edits: proposals } : {}), ...this.threads(meta.id) };
    if (!feedback.length && meta.status === "open") return { status: "pending", ...base, ...extra };
    return {
      status: "reviewed",
      ...base,
      approved: meta.status === "approved",
      feedback,
      ...extra,
    };
  }

  /** A review's comment threads from every revision (`Threads`); none on a quick question or a build. */
  threads(id: string): Threads {
    const meta = this.store.meta(id);
    if (meta.ask || meta.build === "open") return {};
    const all = threadViews(this.store, id);
    const open = all.filter((t) => t.status !== "resolved");
    const resolved = all.filter((t) => t.status === "resolved").map(brief);
    return { ...(open.length ? { threads: open } : {}), ...(resolved.length ? { resolved } : {}) };
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
    this.store.addReceipts(result.review_id, keys, this.reader(), this.receivers(result.review_id));
    return result;
  }

  /**
   * The sessions a receipt from this process names: its own, and the owner's too when this session
   * acts as the owner under a new ID (`/clear`), so its read counts as the owner's.
   */
  private receivers(id: string): string[] | undefined {
    if (!this.session) return undefined;
    const owner = this.store.meta(id).owner;
    return owner && owner.session !== this.session && actsAs(owner, this.session) ? [this.session, owner.session] : [this.session];
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
    const meta = reviewable(this.store, reviewId);
    notAsk(meta, "review");
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
    afterApproval(meta, all.value, fromPage);
    checkVerdict(this.store, meta.id, all.value, fromPage);
    approvable(this.store, meta.id, all.value);
    const stored = this.store.addFeedback(meta.id, all.value);
    if (stored.verdict === "approved") this.store.update(meta.id, { status: "approved", approved_at: stored.at, approved_revision: meta.revisions });
    // A person's request for changes after approval reopens the review; the approval stays on record.
    else if (meta.status === "approved")
      this.store.update(meta.id, { status: "open", reopened: true, reopened_at: stored.at, approved_revision: meta.approved_revision ?? meta.revisions });
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
    const stored = this.review(reviewId, {
      verdict: "comment",
      reviewer: sessionLabel(owner),
      session: { id: owner.session, ...(owner.name ? { name: owner.name } : {}) },
      comments: [comment],
    });
    // Only a comment hoop took records this session among the owner's IDs.
    this.noteOwnerId(this.store.meta(stored.review_id));
    return stored;
  }

  /** Applies a reviewer's exact suggestion as a new revision. */
  applySuggestion(reviewId: string, thread: string, by = currentUser()) {
    return this.materializer.applySuggestion(reviewId, thread, by);
  }

  /** The agent's span edits for a comment, shown to the reviewer as tracked changes. Only the review's owner may propose. */
  proposeEdits(reviewId: string, thread: string, edits: unknown, note?: string) {
    this.claim(existing(this.store, reviewId).id, "propose");
    return this.materializer.proposeEdits(reviewId, thread, edits, note);
  }

  /** Where a proposed edit sits in the latest revision, or null if its text has changed. */
  editPosition(reviewId: string, p: Proposal) {
    return this.materializer.editPosition(reviewId, p);
  }

  /** Why each suggested removal on a review can't be applied now (null when it can), by thread: the rule Apply checks. */
  removalRefusals(reviewId: string): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const f of this.store.allFeedback(reviewId))
      for (const c of f.comments) if (c.remove && c.thread) out[c.thread] = this.materializer.removalRefusal(reviewId, c.item, f.revision) ?? null;
    return out;
  }

  /** The reviewer's accept or reject of a proposed edit. */
  decideEdit(reviewId: string, editId: string, action: "accept" | "reject", by = currentUser()) {
    return this.materializer.decideEdit(reviewId, editId, action, by);
  }

  /** The owner's reply in a comment thread, named after the owner's session; on a review a person opened, after the replying session. */
  reply(thread: string, body: string) {
    if (!body.trim()) throw new HoopError("a reply needs text");
    // A comment on a build's block: only the build's owner replies, beside the block.
    const onBuild = thread.match(/^bt_([a-z0-9]+)_\d+$/);
    if (onBuild) {
      const id = this.ownBuild(`rv_${onBuild[1]}`).id;
      const build = this.builds.reply(id, thread, body);
      return { review_id: id, thread, author: "claude", body: body.trim(), at: build.steps.at(-1)!.at };
    }
    const id = this.store.findThread(thread);
    if (!id) throw new HoopError(`no thread ${thread}`);
    const meta = this.claim(id, "reply");
    const reply = { thread, author: sessionLabel(meta.owner ?? this.ownerOf(this.needAgent())), body, at: new Date().toISOString() };
    this.store.addReply(id, reply);
    return { review_id: id, ...reply };
  }

  /**
   * Asks the person one to four quick questions, each with two to four options and one recommended.
   * The ask is a review of kind `questions` that only people answer, on its page.
   */
  ask(input: unknown): AskResult {
    const parsed = Ask.safeParse(input);
    if (!parsed.success)
      throw new HoopError(
        "invalid questions",
        parsed.error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message })),
      );
    const errors = parsed.data.questions.flatMap((q, i) =>
      q.options.filter((o) => o.recommended).length === 1 ? [] : [{ path: `questions.${i}.options`, message: "mark exactly one option recommended" }],
    );
    if (errors.length) throw new HoopError("invalid questions", errors);
    const agent = this.needAgent();
    const items: Item[] = parsed.data.questions.map((q, i) => ({
      id: `Q${i + 1}`,
      type: "question",
      title: q.question,
      ...(q.context ? { body: q.context } : {}),
      choices: q.options.map((o, j) => ({ id: "ABCD"[j]!, label: o.label, ...(o.recommended ? { recommended: true } : {}) })),
    }));
    const first = parsed.data.questions[0]!;
    const doc: ReviewDoc = {
      schema: "hoop/review@0",
      kind: "questions",
      slug: slugify(first.question, { max: 64, fallback: "question", trimEnd: true }),
      title: first.question,
      tldr: (first.context || first.question).slice(0, 600),
      items,
    };
    const anchor = parsed.data.anchor ? this.askPlace(parsed.data.anchor) : undefined;
    const meta = this.store.create(doc, { ...this.place(), owner: this.ownerOf(agent), ask: anchor ? { anchor } : {} }, this.folderOf(agent));
    return this.askResult(meta.id);
  }

  /**
   * The review line a quick question points at, from `words` (with `item` to narrow them) or from
   * `item` and `line`, in the review's latest revision. Refused unless the review exists, can be
   * read, and is open: not approved, not being built, and not itself a quick question.
   */
  private askPlace(a: AskAnchor): AskPlace {
    const refuse = (message: string, path = "anchor.review_id") => new HoopError(message, [{ path, message }]);
    let meta: ReviewMeta, doc: ReviewDoc;
    try {
      meta = this.store.meta(a.review_id);
      doc = this.store.revision(meta.id);
    } catch {
      throw refuse(`no review ${a.review_id} that this session can read`);
    }
    if (meta.ask) throw refuse(`${meta.id} is a quick question; point at a line in a review`);
    if (meta.build === "open") throw refuse(`${meta.id} is a document being built on the page; ask once it is a review`);
    if (meta.status === "approved") throw refuse(`${meta.id} is approved and frozen; ask without pointing at it`);
    const at = { review_id: meta.id, revision: meta.revisions };
    if (a.words !== undefined) {
      const q = resolveQuote(doc, { item: a.item, words: a.words }, { path: "anchor.words" });
      return { ...at, ...q, text: anchorText(doc, q.item, q.line)! };
    }
    if (a.item === undefined || a.line === undefined) throw refuse("point at the line with words, or with item and line", "anchor.line");
    if (anchorText(doc, a.item, a.line) === undefined) {
      const it = doc.items.find((i) => i.id === a.item);
      if (a.item !== DOC && !it) throw refuse(`${meta.id} has no item ${a.item}`, "anchor.item");
      throw refuse(`${a.item} has lines ${a.item === DOC ? docLines(doc) : `0-${itemLines(it!).length}`}`, "anchor.line");
    }
    return { ...at, item: a.item, line: a.line, text: anchorText(doc, a.item, a.line)! };
  }

  /** A quick question with each question's latest answer, as Claude reads it. */
  askResult(id: string): AskResult {
    const meta = this.store.meta(id);
    const doc = this.store.revision(meta.id, 1);
    const answers = askAnswers(this.store, meta.id);
    const labelOf = (q: Item, choice: string) => q.choices?.find((c) => c.id === choice)?.label;
    const reply = (q: Item, a: AskAnswer): AskReply => ({
      choice: a.choice,
      ...(a.choice === "other" ? { text: a.text } : { label: labelOf(q, a.choice) }),
      ...(a.recommended ? { recommended: true } : {}),
      ...(a.note ? { note: a.note } : {}),
      by: a.by,
      at: a.at,
      ...(a.corrects
        ? { corrects: { choice: a.corrects.choice, ...(a.corrects.choice === "other" ? { text: a.corrects.text } : { label: labelOf(q, a.corrects.choice) }) } }
        : {}),
    });
    return {
      status: askState(this.store, meta),
      review_id: meta.id,
      url: reviewUrl(meta.id),
      cursor: cursorOf(this, meta.id),
      ...(meta.owner ? { owner: this.ownerLabel(meta.owner) } : {}),
      questions: doc.items.map((q) => {
        const a = answers.get(q.id)?.at(-1);
        return { id: q.id, question: q.title, ...(a ? { answer: reply(q, a) } : {}) };
      }),
      ...(meta.ask?.withdrawn ? { withdrawn: meta.ask.withdrawn } : {}),
      ...(meta.ask?.anchor ? { anchor: meta.ask.anchor } : {}),
    };
  }

  /**
   * A quick question's answers as the asking session receives them, with a receipt for each answer,
   * so the page shows that Claude read them. Only the session that asked may read them.
   */
  receiveAsk(id: string): AskResult {
    const meta = mustAsk(this.store, id, this.session ?? undefined);
    const keys = this.store.feedback(meta.id, 1).map((_, i) => receiptKey(1, i));
    const have = this.store.receipts(meta.id);
    if (keys.some((k) => !have[k])) this.store.addReceipts(meta.id, keys, this.reader(), this.receivers(meta.id));
    return this.askResult(meta.id);
  }

  /**
   * A person's answer to a quick question, from its page: one question's option (`choice`, or
   * "other" with `text`) with an optional note, or, with `recommended: true`, the recommended option
   * for every question still unanswered. A changed answer that Claude already read is a correction
   * (`corrects`); one it hadn't read replaces the earlier answer quietly.
   */
  answer(id: string, input: Record<string, unknown>): Answered {
    const meta = existing(this.store, id);
    if (!meta.ask) throw new HoopError(`${meta.id} is a review, not a quick question`);
    if (meta.ask.withdrawn) throw new HoopError(`Claude withdrew this question: ${meta.ask.withdrawn.reason}`);
    const doc = this.store.revision(meta.id, 1);
    const answers = askAnswers(this.store, meta.id);
    const receipts = this.store.receipts(meta.id);
    let given: Feedback["answers"];
    let quiet = false;
    if (input.recommended === true) {
      given = doc.items
        .filter((q) => !answers.get(q.id)?.length)
        .map((q) => ({ item: q.id, choice: q.choices!.find((c) => c.recommended)!.id, recommended: true }));
      if (!given.length) throw new HoopError("every question already has an answer");
    } else {
      const q = doc.items.find((i) => i.id === input.question);
      if (!q) throw new HoopError(`no question ${String(input.question)}`, [{ path: "question", message: `one of ${doc.items.map((i) => i.id).join(", ")}` }]);
      if (typeof input.choice !== "string") throw new HoopError("expected a choice", [{ path: "choice", message: "required" }]);
      const text = input.choice === "other" && typeof input.text === "string" ? input.text.trim() : undefined;
      const prev = answers.get(q.id)?.at(-1);
      if (prev && prev.choice === input.choice && (prev.text ?? "") === (text ?? "")) throw new HoopError("that is already the answer");
      const read = prev && receipts[prev.key];
      quiet = Boolean(prev && !read);
      given = [
        {
          item: q.id,
          choice: input.choice,
          ...(text !== undefined ? { text } : {}),
          ...(read ? { corrects: { choice: prev.choice, ...(prev.text !== undefined ? { text: prev.text } : {}) } } : {}),
        },
      ];
    }
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : undefined;
    const v = validateFeedback(
      {
        schema: "hoop/feedback@0",
        review_id: meta.id,
        revision: 1,
        verdict: "comment",
        ...(note ? { summary: note } : {}),
        answers: given,
        reviewer: currentUser(),
        at: new Date().toISOString(),
      },
      doc,
    );
    if (!v.ok) throw new HoopError("invalid answer", v.errors);
    return { feedback: this.store.addFeedback(meta.id, v.value), quiet };
  }

  /** Withdraws an unanswered quick question with a one-line reason. Only the session that asked may. */
  withdraw(id: string, reason: string): AskResult {
    const meta = mustAsk(this.store, id, this.session ?? undefined);
    const why = reason.trim();
    if (!why || why.includes("\n")) throw new HoopError("give a one-line reason", [{ path: "reason", message: "one line of text" }]);
    const state = askState(this.store, meta);
    if (state === "withdrawn") throw new HoopError(`${meta.id} is already withdrawn`);
    if (state !== "open") throw new HoopError(`every question in ${meta.id} has an answer already; read it with hoop_feedback`);
    this.store.update(meta.id, { ask: { ...meta.ask, withdrawn: { reason: why, at: new Date().toISOString() } } });
    return this.askResult(meta.id);
  }
}
