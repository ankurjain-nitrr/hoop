import { realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import type { FieldError } from "./contract.js";

/** A refusal for the agent or reviewer: a message and the fields it concerns. */
export class HoopError extends Error {
  /** Set when the refusal is already in the audit log, so callers don't log it twice. */
  audited = false;
  constructor(message: string, readonly errors: FieldError[] = []) {
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

/** Where reviews and the audit log live. */
export const hoopHome = () => process.env.HOOP_HOME ?? join(homedir(), ".hoop");

/**
 * A URL-safe slug: lowercase letters, digits and single hyphens, at most `max` characters, or
 * `fallback` when nothing is left. `trimEnd` also drops a hyphen left at the cut.
 */
export function slugify(text: string, opts: { max: number; fallback: string; trimEnd?: boolean }): string {
  let s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, opts.max);
  if (opts.trimEnd) s = s.replace(/-+$/, "");
  return s || opts.fallback;
}

/** Who is acting, when no name is given. */
export const currentUser = () => userInfo().username;

/** Writes through a temp file and a rename, so a reader never sees half a file; a symlink keeps pointing at the new file. */
export function writeAtomic(path: string, text: string) {
  let target = path;
  try { target = realpathSync(path); } catch { /* a new file */ }
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, target);
}

/** A markdown table's delimiter row, e.g. `|---|:-:|` (GFM: at least one dash per cell). */
export const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A table row's cells, split on unescaped pipes and trimmed; `\|` escapes stay in the cell. */
export function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
}
