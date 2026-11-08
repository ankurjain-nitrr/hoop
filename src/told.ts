// The told-once ledger: what a gate already told a session, so each cause blocks or refuses once.
// A session's work record keeps one list per gate (the Stop gate's `stop_told`, the done gate's
// `done_told`, the work gate's `queue_told` and `blocked_told`); the review gate keeps its own file.
// Only the pages process writes them, inside its edit of the record.

/** How many told keys a list keeps: the latest ones. */
export const TOLD_MAX = 50;

/** The lists a work record keeps of what its gates told. */
export type ToldList = "stop_told" | "done_told" | "queue_told" | "blocked_told";

/** The keys a record's `list` holds; none when it holds anything else. */
export const toldIn = (r: Partial<Record<ToldList, unknown>>, list: ToldList): string[] => {
  const v = r[list];
  return Array.isArray(v) ? v : [];
};

/**
 * `told` with `keys` added at the end, keeping the latest TOLD_MAX. With `move`, a key told before
 * leaves its old place, so it counts as told just now.
 */
export function withTold(told: readonly string[], keys: readonly string[], move = false): string[] {
  const kept = move ? told.filter((k) => !keys.includes(k)) : told;
  return [...kept, ...keys].slice(-TOLD_MAX);
}

/** Records `keys` as told in the record's `list`. */
export function tell(r: Partial<Record<ToldList, unknown>>, list: ToldList, keys: readonly string[], move = false): void {
  r[list] = withTold(toldIn(r, list), keys, move);
}
