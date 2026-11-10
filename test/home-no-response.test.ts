import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import type { ClaudeSession } from "../src/claude-sessions.js";
import { noResponse } from "../src/web.js";
import { saveWaitMark } from "../src/wait.js";
import { BROWSER_SKIP, example, TEST_SESSION, tempHome, withBrowser } from "./helpers.js";

// Home shows "No response yet" on a review Claude read without revising or replying, only while its
// session is idle or has ended (#271).

const comment = [{ item: "FR-3", line: 1, body: "Inclusive?" }];
const live = (status: string) => (): ClaudeSession[] => [{ session: TEST_SESSION, pid: process.pid, status }];

/** A review the person commented on and Claude read with hoop_feedback. */
function readReview() {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  hoop.review(review_id, { verdict: "comment", reviewer: "ana", comments: comment });
  hoop.receive(review_id);
  return { hoop, review_id, meta: () => hoop.store.meta(review_id) };
}

test("No response yet goes while a wait runs on the review, after Claude revises, and on a closed review", () => {
  const waiting = readReview();
  saveWaitMark(waiting.hoop.store.home, waiting.review_id, { pid: process.pid, started: new Date().toISOString() });
  assert.equal(noResponse(waiting.hoop, waiting.meta(), live("idle")), false, "a running hoop_wait may be about to answer");

  const revised = readReview();
  revised.hoop.submit({ ...example(), title: "Order export: v2", review_id: revised.review_id }, 1);
  assert.equal(noResponse(revised.hoop, revised.meta(), live("idle")), false, "a revision is Claude's response");

  const closed = readReview();
  closed.hoop.close(closed.review_id, "Not needed");
  assert.equal(noResponse(closed.hoop, closed.meta(), live("idle")), false, "a closed review asks for no response");
});

test("regression: a reviewer's Apply is no response from Claude, so No response yet stays", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const thread = hoop.review(review_id, { verdict: "comment", reviewer: "ana", comments: [{ item: "FR-3", line: 0, suggestion: "Export dates inclusively" }] })
    .comments[0]!.thread!;
  hoop.receive(review_id);
  hoop.applySuggestion(review_id, thread, "ana");
  assert.equal(hoop.store.meta(review_id).revisions, 2, "the Apply made a revision");
  assert.equal(noResponse(hoop, hoop.store.meta(review_id), live("idle")), true);
});

test("regression: a review read only by another session is unread for its owner, and never No response yet with it", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  hoop.review(review_id, { verdict: "comment", reviewer: "ana", comments: comment });
  new Hoop(hoop.store, "other-session-5555").receive(review_id);
  assert.equal(noResponse(hoop, hoop.store.meta(review_id), live("idle")), false);
});

test("No response yet: read and not answered, only while the session is idle or ended, and never on an approval", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const meta = () => hoop.store.meta(review_id);
  hoop.review(review_id, { verdict: "comment", reviewer: "ana", comments: comment });
  assert.equal(noResponse(hoop, meta(), live("idle")), false, "not read yet");
  hoop.receive(review_id);
  assert.equal(noResponse(hoop, meta(), live("idle")), true, "read, and the session idles");
  assert.equal(
    noResponse(hoop, meta(), () => []),
    true,
    "read, and the session ended",
  );
  assert.equal(noResponse(hoop, meta(), live("busy")), false, "hidden while the session works");
  hoop.reply(hoop.store.feedback(review_id, 1)[0]!.comments[0]!.thread!, "Yes, inclusive.");
  assert.equal(noResponse(hoop, meta(), live("idle")), false, "gone once Claude replies");

  const approved = hoop.submit(example()).review_id;
  hoop.review(approved, { verdict: "approved", reviewer: "ana" });
  hoop.receive(approved);
  assert.equal(noResponse(hoop, hoop.store.meta(approved), live("idle")), false, "an approval asks for no response");
});

test("Home's row shows No response yet beside the review, in the info tone", { skip: BROWSER_SKIP }, async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  hoop.review(review_id, { verdict: "changes_requested", reviewer: "ana", comments: comment });
  hoop.receive(review_id);
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(base);
      const badge = page.locator(`.list a[href="/r/${review_id}"] [data-status="no_response"]`);
      await badge.waitFor();
      assert.equal((await badge.textContent())?.trim(), "No response yet");
      assert.equal(await page.locator(`.list a[href="/r/${review_id}"] [data-status="unread"]`).count(), 0);
    },
    hoop,
    { sessions: live("idle") },
  );
});
