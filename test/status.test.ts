import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { reviewStatus } from "../src/rules.js";
import { REVIEW, statusBadge } from "../web/status.js";
import { example, tempHome } from "./helpers.js";

test("every review gets one status key from the server", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.submit(example());
  const key = () => reviewStatus(hoop.store, hoop.store.meta(id));
  assert.deepEqual(key(), { status_key: "awaiting_review" });
  hoop.review(id, { verdict: "comment", comments: [{ item: "FR-1", line: 1, body: "Why?" }] });
  assert.deepEqual(key(), { status_key: "commented" });
  hoop.review(id, { verdict: "changes_requested", summary: "Split it." });
  assert.deepEqual(key(), { status_key: "changes_requested" });
  hoop.receive(id);
  hoop.submit({ ...example(), review_id: id });
  assert.deepEqual(key(), { status_key: "awaiting_review" }, "a new revision waits for review again");
  hoop.review(id, { verdict: "approved", resolved_threads: (hoop.threads(id).threads ?? []).map((t) => t.thread) });
  assert.deepEqual(key(), { status_key: "approved" });
});

test("inherited object keys show as unknown statuses, not as broken markup", () => {
  // Regression: "constructor" and "toString" used to find Object.prototype entries.
  assert.match(statusBadge("toString"), /tone-muted[\s\S]*<span>toString<\/span>/);
  assert.doesNotMatch(statusBadge("toString"), /undefined/);
});

test("each status has one label and icon", () => {
  for (const key of ["awaiting_review", "commented", "changes_requested", "approved"]) {
    assert.ok(REVIEW[key], key);
    assert.match(statusBadge(key), new RegExp(`data-status="${key}".*<svg.*${REVIEW[key]!.label}`));
  }
});
