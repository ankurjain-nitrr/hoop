import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { type AddressInfo, createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { waitForAsk, waitForReview } from "../src/wait.js";
import { closeMessage } from "../src/wake.js";
import { createWebServer, type PagesOptions } from "../src/web.js";
import { example, TEST_SESSION, tempHome } from "./helpers.js";

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
      assert.equal(JSON.parse(sock.lines[0]!).message.content, `Closed in hoop: ${TITLE} — The session ended`);
      // Closing twice, or a review on a closed review, is refused.
      assert.equal((await post(`${base}/api/reviews/${review_id}/close`, {})).status, 400);
      const fb = await post(`${base}/api/reviews/${review_id}/feedback`, { verdict: "approved", comments: [] });
      assert.equal(fb.status, 400);
      assert.match(fb.body.error, /closed .* without approving it: The session ended/);
    });
  } finally {
    sock.close();
  }
});

test("hoop_feedback and hoop_wait report a closed review, and a revision of it is refused with the reason", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  hoop.close(review_id, "Not needed any more", "ana");
  assert.deepEqual({ ...hoop.feedback(review_id).closed, at: undefined }, { by: "ana", reason: "Not needed any more", at: undefined });
  const waited = await waitForReview(hoop, review_id, { intervalMs: 10, timeoutMs: 5000 });
  assert.equal(waited?.closed?.reason, "Not needed any more");
  assert.throws(() => hoop.submit({ ...example(), review_id }), /ana closed .* without approving it: Not needed any more/);
  // Closing without a reason says so too.
  const ask = hoop.ask({ questions: [{ question: "Keep it?", options: [{ label: "Yes", recommended: true }, { label: "No" }] }] }).review_id;
  hoop.close(ask);
  assert.ok((await waitForAsk(hoop, ask, { intervalMs: 10, timeoutMs: 5000 }))?.closed);
  assert.throws(() => hoop.answer(ask, { question: "Q1", choice: "A" }), /closed .* without approving it\./);
  assert.equal(closeMessage(hoop.store.meta(ask)), "Closed in hoop: Keep it?");
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
