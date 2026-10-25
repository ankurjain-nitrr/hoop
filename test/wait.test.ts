import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { waitForReview } from "../src/wait.js";
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
  hoop.review(review_id, { verdict: "approved", summary: "ship it" });
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
