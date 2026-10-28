import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { type AddressInfo, createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { waitForAsk, waitForReview } from "../src/wait.js";
import { CLOSE_KEY, closeMessage } from "../src/wake.js";
import { OPS } from "../src/ops.js";
import type { FeedbackResult } from "../src/hoop.js";
import { createWebServer, type PagesOptions } from "../src/web.js";
import { BROWSER_SKIP, example, TEST_SESSION, tempHome, withBrowser } from "./helpers.js";

const TITLE = "Order export: requirements";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withServer(opts: PagesOptions, fn: (base: string, hoop: Hoop) => Promise<void>) {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop, [], opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hoop);
  } finally {
    server.close();
  }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

/** A fake session socket that collects the lines written to it. */
async function fakeSocket() {
  const path = join(mkdtempSync(join(tmpdir(), "hc-")), "s.sock");
  const lines: string[] = [];
  const server = createSocketServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, lines, close: () => server.close() };
}

test("a person closes a review on its page: it is Closed, never approved, and Claude's live session hears why", async () => {
  const sock = await fakeSocket();
  try {
    await withServer({ sessions: () => [{ session: TEST_SESSION, pid: 1, status: "idle", socket: sock.path }] }, async (base, hoop) => {
      const { review_id } = hoop.submit(example());
      const res = await post(`${base}/api/reviews/${review_id}/close`, { reason: "The session ended" });
      assert.equal(res.status, 201);
      assert.equal(res.body.status_key, "closed");
      assert.equal(res.body.meta.closed.reason, "The session ended");
      assert.equal(res.body.delivery.outcome, "sent");
      const row = ((await (await fetch(`${base}/api/reviews`)).json()) as { id: string; status_key: string }[]).find((m) => m.id === review_id);
      assert.equal(row?.status_key, "closed");
      // Closing records no approval.
      const meta = hoop.store.meta(review_id);
      assert.equal(meta.status, "open");
      assert.equal(meta.approved_at, undefined);
      assert.ok(!hoop.store.allFeedback(review_id).some((f) => f.verdict === "approved"));
      for (let i = 0; i < 50 && !sock.lines.length; i++) await sleep(20);
      assert.equal(JSON.parse(sock.lines[0]!).message.content, `Closed in hoop: ${TITLE} (${review_id}), not approved: stop work on it. The session ended`);
      // The delivery is kept on the review, as a submitted review's is.
      assert.equal(hoop.store.deliveries(review_id)[CLOSE_KEY]?.outcome, "sent");
      // Closing twice, or a review on a closed review, is refused.
      assert.equal((await post(`${base}/api/reviews/${review_id}/close`, {})).status, 400);
      const fb = await post(`${base}/api/reviews/${review_id}/feedback`, { verdict: "approved", comments: [] });
      assert.equal(fb.status, 400);
      assert.match(fb.body.error, /closed .* without approving it: The session ended/);
      // Reopening tells the session too.
      const reopened = await post(`${base}/api/reviews/${review_id}/reopen`, {});
      assert.equal(reopened.body.delivery.outcome, "sent");
      for (let i = 0; i < 50 && sock.lines.length < 2; i++) await sleep(20);
      assert.equal(JSON.parse(sock.lines[1]!).message.content, `Reopened in hoop: ${TITLE} (${review_id}). It waits for the person's review again.`);
    });
  } finally {
    sock.close();
  }
});

test("hoop_feedback and hoop_wait report a closed review, and a revision of it is refused with the reason", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  // Earlier feedback stays readable, under status "closed", never as pending or an approval.
  hoop.review(review_id, { verdict: "changes_requested", reviewer: "bo", comments: [], summary: "Split it." });
  hoop.close(review_id, "Not needed any more", "ana");
  const viaTool = (await OPS.find((o) => o.name === "wait")!.run(hoop, { review_id, seconds: 5 } as never, { actor: "claude" })) as FeedbackResult;
  assert.equal(viaTool.status, "closed");
  assert.ok(!viaTool.approved && viaTool.feedback.length === 1);
  assert.equal(hoop.feedback(review_id).status, "closed");
  assert.deepEqual({ ...hoop.feedback(review_id).closed, at: undefined }, { by: "ana", reason: "Not needed any more", at: undefined });
  const waited = await waitForReview(hoop, review_id, { intervalMs: 10, timeoutMs: 5000 });
  assert.equal(waited?.closed?.reason, "Not needed any more");
  assert.throws(() => hoop.submit({ ...example(), review_id }), /ana closed .* without approving it: Not needed any more/);
  // Closing without a reason says so too.
  const ask = hoop.ask({ questions: [{ question: "Keep it?", options: [{ label: "Yes", recommended: true }, { label: "No" }] }] }).review_id;
  hoop.close(ask);
  assert.ok((await waitForAsk(hoop, ask, { intervalMs: 10, timeoutMs: 5000 }))?.closed);
  assert.equal(closeMessage(hoop.store.meta(ask)), `Closed in hoop: Keep it? (${ask}), not approved: stop work on it.`);
});

test("reopening brings back the status the review had, and an approved review can't be closed", async () => {
  await withServer({ sessions: () => [] }, async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    hoop.review(review_id, { verdict: "changes_requested", comments: [{ item: "FR-3", line: 1, body: "Inclusive?" }] }, true);
    assert.equal((await post(`${base}/api/reviews/${review_id}/close`, {})).body.status_key, "closed");
    const res = await post(`${base}/api/reviews/${review_id}/reopen`, {});
    assert.equal(res.status, 201);
    assert.equal(res.body.status_key, "changes_requested");
    assert.equal(res.body.meta.closed, undefined);
    assert.equal((await post(`${base}/api/reviews/${review_id}/reopen`, {})).status, 400);

    const approved = hoop.submit({ ...example(), slug: "other" }).review_id;
    hoop.review(approved, { verdict: "approved", comments: [] }, true);
    const refused = await post(`${base}/api/reviews/${approved}/close`, {});
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /approved/);

    // A quick question already answered, and a build, can't be closed either.
    const KEEP = { questions: [{ question: "Keep it?", options: [{ label: "Yes", recommended: true }, { label: "No" }] }] };
    const answered = hoop.ask(KEEP).review_id;
    hoop.answer(answered, { question: "Q1", choice: "A" });
    assert.match((await post(`${base}/api/reviews/${answered}/close`, {})).body.error, /answered or withdrawn already/);
    const build = hoop.startBuild("# Draft\n\nNotes.\n").review_id;
    assert.match((await post(`${base}/api/reviews/${build}/close`, {})).body.error, /being built/);
  });
});

test("another site's page can't close a review", async () => {
  await withServer({ sessions: () => [] }, async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    const res = await post(`${base}/api/reviews/${review_id}/close`, { reason: "x" }, { origin: "http://evil.example" });
    assert.equal(res.status, 403);
    const form = await fetch(`${base}/api/reviews/${review_id}/close`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(form.status, 415);
    assert.equal(hoop.store.meta(review_id).closed, undefined);
  });
});

test("closing while Claude waits on the review sends no message: the wait returns with closed", async () => {
  const sock = await fakeSocket();
  try {
    await withServer({ sessions: () => [{ session: TEST_SESSION, pid: 1, status: "busy", socket: sock.path }] }, async (base, hoop) => {
      const { review_id } = hoop.submit(example());
      const waiting = waitForReview(hoop, review_id, { intervalMs: 10, timeoutMs: 10_000 });
      await sleep(50);
      const res = await post(`${base}/api/reviews/${review_id}/close`, { reason: "Done elsewhere" });
      assert.equal(res.body.delivery.outcome, "waiting");
      assert.equal(hoop.store.deliveries(review_id)[CLOSE_KEY]?.outcome, "waiting");
      assert.equal((await waiting)?.status, "closed");
      await sleep(100);
      assert.equal(sock.lines.length, 0);
    });
  } finally {
    sock.close();
  }
});

test("regression: a quick double Enter on the confirmation closes once and shows no error", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(example());
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("#closeReview").click();
    await page.locator("#closeReason").fill("Not needed");
    const posts: number[] = [];
    page.on("response", (r) => r.url().endsWith("/close") && posts.push(r.status()));
    await page.locator("#closeReason").press("Enter");
    await page
      .locator("#closeReason")
      .press("Enter")
      .catch(() => {});
    await page.locator(".closed-note").waitFor();
    await sleep(200);
    assert.deepEqual(posts, [201]);
    assert.equal(await page.locator(".steer-error:not(:empty)").count(), 0, "no error shows");
    assert.equal(hoop.store.meta(review_id).closed?.reason, "Not needed");
  });
});

test("#298: a person's request for changes reopens a closed review, keeps the close on record and tells Claude; nothing else reopens it", async () => {
  const sock = await fakeSocket();
  try {
    await withServer({ sessions: () => [{ session: TEST_SESSION, pid: 1, status: "idle", socket: sock.path }] }, async (base, hoop) => {
      const { review_id } = hoop.submit(example());
      await post(`${base}/api/reviews/${review_id}/close`, { reason: "Not needed" });
      // An approval, an empty request for changes, or a session's comment leaves it closed.
      assert.match((await post(`${base}/api/reviews/${review_id}/feedback`, { verdict: "approved", comments: [] })).body.error, /closed .* Not needed/);
      assert.equal((await post(`${base}/api/reviews/${review_id}/feedback`, { verdict: "changes_requested", comments: [] })).status, 400);
      assert.throws(() => hoop.comment(review_id, { item: "FR-1", line: 1, body: "Still needed?" }), /closed .* Not needed/);
      assert.ok(hoop.store.meta(review_id).closed);

      const res = await post(`${base}/api/reviews/${review_id}/feedback`, {
        verdict: "changes_requested",
        comments: [{ item: "FR-3", line: 1, body: "We need this after all." }],
      });
      assert.equal(res.status, 201);
      const meta = hoop.store.meta(review_id);
      assert.equal(meta.closed, undefined);
      assert.equal(meta.status, "open", "reopening approves nothing");
      assert.equal(meta.closes?.length, 1);
      assert.equal(meta.closes![0]!.reason, "Not needed");
      assert.ok(meta.closes![0]!.reopened_at);
      assert.equal(hoop.feedback(review_id).status, "reviewed");
      for (let i = 0; i < 50 && sock.lines.length < 2; i++) await sleep(20);
      assert.match(JSON.parse(sock.lines[1]!).message.content, /: changes requested, reopening the review they had closed, 1 comment\./);
    });
  } finally {
    sock.close();
  }
});

test("#298: an answer to a closed quick question reopens it", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const ask = hoop.ask({ questions: [{ question: "Keep it?", options: [{ label: "Yes", recommended: true }, { label: "No" }] }] }).review_id;
  hoop.close(ask, "Asked twice");
  hoop.answer(ask, { question: "Q1", choice: "A" });
  const meta = hoop.store.meta(ask);
  assert.equal(meta.closed, undefined);
  assert.equal(meta.closes?.[0]?.reason, "Asked twice");
});

test("#298: a closed review's page has no Reopen; a comment and Request changes reopen it", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(example());
    hoop.close(review_id, "Not needed");
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".closed-note").waitFor();
    assert.match(await page.locator(".closed-note").innerText(), /: Not needed\. Requesting changes reopens it\.$/);
    assert.equal(await page.getByRole("button", { name: "Reopen" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Approve" }).count(), 0);
    await page
      .getByRole("button", { name: /line 1$/ })
      .first()
      .click();
    await page.locator("#cbody").fill("We need this after all.");
    await page.getByRole("button", { name: "Start a review" }).click();
    await page.locator("#finishBtn", { hasText: "Request changes" }).click();
    await page.locator("#submitReview").click();
    await page.locator(".closed-note").waitFor({ state: "detached" });
    assert.equal(hoop.store.meta(review_id).closed, undefined);
    assert.equal(hoop.store.meta(review_id).closes?.length, 1);
  });
});
