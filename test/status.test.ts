import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { reviewStatus } from "../src/rules.js";
import { REVIEW, statusBadge, statusChip } from "../web/status.js";
import { example, tempHome } from "./helpers.js";

test("FR-2: every review gets one status key from the server", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.submit(example());
  const key = () => reviewStatus(hoop.store, hoop.store.meta(id));
  assert.deepEqual(key(), { status_key: "awaiting_review" });
  hoop.review(id, { verdict: "comment", comments: [{ item: "FR-1", line: 1, body: "Why?" }] });
  assert.deepEqual(key(), { status_key: "commented" });
  hoop.review(id, { verdict: "changes_requested" });
  assert.deepEqual(key(), { status_key: "changes_requested" });
  hoop.submit({ ...example(), review_id: id });
  assert.deepEqual(key(), { status_key: "awaiting_review" }, "a new revision waits for review again");
  hoop.review(id, { verdict: "approved" });
  assert.deepEqual(key(), { status_key: "approved" });
  const closed = hoop.submit(example()).review_id;
  hoop.store.update(closed, { status: "closed" });
  assert.deepEqual(reviewStatus(hoop.store, hoop.store.meta(closed)), { status_key: "closed" });
});

test("FR-2: a GitHub review approved but not merged stays awaiting review, with a note", () => {
  const store = new Store(tempHome()), hoop = new Hoop(store);
  const { review_id: id } = hoop.submit(example());
  store.update(id, { github: { repo: "a/b", pr: 1, branch: "x", url: "https://x/1" } });
  store.addFeedback(id, { schema: "hoop/feedback@0", review_id: id, revision: 1, verdict: "approved", comments: [], answers: [], resolved_threads: [], viewed: [], reviewer: "priya", at: "t" });
  assert.deepEqual(reviewStatus(store, store.meta(id)), { status_key: "awaiting_review", status_note: "Approved on GitHub, waiting for merge" });
});

test("FR-2: each status has one label and icon; tracker chips match any case and show unknown values as neutral", () => {
  for (const key of ["awaiting_review", "commented", "changes_requested", "approved", "closed"]) {
    assert.ok(REVIEW[key], key);
    assert.match(statusBadge(key), new RegExp(`data-status="${key}".*<svg.*${REVIEW[key]!.label}`));
  }
  assert.ok(statusBadge("awaiting_review", "Approved on GitHub, waiting for merge").includes('badge-note">Approved on GitHub'));
  assert.equal(statusChip("Todo"), statusChip("todo"));
  assert.ok(statusChip("In Progress").includes('tone-info s-in-progress">in progress<'));
  const unknown = statusChip("Someday <b>");
  assert.ok(unknown.includes("tone-neutral") && unknown.includes("someday &lt;b&gt;"), "unknown values are neutral and escaped");
});
