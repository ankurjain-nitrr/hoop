import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "./lock.js";
import { type Agent, type Owner, ownerOf, validSession } from "./owner.js";
import { HoopError, writeAtomic } from "./util.js";

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

/** Every tracked pull request, oldest first; none when the file is missing or unreadable. */
export function trackedPrs(home: string): TrackedPr[] {
  try {
    const v = JSON.parse(readFileSync(file(home), "utf8"));
    return Array.isArray(v?.prs) ? v.prs.filter((p: TrackedPr) => typeof p?.url === "string" && parsePrUrl(p.url) && validSession(p.owner?.session)) : [];
  } catch {
    return [];
  }
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
  return withLock(`${file(home)}.lock`, () => {
    const prs = trackedPrs(home);
    const known = prs.find((p) => p.url === clean);
    if (known) return { ...known, already: true };
    const pr: TrackedPr = {
      url: clean,
      owner: ownerOf(typeof session === "string" ? { session, claude: true } : session, home),
      added: new Date().toISOString(),
    };
    writeAtomic(file(home), `${JSON.stringify({ prs: [...prs, pr] }, null, 2)}\n`);
    return { ...pr, already: false };
  });
}

/**
 * The pull request a Claude Code `PostToolUse` hook on Bash saw opened, or undefined: the command
 * runs `gh pr create`, and its output holds the new pull request's URL (the last one, as gh prints it last).
 */
export function openedPr(input: unknown): string | undefined {
  const i = input as { tool_input?: { command?: unknown }; tool_response?: unknown } | undefined;
  const command = i?.tool_input?.command;
  if (typeof command !== "string" || !/\bgh\s+pr\s+create\b/.test(command)) return undefined;
  const r = i?.tool_response as { stdout?: unknown } | string | undefined;
  const out = typeof r === "string" ? r : typeof r?.stdout === "string" ? r.stdout : "";
  return out.match(PR_URL_IN_TEXT)?.pop();
}

/** Runs the hook on its input: tracks the pull request it saw opened, for the hook's session. Never throws. */
export function prHook(home: string, input: unknown, envSession?: string): TrackedPr | undefined {
  try {
    const url = openedPr(input);
    const session = validSession((input as { session_id?: unknown })?.session_id) ?? envSession;
    return url && session ? trackPr(home, url, session) : undefined;
  } catch {
    return undefined;
  }
}

/** A pull request's state as Home shows it. Without `gh`, or signed out, `state` is "unknown". */
export type PrState = {
  state: "open" | "merged" | "closed" | "unknown";
  title?: string;
  body?: string;
  /** The checks on its head commit: none, still running, any failed, or all passed. */
  checks?: "none" | "running" | "failing" | "green";
  conflicts?: boolean;
  /** A review is asked of the person signed in to `gh`. */
  review_requested?: boolean;
  ready?: boolean;
};

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const RUNNING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

type Check = { status?: string; conclusion?: string; state?: string };

/** The checks' overall result, from `statusCheckRollup` (check runs and commit statuses). */
export function checksOf(rollup: Check[] | undefined): NonNullable<PrState["checks"]> {
  const results = (rollup ?? []).map((c) => (c.state ?? (c.status && c.status !== "COMPLETED" ? c.status : c.conclusion) ?? "").toUpperCase());
  if (!results.length) return "none";
  if (results.some((r) => FAILED.has(r))) return "failing";
  if (results.some((r) => RUNNING.has(r) || r === "")) return "running";
  return "green";
}

/** Maps `gh pr view --json title,body,state,mergeable,reviewDecision,reviewRequests,statusCheckRollup` to a state. `login` is the person signed in to `gh`. */
export function prState(
  v: {
    title?: string;
    body?: string;
    state?: string;
    mergeable?: string;
    reviewDecision?: string;
    reviewRequests?: { login?: string }[];
    statusCheckRollup?: Check[];
  },
  login?: string,
): PrState {
  const state = v.state === "MERGED" ? "merged" : v.state === "CLOSED" ? "closed" : v.state === "OPEN" ? "open" : "unknown";
  const base = { state, ...(v.title ? { title: v.title } : {}), ...(v.body ? { body: v.body } : {}) } as PrState;
  if (state !== "open") return base;
  const checks = checksOf(v.statusCheckRollup);
  const conflicts = v.mergeable === "CONFLICTING";
  const review_requested = Boolean(login && (v.reviewRequests ?? []).some((r) => r.login?.toLowerCase() === login.toLowerCase()));
  const blocked = v.reviewDecision === "CHANGES_REQUESTED" || v.reviewDecision === "REVIEW_REQUIRED";
  const ready = v.mergeable === "MERGEABLE" && (checks === "green" || checks === "none") && !blocked;
  return { ...base, checks, conflicts, review_requested, ready };
}

/** Runs `gh` with an argument array and resolves its standard output; rejects when it fails or is missing. */
export type GhRunner = (args: string[]) => Promise<string>;

export const runGh: GhRunner = (args) =>
  new Promise((resolve, reject) =>
    execFile("gh", args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );

/** How long a pull request's state is kept before `gh` is asked again. */
export const PR_STATE_TTL_MS = 60_000;

/**
 * Pull request states for the pages process, from `gh`, read only when asked (Home is open) and at
 * most once a minute per pull request. A merged or closed one is never read again.
 */
export class PrStates {
  private cache = new Map<string, { at: number; state: PrState }>();
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

  private async read(url: string): Promise<PrState> {
    try {
      const out = await this.gh(["pr", "view", url, "--json", "title,body,state,mergeable,reviewDecision,reviewRequests,statusCheckRollup"]);
      return prState(JSON.parse(out), await this.whoami());
    } catch {
      return { state: "unknown" };
    }
  }

  /** The state of the pull request at `url`, read again when older than a minute. */
  get(url: string): Promise<PrState> {
    const c = this.cache.get(url);
    if (c && (c.state.state === "merged" || c.state.state === "closed" || Date.now() - c.at < PR_STATE_TTL_MS)) return Promise.resolve(c.state);
    let p = this.pending.get(url);
    if (!p) {
      p = this.read(url).then((state) => {
        this.cache.set(url, { at: Date.now(), state });
        this.pending.delete(url);
        return state;
      });
      this.pending.set(url, p);
    }
    return p;
  }
}
