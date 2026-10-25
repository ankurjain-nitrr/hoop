import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Feedback, ReviewDoc } from "./contract.js";
import type { Owner } from "./owner.js";
import { migrateHome } from "./migrate.js";
import { Registry } from "./registry.js";
import { hoopHome, writeAtomic } from "./util.js";

export type ReviewMeta = {
  id: string;
  slug: string;
  title: string;
  status: "open" | "approved";
  revisions: number;
  created: string;
  updated: string;
  /** The folder the submitting session worked in. */
  repo_dir?: string;
  /** The top folder of the git repository that holds `repo_dir`, when there is one. */
  repo?: string;
  supersedes?: string;
  /** The review that replaced this approved one. */
  superseded_by?: string;
  approved_at?: string;
  /**
   * The revision a person approved. It stays when a person's request for changes reopens the review
   * (`reopened_at`), so the approval stays on record, and the next revision needs approving again.
   */
  approved_revision?: number;
  /** When a person's request for changes reopened the approved review. */
  reopened_at?: string;
  /** True from a person's request for changes after approval until the owner's next revision; a reviewer's Apply keeps it. */
  reopened?: true;
  /** The Claude Code session that submitted the review; only it may revise the review, reply or propose edits. */
  owner?: Owner;
  /** The owner's other session IDs, from before or since `/clear` gave it a new one; their comments are the owner's. */
  owners?: string[];
  /** The person who opened the review from a file with `hoop open`; such a review has no owner session. */
  opened_by?: string;
  /** The file `hoop open` read, and the SHA-256 of its text then; opening it again revises the review when it changed. */
  source?: { path: string; sha256: string };
  /** "open" while the person and Claude build the document on the page (`build.json`), before it is reviewed. */
  build?: "open";
  /**
   * Set on a quick question (`hoop_ask`): a review of kind `questions` whose answers are feedback
   * entries with only `answers`. Its state (`askState` in rules.ts) follows from its answers and
   * receipts, and from `withdrawn`, Claude's reason when it withdrew the ask. `anchor` is the review
   * line it points at, as it read in that review's revision `revision`; the line's card carries
   * across later revisions the way comment threads do.
   */
  ask?: { withdrawn?: { reason: string; at: string }; anchor?: AskPlace };
};

/** The review line a quick question points at: item and line as comments anchor them, and the words when it named them. */
export type AskPlace = {
  review_id: string;
  item: string;
  line: number;
  revision: number;
  /** The line's text in that revision. */
  text: string;
  range?: { start: number; end: number; quote: string };
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
  kind: "suggestion" | "edit" | "remove";
  item: string;
  line: number;
  find: string;
  replace: string;
  edit_id?: string;
};

/**
 * When the agent first received one submitted review, and who received it: a session label, or "agent".
 * `sessions` lists every session that has received it; a receipt from before it was kept has none.
 */
export type Receipt = { at: string; by: string; sessions?: string[] };

/** A diagram the review page couldn't draw: the library's error, and when the page reported it. */
export type DiagramError = { message: string; at: string };

/**
 * Whether `session` (a review's owner) received a review: any receipt counts for a review without an
 * owner, and for a receipt from before receipts named their sessions.
 */
export const receivedBy = (r: Receipt | undefined, session: string | undefined): boolean =>
  Boolean(r) && (!session || !r!.sessions || r!.sessions.includes(session));

/**
 * How a person's submitted review reached the session that owns the review: `sent` over its messaging
 * socket, taken by a wait that was running (`waiting`), `no_session` when no live session takes
 * messages, or `failed` with the reason.
 */
export type Delivery = { outcome: "sent" | "waiting" | "no_session" | "failed"; at: string; error?: string };

/** A submitted review's key in receipts: `<revision>.<index>`, its place in that revision's feedback. */
export const receiptKey = (revision: number, index: number) => `${revision}.${index}`;

/**
 * Reviews as JSON files: <folder>/reviews/<id>/{review.json, rev-N.json, feedback-N.json, replies.json,
 * receipts.json, deliveries.json}, with each revision's renamed sections (renamed-N.json) beside it. The folder is the
 * `.hoop` in a Claude Code session's folder, found through the home folder's index, or else the hoop
 * home folder.
 *
 * Only the pages process writes these files (docs/DESIGN.md, "One writer"). A store opened with
 * `readOnly`, as sessions and commands open it, refuses every write.
 */
export class Store {
  /** The home folder's own reviews: those from outside any session, and those not moved yet. */
  readonly root: string;
  readonly registry: Registry;
  readonly readOnly: boolean;

  /** `migrate: false` leaves reviews from earlier releases where they are; `readOnly` refuses writes (and doesn't migrate). */
  constructor(home = hoopHome(), opts: { migrate?: boolean; readOnly?: boolean } = {}) {
    this.root = join(home, "reviews");
    this.readOnly = opts.readOnly === true;
    this.registry = new Registry(home);
    if (this.readOnly) return;
    mkdirSync(this.root, { recursive: true });
    // The pages process opens the writable store, detached with no output, so what moved goes to its log too.
    if (opts.migrate !== false)
      migrateHome(home, {
        report: (text) => {
          process.stderr.write(`hoop: ${text}\n`);
          try {
            appendFileSync(join(home, "pages.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event: "migrated", message: text })}\n`);
          } catch {
            /* the log is best effort */
          }
        },
      });
  }

  /** Refuses a write in a store opened read-only. */
  private writable() {
    if (this.readOnly) throw new Error("only hoop's pages process writes its files; send the write to it");
  }

  private dir(id: string) {
    if (!/^rv_[a-z0-9]+$/.test(id)) throw new Error(`invalid review id ${id}`);
    const folder = this.registry.folderOf(id);
    return folder ? join(folder, "reviews", id) : join(this.root, id);
  }

  /** The folder that holds a review's files. */
  dirOf(id: string): string {
    return this.dir(id);
  }

  /** Deletes a review and its index entry. Only `hoop clear` calls this; hoop deletes nothing by itself. */
  remove(id: string): void {
    this.writable();
    const dir = this.dir(id);
    if (!existsSync(join(dir, "review.json"))) throw new Error(`no review ${id}`);
    rmSync(dir, { recursive: true, force: true });
    if (this.registry.folderOf(id)) this.registry.drop([id]);
  }

  /** The hoop folder this store lives in. */
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

  /** The diagrams the review page couldn't draw on a revision, by `<item>:<line>`, with the library's error. */
  diagramErrors(id: string, revision = this.meta(id).revisions): Record<string, DiagramError> {
    return this.read<Record<string, DiagramError>>(join(this.dir(id), `diagram-errors-${revision}.json`), {});
  }

  /** Records that the page couldn't draw the diagram at `item` line `line` of `revision`; false when that error is already recorded. */
  addDiagramError(id: string, revision: number, item: string, line: number, message: string): boolean {
    const all = this.diagramErrors(id, revision);
    const key = `${item}:${line}`;
    if (all[key]?.message === message) return false;
    this.write(join(this.dir(id), `diagram-errors-${revision}.json`), { ...all, [key]: { message, at: new Date().toISOString() } });
    return true;
  }

  private read<T>(path: string, fallback: T): T {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  }

  private write(path: string, value: unknown) {
    this.writable();
    writeAtomic(path, JSON.stringify(value, null, 2) + "\n");
  }

  /** A new review, in a session's `.hoop` folder `folder` (indexed in the home folder), or else in the home folder. */
  create(doc: ReviewDoc, extra: Partial<ReviewMeta> = {}, folder?: string): ReviewMeta {
    this.writable();
    let id: string;
    // IDs are unique across every folder: one taken anywhere is drawn again.
    do id = `rv_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    while (existsSync(this.dir(id)) || existsSync(join(this.root, id)));
    if (folder) {
      mkdirSync(join(folder, "reviews", id), { recursive: true });
      this.registry.set(id, folder);
    } else mkdirSync(this.dir(id));
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

  /** Marks a review as updated, so lists sort it first and waiters see a change. */
  touch(id: string): ReviewMeta {
    return this.update(id, {});
  }

  /** When revision n was written, from its file; undefined when it can't be read. */
  revisionAt(id: string, n = this.meta(id).revisions): string | undefined {
    try {
      return statSync(join(this.dir(id), `rev-${n}.json`)).mtime.toISOString();
    } catch {
      return undefined;
    }
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
    // Thread ids embed the review id, so a thread id alone identifies its review.
    let n = this.allFeedback(id).reduce((sum, f) => sum + f.comments.length, 0);
    const stored = { ...fb, comments: fb.comments.map((c) => ({ ...c, thread: c.thread ?? `th_${id.slice(3)}_${++n}` })) };
    this.write(join(this.dir(id), `feedback-${fb.revision}.json`), [...list, stored]);
    this.touch(id);
    return stored;
  }

  applied(id: string): Applied[] {
    return this.read<Applied[]>(join(this.dir(id), "applied.json"), []);
  }

  addApplied(id: string, rec: Applied) {
    this.write(join(this.dir(id), "applied.json"), [...this.applied(id), rec]);
  }

  proposals(id: string): Proposal[] {
    return this.read<Proposal[]>(join(this.dir(id), "proposals.json"), []);
  }

  /** Writes the whole list of proposals. */
  writeProposals(id: string, list: Proposal[]) {
    this.write(join(this.dir(id), "proposals.json"), list);
    this.touch(id);
  }

  /** When the agent first received each submitted review, by `receiptKey`. */
  receipts(id: string): Record<string, Receipt> {
    return this.read<Record<string, Receipt>>(join(this.dir(id), "receipts.json"), {});
  }

  /**
   * Records that the agent, as `session` (one or more session IDs) when it has one, received these
   * submitted reviews. A review already received keeps its first receipt, and adds the sessions to the
   * ones that received it. It doesn't touch the review, so waiters and lists see no change.
   */
  addReceipts(id: string, keys: string[], by: string, session?: string | string[], at = new Date().toISOString()) {
    const receipts = this.receipts(id);
    const ids = session === undefined ? [] : typeof session === "string" ? [session] : session;
    let changed = false;
    for (const k of keys) {
      const r = receipts[k];
      if (!r) receipts[k] = { at, by, sessions: [...ids] };
      else if (r.sessions && ids.some((s) => !r.sessions!.includes(s))) r.sessions.push(...ids.filter((s) => !r.sessions!.includes(s)));
      else continue;
      changed = true;
    }
    if (changed) this.write(join(this.dir(id), "receipts.json"), receipts);
  }

  /** How each submitted review from the pages reached the owner's session, by `receiptKey`. */
  deliveries(id: string): Record<string, Delivery> {
    return this.read<Record<string, Delivery>>(join(this.dir(id), "deliveries.json"), {});
  }

  /** Records how one submitted review reached the owner's session. Like receipts, it doesn't touch the review. */
  addDelivery(id: string, key: string, d: Delivery) {
    this.write(join(this.dir(id), "deliveries.json"), { ...this.deliveries(id), [key]: d });
  }

  replies(id: string): Reply[] {
    return this.read<Reply[]>(join(this.dir(id), "replies.json"), []);
  }

  addReply(id: string, reply: Reply) {
    this.write(join(this.dir(id), "replies.json"), [...this.replies(id), reply]);
    this.touch(id);
  }

  /** The review that owns a thread id. */
  findThread(thread: string): string | undefined {
    const local = thread.match(/^th_([a-z0-9]+)_\d+$/);
    const candidates = local ? [`rv_${local[1]}`].filter((id) => existsSync(this.dir(id))) : [];
    return candidates.find((id) => this.allFeedback(id).some((f) => f.comments.some((c) => c.thread === thread)));
  }

  /**
   * Every review, from every session's `.hoop` and the home folder, most recently updated first. A
   * session folder that Claude Code deleted took its reviews with it: their index entries are dropped
   * (by the pages process; a read-only store only skips them).
   */
  list(): ReviewMeta[] {
    const indexed = Object.keys(this.registry.all());
    const gone = indexed.filter((id) => !existsSync(this.dir(id)));
    if (!this.readOnly) this.registry.drop(gone);
    const out: ReviewMeta[] = [];
    const own = existsSync(this.root) ? readdirSync(this.root) : [];
    for (const id of new Set([...indexed, ...own])) {
      if (!/^rv_[a-z0-9]+$/.test(id) || gone.includes(id)) continue;
      try {
        out.push(this.meta(id));
      } catch {
        /* not a review, or removed meanwhile */
      }
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }
}
