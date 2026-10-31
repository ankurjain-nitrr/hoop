import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Agent, type Owner, ownerOf, validSession } from "./owner.js";
import { field, HoopError, isList, tryReadJson, writeJson } from "./util.js";

/** A pull request a Claude Code session opened, as `prs.json` keeps it. */
export type TrackedPr = { url: string; owner: Owner; added: string };

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]{0,9})$/;
const PR_URL_IN_TEXT = /https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]{0,9}(?!\S)/g;

/** A pull request's repository and number, or undefined when `url` isn't `https://github.com/<owner>/<repo>/pull/<n>`. */
export function parsePrUrl(url: string): { repo: string; number: number } | undefined {
  const m = PR_URL.exec(url);
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : undefined;
}

const file = (home: string) => join(home, "prs.json");

const isTracked = (p: unknown): p is TrackedPr => {
  const url = field(p, "url");
  return typeof url === "string" && !!parsePrUrl(url) && !!validSession(field(field(p, "owner"), "session"));
};

/** Every tracked pull request, oldest first; none when the file is missing or unreadable. */
export function trackedPrs(home: string): TrackedPr[] {
  const prs = field(tryReadJson(file(home)), "prs");
  return isList(prs) ? prs.filter(isTracked) : [];
}

/**
 * Records that `session` opened the pull request at `url`. A pull request is tracked once: tracking
 * it again returns the first record, with `already: true`.
 */
/** A string `session` names a Claude Code session, as the PR hook sees it. */
export function trackPr(home: string, url: string, session: string | Agent): TrackedPr & { already: boolean } {
  const clean = url.trim().replace(/\/$/, "");
  if (!parsePrUrl(clean))
    throw new HoopError("expected a GitHub pull request URL", [{ path: "url", message: "must look like https://github.com/<owner>/<repo>/pull/<number>" }]);
  mkdirSync(home, { recursive: true });
  const prs = trackedPrs(home);
  const known = prs.find((p) => p.url === clean);
  if (known) return { ...known, already: true };
  const pr: TrackedPr = {
    url: clean,
    owner: ownerOf(typeof session === "string" ? { session, claude: true } : session, home),
    added: new Date().toISOString(),
  };
  writeJson(file(home), { prs: [...prs, pr] });
  return { ...pr, already: false };
}

/**
 * The pull request a Claude Code `PostToolUse` hook on Bash saw opened, or undefined: the command
 * runs `gh pr create`, and its output holds the new pull request's URL (the last one, as gh prints it last).
 */
export function openedPr(input: unknown): string | undefined {
  const command = field(field(input, "tool_input"), "command");
  if (typeof command !== "string" || !/\bgh\s+pr\s+create\b/.test(command)) return undefined;
  const r = field(input, "tool_response");
  const stdout = field(r, "stdout");
  const out = typeof r === "string" ? r : typeof stdout === "string" ? stdout : "";
  return out.match(PR_URL_IN_TEXT)?.pop();
}

/** Runs the hook on its input: tracks the pull request it saw opened, for the hook's session. Never throws. */
export function prHook(home: string, input: unknown, envSession?: string): TrackedPr | undefined {
  try {
    const url = openedPr(input);
    const session = validSession(field(input, "session_id")) ?? envSession;
    return url && session ? trackPr(home, url, session) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A pull request's state as Home shows it. "gone" means GitHub says its repository or the pull request
 * doesn't exist (or isn't visible to the person signed in to `gh`); any other failure to read it,
 * such as no `gh`, signed out, a network error or a rate limit, is "unknown".
 */
export type PrState = {
  state: "open" | "merged" | "closed" | "gone" | "unknown";
  title?: string;
  body?: string;
  /** The checks on its head commit: none, still running, any failed, or all passed. */
  checks?: "none" | "running" | "failing" | "green";
  conflicts?: boolean;
  /** A review is asked of the person signed in to `gh`. */
  review_requested?: boolean;
  ready?: boolean;
  /** A draft: never ready to merge. */
  draft?: boolean;
  /** When it was opened, and when it merged. */
  opened_at?: string;
  merged_at?: string;
  /** Its head branch, by which a todo can name it. */
  branch?: string;
};

/** The fields `gh pr view --json` reads. */
export const PR_FIELDS = "title,body,state,mergeable,reviewDecision,reviewRequests,statusCheckRollup,isDraft,createdAt,mergedAt,headRefName";

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const RUNNING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

type Check = { status?: string; conclusion?: string; state?: string };

/** The checks' overall result, from `statusCheckRollup` (check runs and commit statuses). */
function checksOf(rollup: Check[] | undefined): NonNullable<PrState["checks"]> {
  const results = (rollup ?? []).map((c) => (c.state ?? (c.status && c.status !== "COMPLETED" ? c.status : c.conclusion) ?? "").toUpperCase());
  if (!results.length) return "none";
  if (results.some((r) => FAILED.has(r))) return "failing";
  if (results.some((r) => RUNNING.has(r) || r === "")) return "running";
  return "green";
}

/** A pull request's state by GitHub's name for it; any other is unknown. */
const PR_STATES = new Map<string | undefined, PrState["state"]>([
  ["MERGED", "merged"],
  ["CLOSED", "closed"],
  ["OPEN", "open"],
]);

/** Maps `gh pr view --json <PR_FIELDS>` to a state. `login` is the person signed in to `gh`. */
export function prState(
  v: {
    title?: string;
    body?: string;
    state?: string;
    mergeable?: string;
    reviewDecision?: string;
    reviewRequests?: { login?: string }[];
    statusCheckRollup?: Check[];
    isDraft?: boolean;
    createdAt?: string;
    mergedAt?: string;
    headRefName?: string;
  },
  login?: string,
): PrState {
  const state = PR_STATES.get(v.state) ?? "unknown";
  const base = {
    state,
    ...(v.title ? { title: v.title } : {}),
    ...(v.body ? { body: v.body } : {}),
    ...(v.createdAt ? { opened_at: v.createdAt } : {}),
    ...(state === "merged" && v.mergedAt ? { merged_at: v.mergedAt } : {}),
    ...(v.headRefName ? { branch: v.headRefName } : {}),
  } as PrState;
  if (state !== "open") return base;
  const checks = checksOf(v.statusCheckRollup);
  const conflicts = v.mergeable === "CONFLICTING";
  const review_requested = Boolean(login && (v.reviewRequests ?? []).some((r) => r.login?.toLowerCase() === login.toLowerCase()));
  const blocked = v.reviewDecision === "CHANGES_REQUESTED" || v.reviewDecision === "REVIEW_REQUIRED";
  const draft = v.isDraft === true;
  const ready = !draft && v.mergeable === "MERGEABLE" && (checks === "green" || checks === "none") && !blocked;
  return { ...base, checks, conflicts, review_requested, ready, ...(draft ? { draft } : {}) };
}

/**
 * Runs `gh` with an argument array and resolves its standard output; rejects when it fails or is
 * missing, with what `gh` printed to standard error in the error's `stderr`.
 */
export type GhRunner = (args: string[]) => Promise<string>;

const runGh: GhRunner = (args) =>
  new Promise((resolve, reject) =>
    execFile("gh", args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (err, out, stderr) =>
      err ? reject(Object.assign(err, { stderr })) : resolve(out),
    ),
  );

// What `gh pr view` (GraphQL) prints when GitHub has no such repository or pull request. An HTTP 404
// isn't one: from GraphQL it means a misrouted host or proxy, which is a failure for now.
const NOT_FOUND = /Could not resolve to a (Repository|PullRequest)\b/;

/** Whether a failed `gh` call says the repository or pull request doesn't exist, not that reading it failed for now. */
export function notFound(err: unknown): boolean {
  return [field(err, "stderr"), field(err, "message")].some((t) => typeof t === "string" && NOT_FOUND.test(t));
}

/** How long a pull request's state is kept before `gh` is asked again. */
const PR_STATE_TTL_MS = 60_000;

/**
 * How long a closed or gone pull request's state is kept. Either can change back: a closed one can be
 * reopened, and "gone" is also what GitHub says of a private repository the signed-in `gh` account
 * (or a token) can't see.
 */
export const PR_SETTLED_TTL_MS = 30 * 60_000;

const settling = (s: PrState) => s.state === "closed" || s.state === "gone";

/** How long `s` is kept before `gh` is asked again: a merged one for good. */
const ttlOf = (s: PrState) => (s.state === "merged" ? Number.POSITIVE_INFINITY : settling(s) ? PR_SETTLED_TTL_MS : PR_STATE_TTL_MS);

type Cached = { at: number; state: PrState; login?: string };

/**
 * Pull request states for the pages process, from `gh`, read only when asked (Home is open) and at
 * most once a minute per pull request. A merged one isn't read again by this process; a closed or
 * gone one is read again after half an hour, or as soon as someone else is signed in to `gh`; one
 * that can't be read for now stays "unknown" and is read again after a minute.
 */
export class PrStates {
  /** Each state read, when, and who was signed in to `gh` then. */
  private cache = new Map<string, Cached>();
  private pending = new Map<string, Promise<PrState>>();
  private login?: { at: number; value?: string };

  constructor(private gh: GhRunner = runGh) {}

  private async whoami(): Promise<string | undefined> {
    if (this.login && Date.now() - this.login.at < PR_STATE_TTL_MS) return this.login.value;
    let value: string | undefined;
    try {
      value = (await this.gh(["api", "user", "--jq", ".login"])).trim() || undefined;
    } catch {
      /* no gh, or signed out */
    }
    this.login = { at: Date.now(), value };
    return value;
  }

  private async read(url: string): Promise<Omit<Cached, "at">> {
    try {
      const out = await this.gh(["pr", "view", url, "--json", PR_FIELDS]);
      const login = await this.whoami();
      return { state: prState(JSON.parse(out), login), login };
    } catch (err) {
      return notFound(err) ? { state: { state: "gone" }, login: await this.whoami() } : { state: { state: "unknown" } };
    }
  }

  /** Whether `c` still holds: within its time and, when closed or gone, read as the person signed in to `gh` now. */
  private async fresh(c: Cached): Promise<boolean> {
    if (Date.now() - c.at >= ttlOf(c.state)) return false;
    return !settling(c.state) || (await this.whoami()) === c.login;
  }

  /** The state last read for `url`, without asking `gh`; undefined before the first read. */
  known(url: string): PrState | undefined {
    return this.cache.get(url)?.state;
  }

  /**
   * The state of the pull request at `url`, read again once the one kept is out of date, or with
   * `now` unless it merged (a read already under way counts).
   */
  async get(url: string, now = false): Promise<PrState> {
    const c = this.cache.get(url);
    if (c && (c.state.state === "merged" || (!now && (await this.fresh(c))))) return c.state;
    let p = this.pending.get(url);
    if (!p) {
      p = this.read(url).then(({ state, login }) => {
        this.cache.set(url, { at: Date.now(), state, ...(login ? { login } : {}) });
        this.pending.delete(url);
        return state;
      });
      this.pending.set(url, p);
    }
    return p;
  }
}
