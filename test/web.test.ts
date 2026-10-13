import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { example, tempHome } from "./helpers.js";

export async function withServer(fn: (base: string, hoop: Hoop) => Promise<void>) {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, hoop);
  } finally {
    server.close();
  }
}

test("the review API returns the latest revision with each item's lines and the previous revision", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    hoop.submit({ ...example(), review_id, items: example().items.slice(0, 2) });
    const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
    assert.equal(view.meta.revisions, 2);
    assert.equal(view.doc.items.length, 2);
    assert.equal(view.doc.items[0].lines.length, 3);
    assert.equal(view.previous.revision, 1);
    assert.equal(view.previous.items.length, 4);
    const list = await (await fetch(`${base}/api/reviews`)).json();
    assert.deepEqual(list.map((m: { id: string }) => m.id), [review_id]);
  }));

test("pages and assets are served; unknown reviews and routes are 404", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    const page = await fetch(`${base}/r/${review_id}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /import \{ start \} from "\/app.js"/);
    assert.equal((await fetch(`${base}/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await fetch(`${base}/api/reviews/rv_missing`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  }));

const post = (base: string, id: string, body: unknown) =>
  fetch(`${base}/api/reviews/${id}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a review submitted from the page becomes the feedback document Claude reads", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    const res = await post(base, review_id, {
      verdict: "changes_requested",
      summary: "Close, two things",
      comments: [
        { item: "FR-3", line: 1, body: "Use updated_at instead?" },
        { item: "FR-1", line: 2, suggestion: "Rows shall stream as they are read." },
      ],
      answers: [{ item: "Q-1", choice: "b" }],
      viewed: ["FR-1"],
      reviewer: "ankur",
    });
    assert.equal(res.status, 201);
    const fb = hoop.feedback(review_id);
    assert.equal(fb.status, "reviewed");
    if (fb.status !== "reviewed") return;
    const f = fb.feedback[0]!;
    assert.equal(f.verdict, "changes_requested");
    assert.equal(f.reviewer, "ankur");
    const t = review_id.slice(3);
    assert.deepEqual(f.comments.map((c) => c.thread), [`th_${t}_1`, `th_${t}_2`]);
    assert.deepEqual(f.answers, [{ item: "Q-1", choice: "b" }]);
    assert.deepEqual(f.source, { channel: "local" });
  }));

test("feedback on lines or choices that don't exist is rejected with the field", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    const res = await post(base, review_id, { verdict: "comment", comments: [{ item: "FR-1", line: 7, body: "x" }] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).errors[0].path, "comments.0.line");
  }));

test("Claude's reply joins the thread; an approved review is frozen", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    await post(base, review_id, { verdict: "comment", comments: [{ item: "FR-3", line: 1, body: "why?" }] });
    const thread = `th_${review_id.slice(3)}_1`;
    hoop.reply(thread, "Because exports should not shift when orders change.");
    const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
    assert.equal(view.replies[0].thread, thread);
    assert.equal(view.replies[0].author, "claude");
    assert.equal((await post(base, review_id, { verdict: "approved" })).status, 201);
    assert.equal(hoop.store.meta(review_id).status, "approved");
    assert.equal((await post(base, review_id, { verdict: "comment", summary: "late" })).status, 400);
    assert.throws(() => hoop.reply("th_99", "x"), /no thread th_99/);
  }));

test("cross-site requests are refused: foreign Origin, non-JSON POST, foreign Host", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    const url = `${base}/api/reviews/${review_id}/feedback`;
    const body = JSON.stringify({ verdict: "approved" });
    const evil = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body });
    assert.equal(evil.status, 403);
    const plain = await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body });
    assert.equal(plain.status, 415);
    const { request } = await import("node:http");
    const rebound = await new Promise<number>((resolve) => {
      const u = new URL(`${base}/api/reviews`);
      request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: "attacker.example:4747" } }, (res) => resolve(res.statusCode!)).end();
    });
    assert.equal(rebound, 403);
    assert.equal(hoop.store.meta(review_id).status, "open");
    const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: base }, body });
    assert.equal(ok.status, 201);
  }));

test("thread ids are unique across reviews, so a reply lands on the right review", () =>
  withServer(async (_base, hoop) => {
    const a = hoop.submit(example()), b = hoop.submit(example());
    const ta = hoop.review(a.review_id, { verdict: "comment", comments: [{ item: "FR-1", line: 1, body: "a" }] }).comments[0]!.thread!;
    const tb = hoop.review(b.review_id, { verdict: "comment", comments: [{ item: "FR-1", line: 1, body: "b", thread: "th_forged_1" }] }).comments[0]!.thread!;
    assert.notEqual(ta, tb);
    assert.notEqual(tb, "th_forged_1");
    hoop.reply(tb, "for b");
    assert.equal(hoop.store.replies(b.review_id).length, 1);
    assert.equal(hoop.store.replies(a.review_id).length, 0);
  }));
