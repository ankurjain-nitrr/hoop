import { test } from "node:test";
import { everyPage } from "./every-page.js";
import { BROWSER_SKIP } from "./helpers.js";

test(
  "the ask pages and a review with question cards work in both themes, at phone width, from the keyboard, offline and with no serious accessibility problems",
  { skip: BROWSER_SKIP },
  () => everyPage("ask"),
);
