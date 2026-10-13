import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Feedback, ReviewDoc } from "./contract.js";

export type ReviewMeta = {
  id: string;
  slug: string;
  title: string;
  channel: "local" | "github";
  status: "open" | "approved";
  revisions: number;
  created: string;
  updated: string;
  repo_dir?: string;
  github?: { repo: string; pr: number; branch: string; url: string };
  supersedes?: string;
  decision_files?: string[];
};

export type Reply = { thread: string; author: string; body: string; at: string };

/** Reviews as JSON files: <home>/reviews/<id>/{review.json, rev-N.json, feedback-N.json, replies.json}. */
export class Store {
  readonly root: string;

  constructor(home = process.env.HOOP_HOME ?? join(homedir(), ".hoop")) {
    this.root = join(home, "reviews");
    mkdirSync(this.root, { recursive: true });
  }

  private dir(id: string) {
    if (!/^rv_[a-z0-9]+$/.test(id)) throw new Error(`invalid review id ${id}`);
    return join(this.root, id);
  }

  private read<T>(path: string, fallback: T): T {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  }

  private write(path: string, value: unknown) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, path); // atomic, so a reader never sees half a file
  }

  create(doc: ReviewDoc, extra: Partial<ReviewMeta> = {}): ReviewMeta {
    const id = `rv_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    mkdirSync(this.dir(id));
    const now = new Date().toISOString();
    const meta: ReviewMeta = {
      id, slug: doc.slug, title: doc.title, channel: doc.channel, status: "open",
      revisions: 0, created: now, updated: now, ...extra,
    };
    this.write(join(this.dir(id), "review.json"), meta);
    return this.addRevision(id, doc);
  }

  addRevision(id: string, doc: ReviewDoc): ReviewMeta {
    const meta = this.meta(id);
    meta.revisions += 1;
    meta.title = doc.title;
    meta.updated = new Date().toISOString();
    this.write(join(this.dir(id), `rev-${meta.revisions}.json`), { ...doc, review_id: id, revision: meta.revisions });
    this.write(join(this.dir(id), "review.json"), meta);
    return meta;
  }

  update(id: string, patch: Partial<ReviewMeta>): ReviewMeta {
    const meta = { ...this.meta(id), ...patch, updated: new Date().toISOString() };
    this.write(join(this.dir(id), "review.json"), meta);
    return meta;
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
    const list = this.feedback(id, fb.revision);
    let n = this.allFeedback(id).reduce((sum, f) => sum + f.comments.length, 0);
    const stored = { ...fb, comments: fb.comments.map((c) => ({ ...c, thread: c.thread ?? `th_${++n}` })) };
    this.write(join(this.dir(id), `feedback-${fb.revision}.json`), [...list, stored]);
    this.update(id, {});
    return stored;
  }

  replies(id: string): Reply[] {
    return this.read<Reply[]>(join(this.dir(id), "replies.json"), []);
  }

  addReply(id: string, reply: Reply) {
    this.write(join(this.dir(id), "replies.json"), [...this.replies(id), reply]);
    this.update(id, {});
  }

  /** The review that owns a thread id. */
  findThread(thread: string): string | undefined {
    return this.list().find((m) => this.allFeedback(m.id).some((f) => f.comments.some((c) => c.thread === thread)))?.id;
  }

  list(): ReviewMeta[] {
    return readdirSync(this.root)
      .filter((d) => d.startsWith("rv_") && existsSync(join(this.root, d, "review.json")))
      .map((d) => this.meta(d))
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }
}
