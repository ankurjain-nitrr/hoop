import { test } from "node:test";
import { everyPage } from "./every-page.js";
import { BROWSER_SKIP } from "./helpers.js";

test(
  "the review, approved and document pages work in both themes, at phone width, from the keyboard, offline and with no serious accessibility problems",
  { skip: BROWSER_SKIP },
  () => everyPage("review"),
);
