import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readTracker } from "./tracker.js";
import { audit } from "./audit.js";
import { currentUser, HoopError, repoDir as defaultRepo, slugify, writeAtomic } from "./util.js";

export const CHANGE_TYPES = ["epic", "story", "task", "bug"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
/** devloop's steps in order; `closed` can follow any step. */
export const STEPS = ["intake", "prd", "hld", "lld", "plan", "build", "review", "accept", "merge", "fold"] as const;
export type Step = (typeof STEPS)[number] | "closed";
export type DocKind = "prd" | "hld" | "lld";
export const KINDS = ["functional", "non-functional"] as const;
export type Kind = (typeof KINDS)[number];
/** What a change's history records: its capture and pick-up checks, a merge, split or drop, and a size choice. */
export const EVENTS = ["capture", "pickup", "merge", "split", "drop", "size"] as const;
export type ChangeEvent = { at: string; by: string; event: (typeof EVENTS)[number]; verdict?: string; note?: string; ref?: string };

export type ChangeRecord = {
  id: string;
  slug: string;
  title: string;
  type: ChangeType | "unknown";
  reason: string;
  created: string;
  steps: { step: Step; at: string; by: string }[];
  reviews: Partial<Record<DocKind, string[]>>;
  prs: number[];
  kind: Kind;
  /** A label for the part of the repository the change belongs to; the repository's name by default. */
  project: string;
  history: ChangeEvent[];
};

/** A change's size from its tracker's estimates, and whether it is over devloop's limit for one change. */
export type ChangeSize = { files: number; lines: number; flagged: boolean; unknown: string[]; kept: boolean };

/** Over this, a change is flagged with a proposal to split it: five pull requests at devloop's limit. */
export const SIZE_LIMIT = { files: 50, lines: 2500 };

/** Called after a change is created or changes; a gate returns what's missing for a step. */
export type ChangeHooks = {
  onRecord?: (rec: ChangeRecord, event: "create" | "classify" | "step" | "pr") => void;
  gate?: (rec: ChangeRecord, step: Step) => string[] | Promise<string[]>;
  /** A PR's state (`OPEN`, `MERGED`, `CLOSED`); defaults to `gh pr view`. */
  prState?: (pr: number) => string;
};

const ghPrState = (repoDir: string) => (pr: number) =>
  (JSON.parse(execFileSync("gh", ["pr", "view", String(pr), "--json", "state"], { cwd: repoDir, encoding: "utf8" })) as { state: string }).state;

const ID = /^CR-(\d+)$/;
const toSlug = (s: string) => slugify(s, { max: 40, fallback: "change", trimEnd: true });
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

  constructor(
    readonly repoDir: string = defaultRepo(),
    readonly hooks: ChangeHooks = {},
  ) {
    this.root = join(repoDir, "docs", "changes");
  }

  private folders(): { n: number; id: string; dir: string }[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .flatMap((d) => {
        const m = d.match(/^CR-(\d+)(?:-|$)/);
        return m ? [{ n: Number(m[1]), id: `CR-${m[1]}`, dir: join(this.root, d) }] : [];
      })
      .sort((a, b) => a.n - b.n);
  }

  private dir(cr: string): string {
    if (!ID.test(cr)) throw new HoopError(`invalid change id ${cr}; expected CR-<n>`, [{ path: "cr", message: "expected CR-<n>" }]);
    const found = this.folders().filter((x) => x.id === cr);
    if (!found.length) throw new HoopError(`no change ${cr} in ${this.root}`);
    if (found.length > 1)
      throw new HoopError(`${cr} has ${found.length} folders (${found.map((f) => f.dir.split("/").pop()).join(", ")}); renumber all but one`);
    return found[0]!.dir;
  }

  private write(dir: string, rec: ChangeRecord) {
    writeAtomic(join(dir, "change.json"), JSON.stringify(rec, null, 2) + "\n");
  }

  /**
   * A change's record. Folders made before the registry (no change.json) read as type "unknown";
   * records made before kinds and projects read as functional, in the repository's project.
   */
  get(cr: string): ChangeRecord {
    const dir = this.dir(cr),
      path = join(dir, "change.json");
    const defaults = { kind: "functional" as const, project: basename(this.repoDir), history: [] };
    const slug = dir
      .split("/")
      .pop()!
      .replace(/^CR-\d+-?/, "");
    const bare = {
      id: cr,
      slug,
      title: slug.replace(/-/g, " "),
      type: "unknown" as const,
      reason: "",
      created: "",
      steps: [],
      reviews: {},
      prs: [],
      ...defaults,
    };
    if (!existsSync(path)) return bare;
    // A record that doesn't parse reads as unknown, with the reason, so one bad file never hides the others.
    try {
      return { ...defaults, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<ChangeRecord>) } as ChangeRecord;
    } catch {
      return { ...bare, reason: `${cr}'s change.json isn't valid JSON; fix it by hand` };
    }
  }

  /** The folder a change lives in, relative to the repository. */
  folder(cr: string): string {
    return `docs/changes/${basename(this.dir(cr))}`;
  }

  list(): ChangeRecord[] {
    return this.folders().map((f) => this.get(f.id));
  }

  /** Captures a request as written, as the next change, at the intake step (FR-1). */
  create(text: string, opts: { type: ChangeType; reason: string; title?: string; slug?: string; by?: string; kind?: Kind; project?: string }): ChangeRecord {
    if (!text.trim()) throw new HoopError("the request is empty", [{ path: "request", message: "expected the request text" }]);
    this.check(opts.type, opts.reason);
    this.checkLabels(opts.kind, opts.project);
    const title = (opts.title ?? text.trim().split("\n")[0]!).trim().slice(0, 120);
    const slug = toSlug(opts.slug || title);
    const { id, dir } = this.reserve(slug);
    writeFileSync(join(dir, "REQUEST.md"), text, { flag: "wx" });
    const by = opts.by ?? currentUser(),
      at = now();
    const rec: ChangeRecord = {
      id,
      slug,
      title,
      type: opts.type,
      reason: opts.reason,
      created: at,
      steps: [{ step: "intake", at, by }],
      reviews: {},
      prs: [],
      kind: opts.kind ?? "functional",
      project: opts.project?.trim() || basename(this.repoDir),
      history: [],
    };
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
      const id = `CR-${n}`,
        dir = join(this.root, `${id}-${slug}`);
      try {
        mkdirSync(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      if (this.folders().filter((f) => f.n === n).length === 1) return { id, dir };
      rmSync(dir, { recursive: true });
    }
    throw new HoopError("couldn't reserve a change number; retry");
  }

  /** Sets the type and reason (FR-2); a corrected type with a why is recorded for the classifier (FR-3). */
  classify(cr: string, type: ChangeType, reason: string, opts: { why?: string; by?: string; kind?: Kind; project?: string } = {}): ChangeRecord {
    this.check(type, reason);
    this.checkLabels(opts.kind, opts.project);
    const rec = this.get(cr),
      was = rec.type,
      dir = this.dir(cr);
    // A change moves to another project only while it is queued; after that its documents name it.
    const project = opts.project?.trim();
    const at = rec.steps.at(-1)?.step ?? "intake";
    if (project && project !== rec.project && at !== "intake")
      throw new HoopError(`${cr} is at ${at}, so it can't move to another project; only a queued change moves`, [
        { path: "project", message: "only a queued change moves" },
      ]);
    if (was !== type && opts.why) {
      const request = join(dir, "REQUEST.md");
      const first = existsSync(request) ? readFileSync(request, "utf8").trim().split("\n")[0]! : rec.title;
      const log = join(this.root, "CLASSIFICATION.md");
      if (!existsSync(log))
        writeFileSync(log, "# Classification corrections\n\n| Date | Change | Request (first line) | Was | Now | Why |\n|---|---|---|---|---|---|\n");
      appendFileSync(log, `| ${now().slice(0, 10)} | ${cr} | ${cell(first).slice(0, 80)} | ${was} | ${type} | ${cell(opts.why)} |\n`);
    }
    Object.assign(rec, { type, reason, ...(opts.kind ? { kind: opts.kind } : {}), ...(project ? { project } : {}) });
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
      throw new HoopError(`${cr} is at ${at}; the next step is ${next ?? "none (fold is last)"}, or closed`, [
        { path: "step", message: `expected ${next ?? "closed"}` },
      ]);
    const missing = [...((await this.hooks.gate?.(rec, step)) ?? []), ...(step === "fold" ? this.unmerged(rec) : [])];
    if (missing.length) {
      audit("cr_step", { ok: false, actor: opts.by ?? currentUser(), cr, step, errors: missing });
      const err = new HoopError(
        `${cr} can't move to ${step}: ${missing.join("; ")}`,
        missing.map((m) => ({ path: "step", message: m })),
      );
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
      try {
        s = state(pr);
      } catch (e) {
        return [`couldn't read PR #${pr} (${(e as Error).message.split("\n")[0]}); retry`];
      }
      return s === "MERGED" ? [] : [`PR #${pr} is ${s.toLowerCase()}; merge it first`];
    });
  }

  /** Records an event in the change's history: a capture or pick-up check, a merge, split or drop, or a size choice. */
  record(cr: string, e: { event: string; verdict?: string; note?: string; ref?: string; by?: string }): ChangeRecord {
    if (!(EVENTS as readonly string[]).includes(e.event))
      throw new HoopError(`unknown event ${e.event}; one of ${EVENTS.join(", ")}`, [{ path: "event", message: "unknown event" }]);
    const rec = this.get(cr);
    const by = e.by ?? currentUser();
    rec.history.push({
      at: now(),
      by,
      event: e.event as ChangeEvent["event"],
      ...(e.verdict ? { verdict: e.verdict } : {}),
      ...(e.note ? { note: e.note } : {}),
      ...(e.ref ? { ref: e.ref } : {}),
    });
    this.write(this.dir(cr), rec);
    audit("cr_event", { actor: by, cr, event: e.event, verdict: e.verdict });
    return rec;
  }

  /**
   * The change's size: the sum of its tracker's Size cells, each read as "<n> files, <m> lines", with
   * an optional "~" before each number. A
   * cell in another form is unknown. Over the limit, the change is flagged, and a size event with the
   * verdict "keep" records that the requester keeps it whole.
   */
  size(cr: string): ChangeSize {
    const rec = this.get(cr);
    const tracker = join(this.dir(cr), "TRACKER.md");
    let files = 0,
      lines = 0;
    const unknown: string[] = [];
    if (existsSync(tracker)) {
      let items: { id: string; parent?: string; cells: Record<string, string> }[] = [];
      try {
        items = readTracker(tracker).items;
      } catch {
        /* no tracker table */
      }
      // An item with items under it is their summary, so only items without children count.
      const parents = new Set(items.map((i) => i.parent).filter(Boolean));
      for (const i of items) {
        if (parents.has(i.id)) continue;
        const m = (i.cells.Size ?? "").match(/^~?(\d+)\s+files?,\s*~?(\d+)\s+lines?\b/);
        if (m) [files, lines] = [files + Number(m[1]), lines + Number(m[2])];
        else unknown.push(i.id);
      }
    }
    const flagged = files > SIZE_LIMIT.files || lines > SIZE_LIMIT.lines;
    const kept = rec.history.some((h) => h.event === "size" && h.verdict === "keep");
    return { files, lines, flagged, unknown, kept };
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

  private checkLabels(kind: string | undefined, project: string | undefined) {
    if (kind !== undefined && !(KINDS as readonly string[]).includes(kind))
      throw new HoopError(`unknown kind ${kind}; one of ${KINDS.join(", ")}`, [{ path: "kind", message: "unknown kind" }]);
    if (project !== undefined && !/^[\w .-]{1,60}$/.test(project.trim()))
      throw new HoopError("a project is a short name of letters, digits, spaces, dots and hyphens", [{ path: "project", message: "invalid project" }]);
  }

  private check(type: string, reason: string) {
    if (!(CHANGE_TYPES as readonly string[]).includes(type))
      throw new HoopError(`unknown type ${type}; one of ${CHANGE_TYPES.join(", ")}`, [{ path: "type", message: "unknown type" }]);
    if (!reason?.trim()) throw new HoopError("a classification needs a one-line reason", [{ path: "reason", message: "expected a reason" }]);
  }
}
