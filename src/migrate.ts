import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionHoop, validSession } from "./owner.js";
import { Registry } from "./registry.js";
import { readJsonDir, tryReadJson, writeJson } from "./util.js";

/** What the move of reviews into their sessions' folders did. */
export type MigrationReport = { moved: number; stayed: number; failed: number };

/** Written in the home folder once every review was moved or found a reason to stay. */
const MARKER = "migrated.json";

/** Files a review folder holds only for a moment: locks and half-written temp files. */
const transient = (name: string) => /\.(lock|tmp|stale)$/.test(name);

/** A review folder's lasting files, by name. */
const filesOf = (dir: string) =>
  readdirSync(dir)
    .filter((n) => !transient(n) && statSync(join(dir, n)).isFile())
    .sort();

/** True when a review folder holds something besides files, which a move would not carry: it stays. */
const hasFolders = (dir: string) => readdirSync(dir).some((n) => !statSync(join(dir, n)).isFile());

/** True when `b` holds exactly `a`'s lasting files, byte for byte. */
function sameFiles(a: string, b: string): boolean {
  try {
    const names = filesOf(a);
    if (names.join("\n") !== filesOf(b).join("\n")) return false;
    return names.every((n) => readFileSync(join(a, n)).equals(readFileSync(join(b, n))));
  } catch {
    return false;
  }
}

/** Each plan review's session, from the plan hook's records in `plans/<session>.json`. */
function planSessions(home: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, v] of readJsonDir<{ review_id?: unknown } | null>(join(home, "plans"))) {
    const id = v?.review_id;
    if (typeof id === "string") out.set(id, name.slice(0, -".json".length));
  }
  return out;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Moves one review from the home folder into the `.hoop` of the Claude Code session that owns it,
 * beside the session's transcript. Returns false when the review has no Claude Code session, or the session's
 * folder is gone, and it stays.
 *
 * Every step can be cut short and run again: the copy goes to a temp folder, is checked byte for
 * byte and renamed into place; the index names it next; the original is removed last. A copy the
 * index already names is the review, and the original left beside it is removed.
 */
export function migrateReview(home: string, id: string, registry: Registry, plans: Map<string, string>): boolean {
  const src = join(home, "reviews", id);
  const indexed = registry.folderOf(id);
  if (indexed && existsSync(join(indexed, "reviews", id, "review.json"))) {
    rmSync(src, { recursive: true, force: true });
    return true;
  }
  const meta = tryReadJson<{ owner?: { session?: unknown; claude?: unknown } }>(join(src, "review.json"));
  if (!meta) return false;
  // A session outside Claude Code keeps its reviews in the hoop home folder.
  if (meta.owner?.claude === false) return false;
  const session = validSession(meta.owner?.session) ?? plans.get(id);
  const folder = sessionHoop(session);
  if (!folder || hasFolders(src)) return false;
  try {
    return moveInto(src, id, folder, registry);
  } catch (err) {
    // Another run moved it meanwhile and removed the original.
    if (!existsSync(src) && registry.folderOf(id)) return true;
    throw err;
  }
}

function moveInto(src: string, id: string, folder: string, registry: Registry): boolean {
  mkdirSync(join(folder, "reviews"), { recursive: true });
  const reviews = join(folder, "reviews"),
    dest = join(reviews, id);
  if (!sameFiles(src, dest)) {
    // A copy that differs was cut short, or the original changed since: copy again.
    for (const n of readdirSync(reviews)) if (n.startsWith(`.${id}.`) && n.endsWith(".migrating")) rmSync(join(reviews, n), { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
    const tmp = join(reviews, `.${id}.${process.pid}.migrating`);
    mkdirSync(tmp);
    for (const n of filesOf(src)) copyFileSync(join(src, n), join(tmp, n));
    if (!sameFiles(src, tmp)) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`the copy of ${id} doesn't match the original`);
    }
    renameSync(tmp, dest);
  }
  registry.set(id, folder);
  rmSync(src, { recursive: true, force: true });
  return true;
}

/**
 * Moves the reviews kept in the home folder by earlier releases into the `.hoop` folders of the
 * Claude Code sessions that own them, once. Reviews with nowhere to go stay, and stay readable. It runs until every review has
 * moved or stays; a run cut short goes on the next time. `report` gets one line when anything moved
 * or stayed.
 */
export function migrateHome(home: string, opts: { report?: (text: string) => void } = {}): MigrationReport | undefined {
  const marker = join(home, MARKER);
  if (existsSync(marker)) return undefined;
  const registry = new Registry(home),
    plans = planSessions(home);
  const report: MigrationReport = { moved: 0, stayed: 0, failed: 0 };
  let ids: string[] = [];
  try {
    ids = readdirSync(join(home, "reviews")).filter((n) => /^rv_[a-z0-9]+$/.test(n) && isDir(join(home, "reviews", n)));
  } catch {
    /* no reviews */
  }
  for (const id of ids) {
    try {
      if (migrateReview(home, id, registry, plans)) report.moved++;
      else report.stayed++;
    } catch {
      report.failed++;
    }
  }
  if (!report.failed) writeJson(marker, { at: new Date().toISOString(), ...report }, { compact: true });
  if (report.moved || report.stayed || report.failed)
    opts.report?.(
      `moved ${report.moved} ${report.moved === 1 ? "review" : "reviews"} into their Claude Code sessions' folders; ` +
        `${report.stayed} stayed in ${join(home, "reviews")}` +
        (report.failed ? `; ${report.failed} could not move yet and stay readable there` : ""),
    );
  return report;
}
