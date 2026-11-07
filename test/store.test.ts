import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Hoop } from "../src/hoop.js";
import { parseMarkdown } from "../src/markdown.js";
import { example, TEST_SESSION, tempHome } from "./helpers.js";

test("reviews, revisions, feedback and replies are JSON files under HOOP_HOME", () => {
  const home = tempHome();
  const store = new Store(home);
  const meta = store.create(example());
  store.addRevision(meta.id, { ...example(), title: "Order export v2" });
  const dir = join(home, "reviews", meta.id);
  for (const f of ["review.json", "rev-1.json", "rev-2.json"]) assert.ok(existsSync(join(dir, f)), f);
  assert.equal(store.meta(meta.id).revisions, 2);
  assert.equal(store.revision(meta.id).title, "Order export v2");
  assert.equal(store.revision(meta.id, 1).revision, 1);
  store.addReply(meta.id, { thread: "th_1", author: "claude", body: "Done", at: "now" });
  assert.equal(store.replies(meta.id).length, 1);
  assert.deepEqual(
    store.list().map((m) => m.id),
    [meta.id],
  );
});

test("review ids are checked before touching the filesystem", () => {
  assert.throws(() => new Store(tempHome()).meta("../../etc"), /invalid review id/);
});

test("a quick question beside a review's line updates that review when it is asked, answered, withdrawn or closed, and nothing else of it (#436)", () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-07T10:00:00.000Z") });
  try {
    const home = tempHome();
    const store = new Store(home);
    const hoop = new Hoop(store, TEST_SESSION);
    const review = hoop.submit(parseMarkdown("# Plan\n\nWhy.\n\n## Storage\n\nUse Cassandra.\n")).review_id;
    const file = join(store.dirOf(review), "review.json");
    const before = JSON.parse(readFileSync(file, "utf8"));
    /** Moves the clock on, runs `act`, and returns the review's `updated` after it. */
    const after = (act: () => unknown) => {
      mock.timers.tick(1000);
      act();
      return store.meta(review).updated;
    };
    const KEEP = { question: "Keep it?", options: [{ label: "Keep", recommended: true }, { label: "Remove" }] };
    const anchor = { review_id: review, words: "Use Cassandra." };
    let ask = "";
    const asked = after(() => (ask = hoop.ask({ questions: [KEEP], anchor }).review_id));
    assert.equal(asked, store.meta(ask).updated, "asked");
    assert.equal(
      after(() => hoop.answer(ask, { question: "Q1", choice: "A" })),
      store.meta(ask).updated,
      "answered",
    );
    const second = hoop.ask({ questions: [KEEP], anchor }).review_id;
    assert.equal(
      after(() => hoop.withdraw(second, "Found it")),
      store.meta(second).updated,
      "withdrawn",
    );
    const third = hoop.ask({ questions: [KEEP], anchor }).review_id;
    assert.equal(
      after(() => hoop.close(third, "Not needed")),
      store.meta(third).updated,
      "closed",
    );
    // A new session ID for the owner is bookkeeping, not activity on the question.
    const was = store.meta(review).updated;
    assert.equal(
      after(() => store.update(third, { owners: ["another-session"] })),
      was,
      "an owner change moves nothing",
    );
    // Only `updated` changed in the review's own file.
    const { updated: _u, ...rest } = JSON.parse(readFileSync(file, "utf8"));
    const { updated: _b, ...first } = before;
    assert.deepEqual(rest, first);

    // An ask pointing at itself, or at a review that is gone, writes nothing else and doesn't throw.
    store.update(third, { ask: { ...store.meta(third).ask, anchor: { ...store.meta(third).ask!.anchor!, review_id: third } } });
    rmSync(store.dirOf(review), { recursive: true, force: true });
    assert.doesNotThrow(() => store.update(ask, { closed: { by: "ankur", at: new Date().toISOString() } }));
    assert.equal(existsSync(file), false, "a gone review isn't written again");
  } finally {
    mock.timers.reset();
  }
});
