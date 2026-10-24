// Where a comment thread or a quick question's card shows on a review page, as its line changes in
// later revisions. Both point at `{item, line, revision}`: line n >= 1 is an item line, 0 its heading.

/**
 * Whether something on `at` shows below line `idx` (0-based, -1 the heading) of an item with `count`
 * lines: on its own line, or, when its line is gone, under the item's last line.
 */
export const showsBelow = (at, item, idx, count) => at.item === item && (at.line === idx + 1 || (idx === count - 1 && at.line > count));

/**
 * Whether its line changed since: its text in the revision it was made on (`then`) differs from the
 * text now, or the line is gone. Nothing made on the latest revision is outdated.
 */
export const isOutdated = (at, latest, then, now) => at.revision !== latest && (then === undefined || then !== now);
