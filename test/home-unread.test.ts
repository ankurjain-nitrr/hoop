import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

    // The review page gets the same rule for each submitted review, by receipt key.
    const acts = async (id: string) => (await (await fetch(`${base}/api/reviews/${id}`)).json()).asks_to_act;
    assert.deepEqual(await acts(changes), { "1.0": false }, "nothing on a closed review asks Claude to act");
    assert.deepEqual(await acts(commented), { "1.0": true });
    assert.deepEqual(await acts(approved), { "1.0": false });
  } finally {
    server.close();
  }
});

test("regression #381: a file review with changes requested isn't Not read yet on Home, since no session reads one", async () => {
  const store = new Store(tempHome());
  const terminal = new Hoop(store, null);
  const file = join(tempHome(), "plan.md");
  writeFileSync(file, "# Plan\n\nHow we ship.\n\n## Question: Which region first?\n\n- A. EU (recommended)\n- B. US\n");
  const { review_id } = terminal.open(file);
  const question = store.revision(review_id).items.find((i) => i.choices?.length)!.id;
  terminal.review(review_id, { verdict: "changes_requested", reviewer: "ana", answers: [{ item: question, choice: "b" }] }, true);
  assert.equal(asksClaudeToAct(store.meta(review_id), { verdict: "changes_requested" }), false);
  const server = createWebServer(new Hoop(store));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const row = (await (await fetch(`${base}/api/reviews`)).json()).find((m: { id: string }) => m.id === review_id);
    assert.equal(row.status_key, "changes_requested");
    assert.equal(row.unread, false, "no session reads a review opened from a file");
    assert.deepEqual((await (await fetch(`${base}/api/reviews/${review_id}`)).json()).asks_to_act, { "1.0": false });
  } finally {
    server.close();
  }
});
