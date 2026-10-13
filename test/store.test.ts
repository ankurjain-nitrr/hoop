import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { example, tempHome } from "./helpers.js";

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
  assert.deepEqual(store.list().map((m) => m.id), [meta.id]);
});

test("review ids are checked before touching the filesystem", () => {
  assert.throws(() => new Store(tempHome()).meta("../../etc"), /invalid review id/);
});
