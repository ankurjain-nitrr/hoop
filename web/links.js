// Links to hoop's pages, shared by the pages and the server: the path a review lives at, and how a
// link to one on this machine is recognised in text. The server adds the origin (src/links.ts).

/** A review ID's pattern, without anchors (src/ids.ts makes the IDs). */
const ID = "rv_[a-z0-9]+";
/** A link to a hoop page on this machine, up to its path. */
const LOCAL = "https?://(?:localhost|127\\.0\\.0\\.1)(?::\\d+)?";

/**
 * The path of review `id`'s page.
 * @param {string} id
 */
export const reviewPath = (id) => `/r/${encodeURIComponent(id)}`;

/** A whole link to a review's page on this machine, its review ID captured: `http://localhost:4747/r/rv_…`. */
export const REVIEW_LINK = new RegExp(`^${LOCAL}/r/(${ID})/?$`);

/** Links to review pages on this machine anywhere in a text. */
export const REVIEW_LINKS = new RegExp(`${LOCAL}/r/${ID}`, "g");

/** A review page's path anywhere in a text. */
export const REVIEW_PATH = new RegExp(`/r/${ID}`);

/**
 * The review ID in a review page's path, or undefined for any other path.
 * @param {string} path
 * @returns {string | undefined}
 */
export const reviewOfPath = (path) => path.match(new RegExp(`^/r/(${ID})$`))?.[1];
