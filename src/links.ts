// Links to hoop's pages as a person opens them: the pages' origin on this machine, with the pages
// port, and the paths from web/links.js, which the pages share.
import { reviewPath } from "../web/links.js";
import { pagesPort } from "./util.js";

/** Where this machine's pages answer: `http://localhost:<pages port>`. */
export const PAGES_ORIGIN = `http://localhost:${pagesPort()}`;

/** hoop's Home page. */
export const homeUrl = () => `${PAGES_ORIGIN}/`;

/** Review `id`'s page. */
export const reviewUrl = (id: string) => `${PAGES_ORIGIN}${reviewPath(id)}`;
