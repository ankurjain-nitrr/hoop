import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIEW_ID_PATTERN } from "../src/ids.js";
import { homeUrl, PAGES_ORIGIN, reviewUrl } from "../src/links.js";
import { pagesPort } from "../src/util.js";
import { REVIEW_LINK, REVIEW_LINKS, REVIEW_PATH, reviewOfPath, reviewPath } from "../web/links.js";

test("a review's page and Home are on this machine's pages port", () => {
  assert.equal(PAGES_ORIGIN, `http://localhost:${pagesPort()}`);
  assert.equal(homeUrl(), `${PAGES_ORIGIN}/`);
  assert.equal(reviewPath("rv_abc123"), "/r/rv_abc123");
  assert.equal(reviewUrl("rv_abc123"), `${PAGES_ORIGIN}/r/rv_abc123`);
});

test("a link to a review page on this machine is recognised, with its ID, and no other link is", () => {
  for (const url of ["http://localhost:4747/r/rv_abc123", "http://127.0.0.1:4791/r/rv_abc123/", "https://localhost/r/rv_abc123"])
    assert.equal(url.match(REVIEW_LINK)?.[1], "rv_abc123", url);
  for (const url of ["http://example.com/r/rv_abc123", "http://localhost:4747/r/rv_ABC", "http://localhost:4747/r/rv_abc123#x", "http://localhost:4747/"])
    assert.equal(REVIEW_LINK.test(url), false, url);
  const text = "See http://localhost:4747/r/rv_one1 and http://127.0.0.1:4747/r/rv_two2, not https://github.com/a/b/pull/1.";
  assert.deepEqual(
    [...text.matchAll(REVIEW_LINKS)].map((m) => m[0]),
    ["http://localhost:4747/r/rv_one1", "http://127.0.0.1:4747/r/rv_two2"],
  );
  assert.equal(REVIEW_PATH.test("opened /r/rv_abc123 today"), true);
  assert.equal(REVIEW_PATH.test("opened /r/other today"), false);
});

test("a review page's path gives its ID; any other path gives none", () => {
  assert.equal(reviewOfPath("/r/rv_abc123"), "rv_abc123");
  for (const path of ["/", "/work", "/r/rv_abc123/", "/r/x", "/api/reviews/rv_abc123"]) assert.equal(reviewOfPath(path), undefined, path);
});

test("the pages' review ID pattern is the one hoop makes IDs with", () => {
  assert.ok(REVIEW_LINK.source.includes(`(${REVIEW_ID_PATTERN})`), REVIEW_LINK.source);
});
