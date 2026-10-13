import { realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { FieldError } from "./contract.js";

/** A refusal for the agent or reviewer: a message and the fields it concerns. */
export class HoopError extends Error {
  constructor(message: string, readonly errors: FieldError[] = []) {
    super(message);
  }
}

/** The repository hoop works in. */
export const repoDir = () => process.env.HOOP_REPO_DIR ?? process.cwd();

/** Where reviews and the audit log live. */
export const hoopHome = () => process.env.HOOP_HOME ?? join(homedir(), ".hoop");

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
