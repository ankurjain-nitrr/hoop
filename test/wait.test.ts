import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { type Watch, waitForAsk, waitForReview } from "../src/wait.js";
import { watch } from "node:fs";
import { example, tempHome, pagesFor, hoopArgs } from "./helpers.js";

test("wait resolves when a review arrives on the latest revision, not on older feedback", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  hoop.review(review_id, { verdict: "comment", summary: "before the wait" });
  const waiting = waitForReview(hoop, review_id, { intervalMs: 20, timeoutMs: 30_000 });
  await sleep(80);
  hoop.review(review_id, { verdict: "changes_requested", summary: "during the wait" });
  const result = await waiting;
  assert.equal(result?.status, "reviewed");
  assert.equal(result?.status === "reviewed" && result.feedback.at(-1)?.summary, "during the wait");
});

// Regression (#212): hoop_wait checked for a verdict every 2 s, so a verdict waited a second on
// average and up to two. The wait now wakes when the review's folder changes. The poll is set to a
// minute here, so only that wake can return the verdict within the five seconds the wait has.
test("a verdict wakes the wait as soon as it is written, not at the next poll", async () => {
  const home = tempHome();
  const writer = new Hoop(new Store(home));
  // The session has its own view of the files, which another writes, as the pages process does.
  const session = new Hoop(new Store(home));
  const { review_id } = writer.submit(example());
  for (const verdict of ["changes_requested", "approved"] as const) {
    const waiting = waitForReview(session, review_id, { intervalMs: 60_000, timeoutMs: 5000 });
    await sleep(100);
    const sent = performance.now();
    writer.review(review_id, { verdict, summary: "During the wait." });
    const result = await waiting;
    const took = performance.now() - sent;
    assert.equal(result?.status, "reviewed", verdict);
    assert.ok(took < 1000, `${verdict} came back in ${Math.round(took)} ms`);
  }
});

// Regression: a folder the wait can't watch, or a watch that fails while it waits, leaves the check,
// which still returns the verdict.
test("when the watch can't start, or fails while it waits, the check still returns the verdict", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const throws: Watch = () => {
    throw new Error("no watch here");
  };
  // A watch that starts, then fails at once, as one whose folder goes away does.
  const fails: Watch = (dir, listener) => {
    const w = watch(dir, listener);
    setImmediate(() => w.emit("error", new Error("watch failed")));
    return w;
  };
  for (const [name, watchDir] of [
    ["can't start", throws],
    ["fails", fails],
  ] as const) {
    const waiting = waitForReview(hoop, review_id, { intervalMs: 50, timeoutMs: 5000, watch: watchDir });
    await sleep(100);
    hoop.review(review_id, { verdict: "changes_requested", summary: `With a watch that ${name}.` });
    const result = await waiting;
    assert.equal(result?.status === "reviewed" && result.feedback.at(-1)?.summary, `With a watch that ${name}.`, name);
  }
});

test("an answer to a quick question wakes its wait as soon as it is written", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.ask({ questions: [{ question: "CSV or JSON?", options: [{ label: "CSV", recommended: true }, { label: "JSON" }] }] });
  const waiting = waitForAsk(hoop, id, { intervalMs: 60_000, timeoutMs: 5000 });
  await sleep(100);
  const sent = performance.now();
  hoop.answer(id, { question: "Q1", choice: "A" });
  const result = await waiting;
  assert.ok(result, "the answer came back");
  assert.ok(performance.now() - sent < 1000);
});

test("a wait that is aborted stops at once, and one whose poll never comes still times out", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const stop = new AbortController();
  const waiting = waitForReview(hoop, review_id, { intervalMs: 60_000, timeoutMs: 30_000, signal: stop.signal });
  await sleep(50);
  // A review that came in, then an abort before the wait's next check: the wait stops without
  // taking it. A guard: a pause that an abort ends as a wake would check once more and take it.
  const noWatch: Watch = () => {
    throw new Error("no watch");
  };
  const held = waitForReview(hoop, review_id, { intervalMs: 60_000, timeoutMs: 30_000, signal: stop.signal, watch: noWatch });
  await sleep(50);
  hoop.review(review_id, { verdict: "changes_requested", summary: "In before the abort." });
  stop.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  await assert.rejects(held, { name: "AbortError" });
  assert.deepEqual(hoop.store.receipts(review_id), {}, "no wait took the review");
  const started = performance.now();
  assert.equal(await waitForReview(hoop, review_id, { intervalMs: 60_000, timeoutMs: 200 }), undefined);
  assert.ok(performance.now() - started < 5000, "the deadline, not the minute-long poll, ends it");
});

test("wait returns at once for an approved review and undefined on timeout", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  assert.equal(await waitForReview(hoop, review_id, { intervalMs: 10, timeoutMs: 50 }), undefined);
  hoop.review(review_id, { verdict: "approved" });
  const result = await waitForReview(hoop, review_id, { intervalMs: 10, timeoutMs: 50 });
  assert.equal(result?.status === "reviewed" && result.approved, true);
});

test("hoop wait prints the feedback and exits 0 when a review is submitted mid-wait", async () => {
  const home = tempHome();
  const pages = await pagesFor(home);
  const hoop = new Hoop(new Store(home));
  const { review_id, cursor } = hoop.submit(example());
  const child = spawn(process.execPath, [...hoopArgs, "wait", review_id, "--after", cursor, "--timeout", "20"], { env: { ...process.env, ...pages } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  await sleep(1500);
  // Through the pages process, the only writer, as the review page sends it: it writes the review
  // and answers the wait's read of it in turn. Written here instead, outside it, the wait woke on
  // the feedback file and could read the review before its approval was written (#422's CI).
  const sent = await fetch(`http://127.0.0.1:${pages.HOOP_PORT}/api/reviews/${review_id}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verdict: "approved", summary: "ship it", comments: [] }),
  });
  assert.equal(sent.status, 201, await sent.clone().text());
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0);
  const printed = JSON.parse(out);
  assert.equal(printed.approved, true);
  assert.equal(printed.feedback[0].summary, "ship it");
});

test("hoop wait rejects a non-numeric --timeout", async () => {
  const child = spawn(process.execPath, [...hoopArgs, "wait", "rv_x", "--timeout", "soon"], { env: { ...process.env, HOOP_HOME: tempHome() } });
  assert.equal(await new Promise((r) => child.on("close", r)), 2);
});

test("hoop wait --after counts from a submit's cursor, so a review that came in before the wait started still returns", async () => {
  const home = tempHome();
  const pages = await pagesFor(home);
  const hoop = new Hoop(new Store(home));
  const { review_id, cursor } = hoop.submit(example());
  // The person reviews before the background wait has even started, as happens when they are quick.
  hoop.review(review_id, { verdict: "comment", summary: "quick look" });
  const child = spawn(process.execPath, [...hoopArgs, "wait", review_id, "--after", cursor, "--timeout", "20"], { env: { ...process.env, ...pages } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  assert.equal(await new Promise((r) => child.on("close", r)), 0);
  assert.equal(JSON.parse(out).feedback[0].summary, "quick look");
});

test("hoop wait rejects a malformed --after and unknown flags", async () => {
  for (const args of [
    ["--after", "soon"],
    ["--since", "1.0"],
  ]) {
    const child = spawn(process.execPath, [...hoopArgs, "wait", "rv_x", ...args], { env: { ...process.env, HOOP_HOME: tempHome() } });
    assert.equal(await new Promise((r) => child.on("close", r)), 2, args.join(" "));
  }
});
