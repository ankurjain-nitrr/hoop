import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { asksClaudeToAct, createWebServer } from "../src/web.js";
import { example, tempHome } from "./helpers.js";

test("only a review that asks Claude to act can be unread: never an approval or a closed review", () => {
  const closed = { closed: { by: "ana", at: "2026-10-26T22:39:00.000Z" } };
  assert.equal(asksClaudeToAct({}, { verdict: "changes_requested" }), true);
  assert.equal(asksClaudeToAct({}, { verdict: "comment" }), true);
  assert.equal(asksClaudeToAct({}, { verdict: "approved" }), false);
  assert.equal(asksClaudeToAct(closed, { verdict: "changes_requested" }), false);
  assert.equal(asksClaudeToAct(closed, { verdict: "approved" }), false);
});

test("regression #313: Home flags an unread request for changes, but not an approval or a closed review the session never read", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const unread = async (id: string) => (await (await fetch(`${base}/api/reviews`)).json()).find((m: { id: string }) => m.id === id).unread;
    const comment = [{ item: "FR-3", line: 1, body: "Inclusive?" }];

    const approved = hoop.submit(example()).review_id;
    hoop.review(approved, { verdict: "approved", reviewer: "ana" });
    assert.equal(await unread(approved), false, "an approval the session never read with hoop_feedback isn't unread");

    const changes = hoop.submit(example()).review_id;
    hoop.review(changes, { verdict: "changes_requested", reviewer: "ana", comments: comment });
    assert.equal(await unread(changes), true, "a request for changes Claude hasn't read is");

    const commented = hoop.submit(example()).review_id;
    hoop.review(commented, { verdict: "comment", reviewer: "ana", comments: comment });
    assert.equal(await unread(commented), true);

    hoop.close(changes, "Not needed");
    assert.equal(await unread(changes), false, "a closed review isn't");
  } finally {
    server.close();
  }
});
