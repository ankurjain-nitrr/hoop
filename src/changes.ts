import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./audit.js";
import { currentUser, HoopError, repoDir as defaultRepo, writeAtomic } from "./util.js";

export const CHANGE_TYPES = ["epic", "story", "task", "bug"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
/** devloop's steps in order; `closed` can follow any step. */
export const STEPS = ["intake", "prd", "hld", "lld", "plan", "build", "review", "accept", "merge", "fold"] as const;
export type Step = (typeof STEPS)[number] | "closed";
export type DocKind = "prd" | "hld" | "lld";

export type ChangeRecord = {
  id: string; slug: string; title: string; type: ChangeType | "unknown"; reason: string; created: string;
  steps: { step: Step; at: string; by: string }[];
  reviews: Partial<Record<DocKind, string[]>>;
  prs: number[];
};

/** Called after a change is created or changes, e.g. to update the tracker; a gate returns what's missing for a step. */
export type ChangeHooks = {
  onRecord?: (rec: ChangeRecord, event: "create" | "classify" | "step" | "pr") => void;
  gate?: (rec: ChangeRecord, step: Step) => string[] | Promise<string[]>;
  /** A PR's state (`OPEN`, `MERGED`, `CLOSED`); defaults to `gh pr view`. */
  prState?: (pr: number) => string;
};

const ghPrState = (repoDir: string) => (pr: number) =>
  (JSON.parse(execFileSync("gh", ["pr", "view", String(pr), "--json", "state"], { cwd: repoDir, encoding: "utf8" })) as { state: string }).state;

const ID = /^CR-(\d+)$/;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "change";
const now = () => new Date().toISOString();
/** Text safe inside one markdown table cell. */
const cell = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").replace(/\|/g, "\\|");

/**
 * Change requests in `<repo>/docs/changes/CR-<n>-<slug>/`: `REQUEST.md` holds the request exactly as
 * given; `change.json` (owned by hoop) holds type, reason, step history, linked reviews and PRs.
 * Corrections to a type are appended to `docs/changes/CLASSIFICATION.md`.
 */
export class Changes {
  readonly root: string;

  constructor(readonly repoDir: string = defaultRepo(), readonly hooks: ChangeHooks = {}) {
    this.root = join(repoDir, "docs", "changes");
  }

  private folders(): { n: number; id: string; dir: string }[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).flatMap((d) => {
      const m = d.match(/^CR-(\d+)(?:-|$)/);
      return m ? [{ n: Number(m[1]), id: `CR-${m[1]}`, dir: join(this.root, d) }] : [];
    }).sort((a, b) => a.n - b.n);
  }

  private dir(cr: string): string {
    if (!ID.test(cr)) throw new HoopError(`invalid change id ${cr}; expected CR-<n>`, [{ path: "cr", message: "expected CR-<n>" }]);
    const found = this.folders().filter((x) => x.id === cr);
    if (!found.length) throw new HoopError(`no change ${cr} in ${this.root}`);
    if (found.length > 1) throw new HoopError(`${cr} has ${found.length} folders (${found.map((f) => f.dir.split("/").pop()).join(", ")}); renumber all but one`);
    return found[0]!.dir;
  }

  private write(dir: string, rec: ChangeRecord) {
    writeAtomic(join(dir, "change.json"), JSON.stringify(rec, null, 2) + "\n");
  }

  /** A change's record; folders made before the registry (no change.json) read as type "unknown". */
  get(cr: string): ChangeRecord {
    const dir = this.dir(cr), path = join(dir, "change.json");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as ChangeRecord;
    const slug = dir.split("/").pop()!.replace(/^CR-\d+-?/, "");
    return { id: cr, slug, title: slug.replace(/-/g, " "), type: "unknown", reason: "", created: "", steps: [], reviews: {}, prs: [] };
  }

  list(): ChangeRecord[] {
    return this.folders().map((f) => this.get(f.id));
  }

  /** Captures a request as written, as the next change, at the intake step (FR-1). */
  create(text: string, opts: { type: ChangeType; reason: string; title?: string; slug?: string; by?: string }): ChangeRecord {
    if (!text.trim()) throw new HoopError("the request is empty", [{ path: "request", message: "expected the request text" }]);
    this.check(opts.type, opts.reason);
    const title = (opts.title ?? text.trim().split("\n")[0]!).trim().slice(0, 120);
    const slug = opts.slug ? slugify(opts.slug) : slugify(title);
    const { id, dir } = this.reserve(slug);
    writeFileSync(join(dir, "REQUEST.md"), text, { flag: "wx" });
    const by = opts.by ?? currentUser(), at = now();
    const rec: ChangeRecord = { id, slug, title, type: opts.type, reason: opts.reason, created: at, steps: [{ step: "intake", at, by }], reviews: {}, prs: [] };
    this.write(dir, rec);
    audit("cr_create", { actor: by, cr: id, type: opts.type });
    this.hooks.onRecord?.(rec, "create");
    return rec;
  }

  /** Makes the next CR-<n> folder; if another session took the same number at once, gives it up and takes the next. */
  private reserve(slug: string): { id: string; dir: string } {
    mkdirSync(this.root, { recursive: true });
    for (let attempt = 0; attempt < 20; attempt++) {
      const n = Math.max(0, ...this.folders().map((f) => f.n)) + 1;
      const id = `CR-${n}`, dir = join(this.root, `${id}-${slug}`);
      try { mkdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; throw e; }
      if (this.folders().filter((f) => f.n === n).length === 1) return { id, dir };
      rmSync(dir, { recursive: true });
    }
    throw new HoopError("couldn't reserve a change number; retry");
  }

  /** Sets the type and reason (FR-2); a corrected type with a why is recorded for the classifier (FR-3). */
  classify(cr: string, type: ChangeType, reason: string, opts: { why?: string; by?: string } = {}): ChangeRecord {
    this.check(type, reason);
    const rec = this.get(cr), was = rec.type, dir = this.dir(cr);
    if (was !== type && opts.why) {
      const request = join(dir, "REQUEST.md");
      const first = existsSync(request) ? readFileSync(request, "utf8").trim().split("\n")[0]! : rec.title;
      const log = join(this.root, "CLASSIFICATION.md");
      if (!existsSync(log)) writeFileSync(log, "# Classification corrections\n\n| Date | Change | Request (first line) | Was | Now | Why |\n|---|---|---|---|---|---|\n");
      appendFileSync(log, `| ${now().slice(0, 10)} | ${cr} | ${cell(first).slice(0, 80)} | ${was} | ${type} | ${cell(opts.why)} |\n`);
    }
    Object.assign(rec, { type, reason });
    this.write(dir, rec);
    audit("cr_classify", { actor: opts.by ?? currentUser(), cr, was, type, corrected: Boolean(opts.why) });
    this.hooks.onRecord?.(rec, "classify");
    return rec;
  }

  /** Records a move to a step (FR-6); gated steps ask the gate hook first and refuse with what's missing. */
  async moveStep(cr: string, step: Step, opts: { by?: string } = {}): Promise<ChangeRecord> {
    if (step !== "closed" && !(STEPS as readonly string[]).includes(step))
      throw new HoopError(`unknown step ${step}; one of ${STEPS.join(", ")}, closed`, [{ path: "step", message: "unknown step" }]);
    const rec = this.get(cr);
    const at = rec.steps.at(-1)?.step ?? "intake";
    const next = STEPS[STEPS.indexOf(at as (typeof STEPS)[number]) + 1];
    if (at === "closed") throw new HoopError(`${cr} is closed`, [{ path: "step", message: "the change is closed" }]);
    if (step !== "closed" && step !== next)
      throw new HoopError(`${cr} is at ${at}; the next step is ${next ?? "none (fold is last)"}, or closed`, [{ path: "step", message: `expected ${next ?? "closed"}` }]);
    const missing = [...((await this.hooks.gate?.(rec, step)) ?? []), ...(step === "fold" ? this.unmerged(rec) : [])];
    if (missing.length) {
      audit("cr_step", { ok: false, actor: opts.by ?? currentUser(), cr, step, errors: missing });
      const err = new HoopError(`${cr} can't move to ${step}: ${missing.join("; ")}`, missing.map((m) => ({ path: "step", message: m })));
      err.audited = true;
      throw err;
    }
    const by = opts.by ?? currentUser();
    rec.steps.push({ step, at: now(), by });
    this.write(this.dir(cr), rec);
    audit("cr_step", { actor: by, cr, step });
    this.hooks.onRecord?.(rec, "step");
    return rec;
  }

  /** Fold needs a linked PR and every linked PR merged. */
  private unmerged(rec: ChangeRecord): string[] {
    if (!rec.prs.length) return [`no PRs linked; run hoop cr link-pr ${rec.id} <number>`];
    const state = this.hooks.prState ?? ghPrState(this.repoDir);
    return rec.prs.flatMap((pr) => {
      let s: string;
      try { s = state(pr); } catch (e) { return [`couldn't read PR #${pr} (${(e as Error).message.split("\n")[0]}); retry`]; }
      return s === "MERGED" ? [] : [`PR #${pr} is ${s.toLowerCase()}; merge it first`];
    });
  }

  /** The change's current step. */
  step(cr: string): Step | undefined {
    return this.get(cr).steps.at(-1)?.step;
  }

  linkPr(cr: string, pr: number): ChangeRecord {
    if (!Number.isInteger(pr) || pr < 1) throw new HoopError("expected a PR number", [{ path: "pr", message: "expected a positive integer" }]);
    const rec = this.get(cr);
    if (!rec.prs.includes(pr)) rec.prs.push(pr);
    this.write(this.dir(cr), rec);
    audit("cr_link_pr", { cr, pr });
    this.hooks.onRecord?.(rec, "pr");
    return rec;
  }

  /** Records a review for one of the change's documents (used by the review sequencer). */
  addReview(cr: string, doc: DocKind, reviewId: string): ChangeRecord {
    const rec = this.get(cr);
    rec.reviews[doc] = [...(rec.reviews[doc] ?? []), reviewId];
    this.write(this.dir(cr), rec);
    return rec;
  }

  private check(type: string, reason: string) {
    if (!(CHANGE_TYPES as readonly string[]).includes(type))
      throw new HoopError(`unknown type ${type}; one of ${CHANGE_TYPES.join(", ")}`, [{ path: "type", message: "unknown type" }]);
    if (!reason?.trim()) throw new HoopError("a classification needs a one-line reason", [{ path: "reason", message: "expected a reason" }]);
  }
}
