import { randomBytes } from "node:crypto";

/** The pattern, without anchors, of an ID that `newId(prefix)` makes: `prefix`, `_`, lowercase letters and digits. */
export const idPattern = (prefix: string) => `${prefix}_[a-z0-9]+`;

/** A review ID's pattern without anchors, for building URL and route patterns. */
export const REVIEW_ID_PATTERN = idPattern("rv");
const REVIEW_ID = new RegExp(`^${REVIEW_ID_PATTERN}$`);

/** Whether `v` is a review ID: `rv_` and lowercase letters and digits. */
export const isReviewId = (v: unknown): v is string => typeof v === "string" && REVIEW_ID.test(v);

/** A new ID: `prefix`, the time in base 36 and six random hex digits. A caller that needs it unique draws again while it is taken. */
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

/** Threads, proposed edits and build threads: their IDs embed their review's ID, so an ID alone finds its review. */
type ChildKind = "th" | "ed" | "bt";

const REVIEW_PART = REVIEW_ID_PATTERN.slice("rv_".length);

/** The pattern, without anchors or groups, of a child ID of `kind`. */
export const childPattern = (kind: ChildKind) => `${kind}_${REVIEW_PART}_\\d+`;
const CHILD = new RegExp(`^(th|ed|bt)_(${REVIEW_PART})_\\d+$`);

/** The `n`th thread, edit or build thread of review `reviewId`. */
export function childId(kind: ChildKind, reviewId: string, n: number): string {
  if (!isReviewId(reviewId)) throw new Error(`invalid review id ${reviewId}`);
  return `${kind}_${reviewId.slice("rv_".length)}_${n}`;
}

/** The review that a thread, edit or build thread ID of one of `kinds` belongs to; undefined for any other ID. */
export function reviewOfChild(id: string, kinds: readonly ChildKind[]): string | undefined {
  const m = id.match(CHILD);
  return m && kinds.includes(m[1] as ChildKind) ? `rv_${m[2]}` : undefined;
}

/** One more than the largest number that ends an ID in `ids`, or 1 when none does. */
export const nextSeq = (ids: readonly string[]) => Math.max(0, ...ids.map((id) => Number(id.match(/\d+$/)?.[0]) || 0)) + 1;
