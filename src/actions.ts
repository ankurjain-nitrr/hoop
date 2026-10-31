import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Agent, type Owner, ownerOf } from "./owner.js";
import { parsePrUrl, type PrStates } from "./prs.js";
import { Registry } from "./registry.js";
import type { Delivery, Store } from "./store.js";
import { HoopError, tryReadJson, writeJson } from "./util.js";
import { actsAs, processOf } from "./work.js";
import { isReviewId, newId } from "./ids.js";

// Action items: things a session needs the person to do that only they can do (merge a pull request,
// approve a release, run a command). Each closes only when hoop sees it done (`done_when`), when the
// person ticks a manual one or says Won't do, or when the session withdraws it.

/** How hoop tells an action item is done. A `manual` item is done only when the person ticks it. */
export type DoneWhen =
  | { kind: "pr_merged"; url: string }
  | { kind: "review_approved"; review_id: string }
  | { kind: "npm_version"; package: string; version: string }
  | { kind: "manual" };

export type ActionState = "open" | "done" | "wont_do" | "withdrawn";

/** An action item, as `actions/<id>.json` keeps it. */
export type ActionItem = {
  id: string;
  title: string;
  /** What to do and why, in at most two lines. */
  description: string;
  done_when: DoneWhen;
  /** The session that added it, and that hoop tells when it closes. */
  owner: Owner;
  created: string;
  state: ActionState;
  /** When it closed: when hoop saw it done, the person ticked it or said Won't do, or the session withdrew it. */
  closed_at?: string;
  /** Who closed it: "hoop" for a check, the person, or the session's label. */
  closed_by?: string;
  /** Why the person won't do it, or why the session withdrew it. */
  reason?: string;
  /** How the closing message reached the session. */
  delivery?: Delivery;
};

const ID = /^ac_[a-z0-9]+$/;
const TITLE_MAX = 120,
  DESCRIPTION_MAX = 400,
  REASON_MAX = 200;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,213}$/;
const SEMVER = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,64})?(\+[0-9A-Za-z.-]{1,64})?$/;
/** Titles that name no action: "Review this", a bare number or link. */
const VAGUE =
  /^(?:(?:please\s+)?(?:review|check|look at)(?:\s+(?:this|it|that|the\s+(?:pr|pull request|doc(?:ument)?)))?|(?:pr|pull request)?\s*#?\d+|https?:\/\/\S+)[.!]?$/i;

const oneLine = (v: unknown, what: string, max: number): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new HoopError(`${what} needs text`, [{ path: what, message: "required" }]);
  if (/[\r\n\u2028\u2029]/.test(s)) throw new HoopError(`${what} is one line`, [{ path: what, message: "no line breaks" }]);
  if ([...s].length > max) throw new HoopError(`${what} has at most ${max} characters`, [{ path: what, message: "too long" }]);
  return s;
};

/** An action item's title: one line that says what to do. */
export function validTitle(raw: unknown): string {
  const t = oneLine(raw, "title", TITLE_MAX);
  if (VAGUE.test(t))
    throw new HoopError('a title says what the person should do, such as "Merge the CSV export pull request", not "Review this" or a bare number', [
      { path: "title", message: "say what to do" },
    ]);
  return t;
}

/** An action item's description: what to do and why, in one or two lines. */
export function validDescription(raw: unknown): string {
  const lines = (typeof raw === "string" ? raw : "")
    .split(/\r\n?|\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) throw new HoopError("description needs text: what to do, and why", [{ path: "description", message: "required" }]);
  if (lines.length > 2) throw new HoopError("description is at most two lines: what to do, and why", [{ path: "description", message: "too many lines" }]);
  const text = lines.join("\n");
  if ([...text].length > DESCRIPTION_MAX)
    throw new HoopError(`description has at most ${DESCRIPTION_MAX} characters`, [{ path: "description", message: "too long" }]);
  return text;
}

/** A reason for Won't do or a withdrawal: one line. */
export const validReason = (raw: unknown) => oneLine(raw, "reason", REASON_MAX);

/** Checks a `done_when` and returns it clean. `reviewExists` tells whether a review ID names a review. */
export function validDoneWhen(raw: unknown, reviewExists: (id: string) => boolean): DoneWhen {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const check = DONE_CHECKS.get(v.kind);
  if (!check)
    throw new HoopError("done_when.kind must be pr_merged, review_approved, npm_version or manual", [{ path: "done_when.kind", message: "unknown check" }]);
  return check(v, reviewExists);
}

const bad = (field: string, message: string) => new HoopError(`done_when.${field} ${message}`, [{ path: `done_when.${field}`, message }]);

/** Each kind of `done_when`, checked and made clean from its fields. */
const DONE_CHECKS = new Map<unknown, (v: Record<string, unknown>, reviewExists: (id: string) => boolean) => DoneWhen>([
  [
    "pr_merged",
    (v) => {
      const url = typeof v.url === "string" ? v.url.trim().replace(/\/$/, "") : "";
      if (!parsePrUrl(url)) throw bad("url", "must look like https://github.com/<owner>/<repo>/pull/<number>");
      return { kind: "pr_merged", url };
    },
  ],
  [
    "review_approved",
    (v, reviewExists) => {
      const id = typeof v.review_id === "string" ? v.review_id.trim() : "";
      if (!isReviewId(id) || !reviewExists(id)) throw bad("review_id", "must name a hoop review");
      return { kind: "review_approved", review_id: id };
    },
  ],
  [
    "npm_version",
    (v) => {
      const pkg = typeof v.package === "string" ? v.package.trim() : "";
      const version = typeof v.version === "string" ? v.version.trim().replace(/^v/, "") : "";
      if (!NPM_NAME.test(pkg)) throw bad("package", "must be an npm package name");
      if (!SEMVER.test(version)) throw bad("version", "must be an exact version, such as 1.2.3");
      return { kind: "npm_version", package: pkg, version };
    },
  ],
  ["manual", () => ({ kind: "manual" })],
]);

/** Where an item's link points, and what it reads: the pull request, the review or the npm page. None for a manual item. */
export function actionLink(d: DoneWhen, reviewTitle?: (id: string) => string | undefined): { href: string; text: string } | undefined {
  switch (d.kind) {
    case "pr_merged": {
      const p = parsePrUrl(d.url)!;
      return { href: d.url, text: `${p.repo}#${p.number}` };
    }
    case "review_approved":
      return { href: `/r/${d.review_id}`, text: reviewTitle?.(d.review_id) ?? d.review_id };
    case "npm_version":
      return { href: `https://www.npmjs.com/package/${d.package}/v/${d.version}`, text: `${d.package}@${d.version}` };
    default:
      return undefined;
  }
}

/**
 * Action items as JSON files, like reviews: `<folder>/actions/<id>.json`, where the folder is the
 * `.hoop` of the session that added the item (indexed in the home folder's `actions-index.json`), or
 * the hoop home folder for a session without one. Only the pages process writes them.
 */
export class Actions {
  readonly registry: Registry;
  readonly home: string;
  private readonly readOnly: boolean;

  constructor(store: Store) {
    this.home = store.home;
    this.readOnly = store.readOnly;
    this.registry = new Registry(this.home, "actions");
  }

  private file(id: string): string {
    if (!ID.test(id)) throw new HoopError(`no action item ${id}`);
    const folder = this.registry.folderOf(id);
    return join(folder ?? this.home, "actions", `${id}.json`);
  }

  private write(item: ActionItem): ActionItem {
    if (this.readOnly) throw new Error("only hoop's pages process writes its files; send the write to it");
    writeJson(this.file(item.id), item);
    return item;
  }

  get(id: string): ActionItem {
    const item = tryReadJson<ActionItem>(this.file(id));
    if (!item) throw new HoopError(`no action item ${id}`);
    return item;
  }

  /** Every action item, from every session's `.hoop` and the home folder, newest first. */
  list(): ActionItem[] {
    const indexed = Object.keys(this.registry.all());
    const gone = indexed.filter((id) => !existsSync(this.file(id)));
    if (!this.readOnly) this.registry.drop(gone);
    const dir = join(this.home, "actions");
    const own = existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.json$/, "")) : [];
    const out: ActionItem[] = [];
    for (const id of new Set([...indexed, ...own])) {
      if (!ID.test(id) || gone.includes(id)) continue;
      try {
        out.push(this.get(id));
      } catch {
        /* removed meanwhile */
      }
    }
    return out.sort((a, b) => b.created.localeCompare(a.created));
  }

  /**
   * Adds an item for `agent`, in its `.hoop` folder `folder` or else the home folder. An open item of
   * the same session with the same title and check is returned again instead, with `already: true`.
   */
  add(agent: Agent, folder: string | undefined, input: { title: string; description: string; done_when: DoneWhen }): ActionItem & { already: boolean } {
    const same = this.list().find(
      (i) => i.state === "open" && i.title === input.title && JSON.stringify(i.done_when) === JSON.stringify(input.done_when) && actsAs(i.owner, agent.session),
    );
    if (same) return { ...same, already: true };
    let id: string;
    do id = newId("ac");
    while (existsSync(this.file(id)));
    if (folder) {
      mkdirSync(join(folder, "actions"), { recursive: true });
      this.registry.set(id, folder);
    } else mkdirSync(join(this.home, "actions"), { recursive: true });
    const item = this.write({
      id,
      ...input,
      owner: ownerOf(agent, this.home, agent.claude ? processOf(agent.session) : undefined),
      created: new Date().toISOString(),
      state: "open",
    });
    return { ...item, already: false };
  }

  /** Closes an open item; refuses one already closed. */
  close(id: string, state: Exclude<ActionState, "open">, by: string, reason?: string): ActionItem {
    const item = this.get(id);
    if (item.state !== "open") throw new HoopError(`action item ${id} is already ${item.state.replace("_", " ")}`);
    return this.write({ ...item, state, closed_at: new Date().toISOString(), closed_by: by, ...(reason ? { reason } : {}) });
  }

  /** Records how the closing message reached the session. */
  delivered(id: string, delivery: Delivery): ActionItem {
    return this.write({ ...this.get(id), delivery });
  }
}

/** Runs `npm` with an argument array and resolves its standard output; rejects when it fails or is missing. */
export type NpmRunner = (args: string[]) => Promise<string>;

const runNpm: NpmRunner = (args) =>
  new Promise((resolve, reject) =>
    execFile("npm", args, { timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, npm_config_update_notifier: "false" } }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );

/** How long a check's answer from `gh` or `npm` is kept before it is asked again. */
const CHECK_TTL_MS = 60_000;

/**
 * The checks behind `done_when`, for the pages process: a pull request's state from `gh` (through the
 * same `PrStates` Home's pull requests use), a review's status from the store, and whether a version
 * is published from `npm view`. `gh` and `npm` are asked at most once a minute per item.
 */
export class ActionChecks {
  private npmCache = new Map<string, { at: number; done: boolean }>();
  private npmPending = new Map<string, Promise<boolean>>();

  constructor(
    private store: Store,
    private prs: PrStates,
    private npm: NpmRunner = runNpm,
  ) {}

  /** Whether hoop sees the item done now. A manual item never is; a check that fails reads as not done. */
  async done(item: ActionItem): Promise<boolean> {
    const d = item.done_when;
    switch (d.kind) {
      case "pr_merged":
        return (await this.prs.get(d.url)).state === "merged";
      case "review_approved":
        try {
          return this.store.meta(d.review_id).status === "approved";
        } catch {
          return false;
        }
      case "npm_version":
        return this.published(d.package, d.version);
      default:
        return false;
    }
  }

  private published(pkg: string, version: string): Promise<boolean> {
    const key = `${pkg}@${version}`;
    const c = this.npmCache.get(key);
    if (c && (c.done || Date.now() - c.at < CHECK_TTL_MS)) return Promise.resolve(c.done);
    let p = this.npmPending.get(key);
    if (!p) {
      p = this.npm(["view", key, "version"])
        .then(
          (out) => out.trim().split("\n").pop()?.trim().replace(/^'|'$/g, "") === version,
          () => false,
        )
        .then((done) => {
          this.npmCache.set(key, { at: Date.now(), done });
          this.npmPending.delete(key);
          return done;
        });
      this.npmPending.set(key, p);
    }
    return p;
  }
}
