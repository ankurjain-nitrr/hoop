import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Feedback, ReviewDoc } from "./contract.js";
import { withLock } from "./lock.js";
import type { Owner } from "./owner.js";
import { hoopHome, writeAtomic } from "./util.js";

export type ReviewMeta = {
  id: string;
  slug: string;
  title: string;
  status: "open" | "approved";
  revisions: number;
  created: string;
  updated: string;
  repo_dir?: string;
  supersedes?: string;
  /** The review that replaced this approved one. */
  superseded_by?: string;
  approved_at?: string;
  /** The Claude Code session that submitted the review; only it may revise the review, reply or propose edits. */
  owner?: Owner;
};

export type Reply = { thread: string; author: string; body: string; at: string };

/** An edit Claude proposed for a comment thread; the reviewer accepts or rejects it. */
export type Proposal = {
  id: string;
  thread: string;
  revision: number;
  item: string;
  line: number;
  find: string;
  replace: string;
  /** The line's text when proposed; the edit applies only while the line still reads exactly this. */
  start: number;
  line_text: string;
  note?: string;
  at: string;
  words: { removed: number; added: number; line_words: number; large: boolean };
  status: "proposed" | "accepted" | "rejected";
  decided_by?: string;
  decided_at?: string;
  applied_revision?: number;
};

/** A comment materialized into the document: which thread, which revision it produced, by whom. */
export type Applied = {
  thread: string;
  revision: number;
  by: string;
  at: string;
  kind: "suggestion" | "edit";
  item: string;
  line: number;
  find: string;
  replace: string;
  edit_id?: string;
};

/**
 * Reviews as JSON files: <home>/reviews/<id>/{review.json, rev-N.json, feedback-N.json, replies.json},
 * with each revision's renamed sections (renamed-N.json) beside it.
 */
export class Store {
  readonly root: string;

  constructor(home = hoopHome()) {
    this.root = join(home, "reviews");
    mkdirSync(this.root, { recursive: true });
  }

  private dir(id: string) {
    if (!/^rv_[a-z0-9]+$/.test(id)) throw new Error(`invalid review id ${id}`);
    return join(this.root, id);
  }

  /**
   * Runs `fn` holding the review's lock, a `.lock` file in its folder, so that read-modify-writes
   * from several processes (sessions, commands, the pages) never lose a write. Re-entrant.
   */
  lock<T>(id: string, fn: () => T): T {
    const dir = this.dir(id);
    if (!existsSync(dir)) throw new Error(`no review ${id}`);
    return withLock(join(dir, ".lock"), fn);
  }

  /** The hoop folder this store lives in; it also holds the user's `config.json`. */
  get home(): string {
    return dirname(this.root);
  }

  /** Keeps the sections a revision matched by place, each with its old heading, beside the revision. */
  saveRenamed(id: string, revision: number, renamed: Record<string, string>): void {
    if (Object.keys(renamed).length) this.write(join(this.dir(id), `renamed-${revision}.json`), renamed);
  }

  /** The sections a revision matched by place, by ID, with their old headings. */
  renamed(id: string, revision = this.meta(id).revisions): Record<string, string> {
    return this.read<Record<string, string>>(join(this.dir(id), `renamed-${revision}.json`), {});
  }

  private read<T>(path: string, fallback: T): T {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  }

  private write(path: string, value: unknown) {
    writeAtomic(path, JSON.stringify(value, null, 2) + "\n");
  }

  create(doc: ReviewDoc, extra: Partial<ReviewMeta> = {}): ReviewMeta {
    const id = `rv_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    mkdirSync(this.dir(id));
    const now = new Date().toISOString();
    const meta: ReviewMeta = {
      id,
      slug: doc.slug,
      title: doc.title,
      status: "open",
      revisions: 0,
      created: now,
      updated: now,
      ...extra,
    };
    this.write(join(this.dir(id), "review.json"), meta);
    return this.addRevision(id, doc);
  }

  addRevision(id: string, doc: ReviewDoc): ReviewMeta {
    return this.lock(id, () => this.writeRevision(id, doc));
  }

  private writeRevision(id: string, doc: ReviewDoc): ReviewMeta {
    const meta = this.meta(id);
    meta.revisions += 1;
    meta.title = doc.title;
    meta.updated = new Date().toISOString();
    this.write(join(this.dir(id), `rev-${meta.revisions}.json`), { ...doc, review_id: id, revision: meta.revisions });
    this.write(join(this.dir(id), "review.json"), meta);
    return meta;
  }

  update(id: string, patch: Partial<ReviewMeta>): ReviewMeta {
    return this.lock(id, () => {
      const meta = { ...this.meta(id), ...patch, updated: new Date().toISOString() };
      this.write(join(this.dir(id), "review.json"), meta);
      return meta;
    });
  }

  /** Marks a review as updated, so lists sort it first and waiters see a change. */
  touch(id: string): ReviewMeta {
    return this.update(id, {});
  }

  meta(id: string): ReviewMeta {
    const meta = this.read<ReviewMeta | null>(join(this.dir(id), "review.json"), null);
    if (!meta) throw new Error(`no review ${id}`);
    return meta;
  }

  revision(id: string, n = this.meta(id).revisions): ReviewDoc {
    const doc = this.read<ReviewDoc | null>(join(this.dir(id), `rev-${n}.json`), null);
    if (!doc) throw new Error(`review ${id} has no revision ${n}`);
    return doc;
  }

  /** Feedback submitted on revision n, oldest first. */
  feedback(id: string, n = this.meta(id).revisions): Feedback[] {
    return this.read<Feedback[]>(join(this.dir(id), `feedback-${n}.json`), []);
  }

  allFeedback(id: string): Feedback[] {
    const meta = this.meta(id);
    return Array.from({ length: meta.revisions }, (_, i) => this.feedback(id, i + 1)).flat();
  }

  addFeedback(id: string, fb: Feedback): Feedback {
    return this.lock(id, () => {
      const list = this.feedback(id, fb.revision);
      // Thread ids embed the review id, so a thread id alone identifies its review.
      let n = this.allFeedback(id).reduce((sum, f) => sum + f.comments.length, 0);
      const stored = { ...fb, comments: fb.comments.map((c) => ({ ...c, thread: c.thread ?? `th_${id.slice(3)}_${++n}` })) };
      this.write(join(this.dir(id), `feedback-${fb.revision}.json`), [...list, stored]);
      this.touch(id);
      return stored;
    });
  }

  applied(id: string): Applied[] {
    return this.read<Applied[]>(join(this.dir(id), "applied.json"), []);
  }

  addApplied(id: string, rec: Applied) {
    this.lock(id, () => this.write(join(this.dir(id), "applied.json"), [...this.applied(id), rec]));
  }

  proposals(id: string): Proposal[] {
    return this.read<Proposal[]>(join(this.dir(id), "proposals.json"), []);
  }

  /** Writes the whole list of proposals; the caller holds the lock from its read of the list to here. */
  writeProposals(id: string, list: Proposal[]) {
    this.lock(id, () => {
      this.write(join(this.dir(id), "proposals.json"), list);
      this.touch(id);
    });
  }

  replies(id: string): Reply[] {
    return this.read<Reply[]>(join(this.dir(id), "replies.json"), []);
  }

  addReply(id: string, reply: Reply) {
    this.lock(id, () => {
      this.write(join(this.dir(id), "replies.json"), [...this.replies(id), reply]);
      this.touch(id);
    });
  }

  /** The review that owns a thread id. */
  findThread(thread: string): string | undefined {
    const local = thread.match(/^th_([a-z0-9]+)_\d+$/);
    const candidates = local ? [`rv_${local[1]}`].filter((id) => existsSync(join(this.root, id))) : [];
    return candidates.find((id) => this.allFeedback(id).some((f) => f.comments.some((c) => c.thread === thread)));
  }

  list(): ReviewMeta[] {
    return readdirSync(this.root)
      .filter((d) => d.startsWith("rv_") && existsSync(join(this.root, d, "review.json")))
      .map((d) => this.meta(d))
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }
}
