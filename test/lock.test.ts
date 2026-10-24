import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { LOCK_STALE_MS, withLock } from "../src/lock.js";
import { Store } from "../src/store.js";
import { example, tempHome, tsx } from "./helpers.js";

const worker = new URL("./lock-worker.ts", import.meta.url).pathname;

const run = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, worker, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${err}`))));
  });

test("two processes writing one review at once lose none of each other's replies or comments", async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home));
  const { review_id } = hoop.submit(example());
  const start = join(home, "go"),
    n = 60;
  const writers = [run([home, review_id, String(n), "a", start]), run([home, review_id, String(n), "b", start])];
  // Both processes load first and then start together, so their writes overlap.
  while (!existsSync(`${start}.a`) || !existsSync(`${start}.b`)) await new Promise((r) => setTimeout(r, 20));
  writeFileSync(start, "");
  await Promise.all(writers);
  assert.equal(hoop.store.replies(review_id).length, 2 * n);
  const feedback = hoop.store.feedback(review_id);
  assert.equal(feedback.length, 2 * n);
  const threads = feedback.flatMap((f) => f.comments.map((c) => c.thread));
  assert.equal(new Set(threads).size, 2 * n, "every comment got its own thread");
  assert.equal(existsSync(join(home, "reviews", review_id, ".lock")), false, "the lock is released");
});

test("a lock whose process is gone, or that is older than the limit, is broken", () => {
  const home = tempHome();
  const lock = join(home, "x.lock");
  // A process ID that no process has.
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  const began = Date.now();
  assert.equal(
    withLock(lock, () => "ran"),
    "ran",
  );
  assert.ok(Date.now() - began < 1000);
  // A live process (this one's parent), but too old.
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: Date.now() - LOCK_STALE_MS - 1000 }));
  assert.equal(
    withLock(lock, () => "ran again"),
    "ran again",
  );
  // Half written, judged by the file's age.
  writeFileSync(lock, "{");
  const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
  utimesSync(lock, old, old);
  assert.equal(
    withLock(lock, () => "and again"),
    "and again",
  );
  assert.equal(existsSync(lock), false);
});

test("a lock is re-entrant in one process, and waits for a live holder in another", async () => {
  const home = tempHome();
  const lock = join(home, "y.lock");
  assert.equal(
    withLock(lock, () => withLock(lock, () => readFileSync(lock, "utf8").includes(String(process.pid)))),
    true,
  );
  assert.equal(existsSync(lock), false);
  // Another process holds the lock for a moment; this one waits for it.
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require("fs");fs.writeFileSync(${JSON.stringify(lock)},JSON.stringify({pid:process.pid,at:Date.now()}));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(lock + ".released")},"");fs.rmSync(${JSON.stringify(lock)})},400)`,
    ],
    { stdio: "ignore" },
  );
  while (!existsSync(lock)) await new Promise((r) => setTimeout(r, 5));
  // The holder marks its release just before it lets go, so a run that didn't wait finds no mark.
  withLock(lock, () => assert.ok(existsSync(`${lock}.released`), "the lock was taken only after the holder let go"));
  await new Promise((r) => holder.on("close", r));
});
