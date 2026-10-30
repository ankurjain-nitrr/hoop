import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import type { FieldError } from "./contract.js";

/** A refusal for the agent or reviewer: a message, the fields it concerns, and anything it hands back (`detail`). */
export class HoopError extends Error {
  constructor(
    message: string,
    readonly errors: FieldError[] = [],
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The repository hoop works in. */
export const repoDir = () => process.env.HOOP_REPO_DIR ?? process.cwd();

/** A folder's identity for the pages: a display name and an opaque key, so pages never read paths. */
export type RepoIdentity = { name: string; key: string };

/** The identity of a repository folder, or undefined when the folder is missing or unreadable. */
export function repoIdentity(dir: string | undefined): RepoIdentity | undefined {
  if (!dir) return undefined;
  try {
    // The native call gives the folder's real spelling, so one folder gets one key on case-blind disks.
    const real = realpathSync.native(dir);
    if (!statSync(real).isDirectory()) return undefined;
    return { name: basename(real), key: createHash("sha256").update(real).digest("hex").slice(0, 16) };
  } catch {
    return undefined;
  }
}

/** The top folder of the git repository that holds `dir`, or undefined when it is in none or is missing. */
export function gitRoot(dir: string): string | undefined {
  try {
    if (!statSync(dir).isDirectory()) return undefined;
    // Without git's own variables, so a hook's GIT_DIR never points git at another repository.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return top ? realpathSync.native(top) : undefined;
  } catch {
    return undefined;
  }
}

/** Where reviews live. */
export const hoopHome = () => process.env.HOOP_HOME ?? join(homedir(), ".hoop");

/**
 * A URL-safe slug: lowercase letters, digits and single hyphens, at most `max` characters, or
 * `fallback` when nothing is left. `trimEnd` also drops a hyphen left at the cut.
 */
export function slugify(text: string, opts: { max: number; fallback: string; trimEnd?: boolean }): string {
  let s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, opts.max);
  if (opts.trimEnd) s = s.replace(/-+$/, "");
  return s || opts.fallback;
}

/**
 * `text` cut to at most `max` characters, never mid-word: at the end of a sentence when one ends in
 * the second half (a Chinese or Japanese full stop needs no space after it), else at a space, with
 * an ellipsis. Only a single word longer than half of `max` is cut inside, and never inside a
 * surrogate pair. Under 3 characters, only the ellipsis fits.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 3) return "…".slice(0, Math.max(0, max));
  // Never split a surrogate pair, such as an emoji.
  let end = max - 2;
  if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  const cut = text.slice(0, end);
  const spaced = Math.max(...[". ", "! ", "? "].map((stop) => cut.lastIndexOf(stop)));
  // Chinese and Japanese full stops end a sentence with no space after them.
  const full = Math.max(...["。", "！", "？"].map((stop) => cut.lastIndexOf(stop)));
  if (full > spaced && full >= max / 2) return `${cut.slice(0, full + 1)}…`;
  if (spaced >= max / 2) return `${cut.slice(0, spaced + 1)} …`;
  const space = cut.lastIndexOf(" ");
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** Who is acting, when no name is given. */
export const currentUser = () => userInfo().username;

/** Writes through a temp file and a rename, so a reader never sees half a file; a symlink keeps pointing at the new file. `mode` sets the file's permissions. */
export function writeAtomic(path: string, text: string, mode?: number) {
  let target = path;
  try {
    target = realpathSync(path);
  } catch {
    /* a new file */
  }
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  renameSync(tmp, target);
}

/**
 * A JSON file's value, typed as the caller expects, which it doesn't check. A file that isn't there
 * (or whose path can't name one) gives `fallback` when it isn't undefined; any other failure throws.
 */
export function readJson<T>(path: string, fallback?: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    if (fallback !== undefined && !existsSync(path)) return fallback;
    throw e;
  }
}

/** Whether a parsed JSON value is an object other than an array, so its fields can be checked one by one. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A JSON file's value, or undefined when it is missing, unreadable or not JSON. */
export function tryReadJson<T = unknown>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The readable `.json` files in `dir` whose names pass `keep`, as [name, value] pairs; none when `dir` is missing. */
export function readJsonDir<T = unknown>(dir: string, keep: (name: string) => boolean = () => true): [string, T][] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && keep(n));
  } catch {
    return [];
  }
  return names.flatMap((n): [string, T][] => {
    const v = tryReadJson<T>(join(dir, n));
    return v === undefined ? [] : [[n, v]];
  });
}

/** Writes `value` as JSON through `writeAtomic`, two-space indented or `compact`, with a final newline. */
export function writeJson(path: string, value: unknown, opts: { compact?: boolean } = {}) {
  writeAtomic(path, `${opts.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`);
}
