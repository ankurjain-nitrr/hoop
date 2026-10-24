// A writer for test/lock.test.ts: once loaded it writes `<start file>.<tag>`, waits for the start
// file, then adds replies and comments to one review.
// Usage: tsx test/lock-worker.ts <home> <review_id> <count> <tag> <start file>
import { existsSync, writeFileSync } from "node:fs";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";

const [home, id, count, tag, start] = process.argv.slice(2) as [string, string, string, string, string];
const hoop = new Hoop(new Store(home), "lock-worker");
writeFileSync(`${start}.${tag}`, "");
const pause = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(start)) Atomics.wait(pause, 0, 0, 2);
for (let i = 0; i < Number(count); i++) {
  hoop.store.addReply(id, { thread: `th_${tag}_${i}`, author: tag, body: `${tag} ${i}`, at: new Date().toISOString() });
  hoop.review(id, { verdict: "comment", reviewer: tag, comments: [{ item: "DOC", line: 1, body: `${tag} ${i}` }] });
}
