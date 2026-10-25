import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { Hoop, type AskResult } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { createWebServer, reviewView } from "../src/web.js";
import { parseMarkdown } from "../src/markdown.js";
import { isOutdated, showsBelow } from "../web/place.js";
import { BROWSER_SKIP, hasFocus, pagesFor, tempHome, withBrowser, hoopArgs } from "./helpers.js";

const KEEP = {
  question: "Keep the old endpoint?",
  context: "Two clients still call it.",
  options: [{ label: "Keep it as an alias", recommended: true }, { label: "Remove it" }],
};
const FORMAT = { question: "Which format?", options: [{ label: "CSV" }, { label: "JSON", recommended: true }] };
const PLAN = "# Plan\n\nWhy this matters.\n\n## Rollout\n\nShip on Monday.\n\nThen tell the clients.\n\n## Costs\n\nShip it cheaply.\n";

test("an ask points at a review line by its words or by item and line, as that line reads in the latest revision", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const review = hoop.submit(parseMarkdown(PLAN)).review_id;
  const byWords = hoop.ask({ questions: [KEEP], anchor: { review_id: review, words: "tell the clients" } });
  assert.deepEqual(byWords.anchor, {
    review_id: review,
    revision: 1,
    item: "S-1",
    line: 2,
    text: "Then tell the clients.",
    range: { start: 5, end: 21, quote: "tell the clients" },
  });
  // An item narrows words that occur in more than one place.
  assert.equal(hoop.ask({ questions: [KEEP], anchor: { review_id: review, item: "S-2", words: "Ship" } }).anchor?.item, "S-2");
  const byLine = hoop.ask({ questions: [KEEP], anchor: { review_id: review, item: "S-1", line: 0 } });
  assert.deepEqual(byLine.anchor, { review_id: review, revision: 1, item: "S-1", line: 0, text: "Rollout" });
  assert.equal(hoop.ask({ questions: [KEEP], anchor: { review_id: review, item: "DOC", line: 1 } }).anchor?.text, "Plan");
  // The ask's own meta keeps the anchor, and a withdrawal keeps it too.
  hoop.withdraw(byLine.review_id, "Answered in the doc");
  assert.equal(hoop.store.meta(byLine.review_id).ask?.anchor?.line, 0);
  assert.equal(hoop.askResult(byLine.review_id).anchor?.item, "S-1");

  // After a revision, words and lines are read in it.
  hoop.submit({ ...parseMarkdown(PLAN.replace("Ship on Monday.", "Ship on Tuesday.")), review_id: review });
  assert.deepEqual(hoop.ask({ questions: [KEEP], anchor: { review_id: review, words: "Tuesday" } }).anchor?.revision, 2);
  const refused = (anchor: Record<string, unknown>, why: RegExp) =>
    assert.throws(
      () => hoop.ask({ questions: [KEEP], anchor }),
      (err: Error & { errors?: { path: string }[] }) => why.test(err.message),
    );
  refused({ review_id: review, words: "Monday" }, /"Monday" occurs nowhere/);
  refused({ review_id: review, words: "Ship" }, /occurs in 2 places/);
  refused({ review_id: review, item: "S-1", line: 3 }, /S-1 has lines 0-2/);
  refused({ review_id: review, item: "DOC", line: 3 }, /DOC has lines 1-2/);
  refused({ review_id: review, item: "S-9", line: 1 }, /has no item S-9/);
  refused({ review_id: review, item: "S-1" }, /words, or with item and line/);
  refused({ review_id: "rv_nothere1", words: "Ship" }, /no review rv_nothere1 that this session can read/);
  // A review whose files this session can't read is refused like a missing one.
  const unreadable = hoop.submit(parseMarkdown(PLAN)).review_id;
  rmSync(join(hoop.store.dirOf(unreadable), "rev-1.json"));
  refused({ review_id: unreadable, words: "Monday" }, /that this session can read/);
  // Only an open review: not an ask, a build or an approved review.
  refused({ review_id: byWords.review_id, item: "Q1", line: 1 }, /is a quick question/);
  const build = hoop.startBuild("# Draft\n\nNotes.\n").review_id;
  refused({ review_id: build, item: "DOC", line: 1 }, /being built/);
  const approved = hoop.submit(parseMarkdown(PLAN)).review_id;
  hoop.review(approved, { verdict: "approved", reviewer: "owner" });
  refused({ review_id: approved, words: "Monday" }, /approved and frozen/);
});

test("a review's view lists the asks on its lines with their answers and receipts, and answering one leaves the review alone", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const review = hoop.submit(parseMarkdown(PLAN)).review_id;
  const first = hoop.ask({ questions: [KEEP, FORMAT], anchor: { review_id: review, words: "Monday" } }).review_id;
  const second = hoop.ask({ questions: [KEEP], anchor: { review_id: review, item: "S-2", line: 1 } }).review_id;
  hoop.ask({ questions: [KEEP] }); // a standalone ask isn't on the review
  const server = createWebServer(hoop, [], { sessions: () => [] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/reviews/${first}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Q1", choice: "B" }),
    });
    assert.equal(res.status, 201);
    hoop.receiveAsk(first);
    const view = reviewView(hoop, review, () => []);
    assert.deepEqual(
      view.asks?.map((a) => [a.id, a.anchor?.item, a.anchor?.line, a.state]),
      [
        [first, "S-1", 1, "open"],
        [second, "S-2", 1, "open"],
      ],
    );
    const card = view.asks![0]!;
    assert.equal(card.anchor?.title, "Plan");
    assert.deepEqual(
      card.questions[0]!.answers.map((a) => [a.choice, a.key]),
      [["B", "1.0"]],
    );
    assert.ok(card.receipts["1.0"], "the card carries the ask's receipts");
    // The review has no feedback, no verdict and no unread review from the answer.
    assert.deepEqual(hoop.store.allFeedback(review), []);
    assert.equal(view.status_key, "awaiting_review");
    assert.equal(hoop.store.meta(review).status, "open");
    // The ask's own page names the review it points at.
    const page = await (await fetch(`${base}/api/reviews/${first}`)).json();
    assert.deepEqual([page.ask.anchor.review_id, page.ask.anchor.title, page.asks], [review, "Plan", undefined]);
  } finally {
    server.close();
  }
});

test("a card stays where a thread on its line stays across revisions: on its line, outdated when the line changed, under the last line when gone", () => {
  // A card is placed with the thread rules in web/place.js.
  const at = { item: "S-1", line: 2, revision: 1 };
  assert.ok(showsBelow(at, "S-1", 1, 3), "on its own line");
  assert.ok(!showsBelow(at, "S-1", 2, 3));
  assert.ok(!showsBelow(at, "S-2", 1, 3));
  // The item lost its second line: the card shows under the last line left.
  assert.ok(showsBelow(at, "S-1", 0, 1));
  assert.ok(showsBelow({ item: "S-1", line: 0 }, "S-1", -1, 2), "a heading's card shows under the heading");
  assert.ok(!isOutdated(at, 1, "Then tell the clients.", "Then tell the clients."), "nothing is outdated on the latest revision");
  assert.ok(!isOutdated(at, 2, "Then tell the clients.", "Then tell the clients."));
  assert.ok(isOutdated(at, 2, "Then tell the clients.", "Then email the clients."));
  assert.ok(isOutdated(at, 2, undefined, ""));

  // The anchor keeps the revision it was asked on, so a later revision of the review doesn't move it.
  const hoop = new Hoop(new Store(tempHome()));
  const review = hoop.submit(parseMarkdown(PLAN)).review_id;
  const id = hoop.ask({ questions: [KEEP], anchor: { review_id: review, words: "tell the clients" } }).review_id;
  hoop.submit({ ...parseMarkdown(PLAN.replace("\n\nThen tell the clients.", "")), review_id: review });
  const view = reviewView(hoop, review, () => []);
  assert.deepEqual(view.asks?.[0]?.anchor, { ...hoop.store.meta(id).ask?.anchor, title: "Plan" });
  assert.equal(view.asks?.[0]?.anchor?.revision, 1);
  assert.equal(view.history[1]!["S-1"]![1], "Then tell the clients.", "the page reads the line as it was asked");
});

test("`hoop ask --review` points a terminal's ask at a review line", async () => {
  const home = tempHome();
  const pages = await pagesFor(home);
  const run = (args: string[]) => promisify(execFile)(process.execPath, [...hoopArgs, ...args, "--json"], { env: { ...process.env, ...pages } });
  const file = join(home, "plan.md");
  writeFileSync(file, PLAN);
  const review = JSON.parse((await run(["submit", file])).stdout).review_id;
  const out = JSON.parse(
    (await run(["ask", "Keep", "it?", "--option", "Yes*", "--option", "No", "--review", review, "--words", "Monday"])).stdout,
  ) as AskResult;
  assert.deepEqual([out.anchor?.item, out.anchor?.line], ["S-1", 1]);
  const byLine = JSON.parse(
    (await run(["ask", "Keep?", "--option", "Yes*", "--option", "No", "--review", review, "--item", "S-2", "--line", "1"])).stdout,
  ) as AskResult;
  assert.deepEqual([byLine.anchor?.item, byLine.anchor?.text], ["S-2", "Ship it cheaply."]);
});

test("a card on a review page answers with a click, 1 to 4 or Other, and Go with your recommendation, with no review started", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const review = hoop.submit(parseMarkdown(PLAN)).review_id;
    const id = hoop.ask({ questions: [KEEP, FORMAT], anchor: { review_id: review, words: "tell the clients" } }).review_id;
    await page.goto(`${base}/r/${review}`);
    const card = page.locator(`#ask-${id}`);
    await card.locator(".thread-head", { hasText: "Question from Claude on line 2" }).waitFor();
    await card.locator(".quote", { hasText: "tell the clients" }).waitFor();
    // A comment the reviewer hasn't sent yet stays unsent through the answers.
    await page.getByRole("button", { name: '"Costs" line 1', exact: false }).first().click();
    await page.locator("#cbody").fill("Too cheap?");
    await page.locator("#addComment").click();
    await page.locator(".pending", { hasText: "Pending" }).first().waitFor();

    await card.locator(`#note-${id}-Q1`).fill("Two clients left");
    await card.locator('[data-q="Q1"][data-choice="A"]').focus();
    await page.keyboard.press("2");
    await card.locator('[data-q="Q1"][data-choice="B"][aria-pressed="true"]').waitFor();
    assert.ok(await hasFocus(card.locator('[data-q="Q1"][data-choice="B"]')), "focus stays on the answer");
    await card.locator(".ask-note-shown", { hasText: "Two clients left" }).waitFor();
    await card.locator(".ask-status", { hasText: "no live Claude session" }).waitFor();
    // Other, then Enter.
    await card.locator('[data-q="Q2"][data-other]').click();
    await card.locator(`#other-${id}-Q2`).fill("Parquet");
    await page.keyboard.press("Enter");
    await card.locator(".ask-q", { hasText: "Other: “Parquet”" }).waitFor();
    await card.locator(".thread-head", { hasText: "Answered" }).waitFor();
    assert.equal(await card.locator(".go-rec").count(), 0);

    // Nothing about the review changed: no feedback, the unsent comment is still pending, and Finish counts it.
    assert.deepEqual(hoop.store.allFeedback(review), []);
    assert.equal(await page.locator(".thread .pending").count(), 1);
    assert.equal(await page.locator("#finishBtn .n").textContent(), "1");
    assert.deepEqual(
      hoop.receiveAsk(id).questions.map((q) => [q.answer?.choice, q.answer?.text, q.answer?.note]),
      [
        ["B", undefined, "Two clients left"],
        ["other", "Parquet", undefined],
      ],
    );
    // After a reload the answered card is still on its line, with who answered and Claude's receipt.
    await page.reload();
    await card.locator(".receipt", { hasText: "read this at" }).first().waitFor();

    // Go with your recommendation on a second card, and the ask's own page links back to the card.
    const other = hoop.ask({ questions: [FORMAT], anchor: { review_id: review, item: "S-2", line: 1 } }).review_id;
    await page.goto(`${base}/r/${other}`);
    await page.locator(".ask-about", { hasText: "Ship it cheaply." }).waitFor();
    await page.locator(".ask-about a").click();
    await page.waitForURL(`${base}/r/${review}#ask-${other}`);
    assert.ok(await hasFocus(page.locator(`#ask-${other}`)), "the link lands on the card");
    await page.locator(`#goRec-${other}`).click();
    await page.locator(`#ask-${other} [data-q="Q1"][data-choice="B"][aria-pressed="true"]`).waitFor();
    assert.equal(hoop.askResult(other).questions[0]!.answer?.recommended, true);
    assert.deepEqual(hoop.store.allFeedback(review), []);

    // A later revision that changes the line marks the card outdated where a thread would be.
    hoop.submit({ ...parseMarkdown(PLAN.replace("Then tell the clients.", "Then email the clients.")), review_id: review });
    await page.goto(`${base}/r/${review}`);
    await card.locator(".tag-outdated").waitFor();
    await card.locator(".thread-head", { hasText: "Rev 1, line 2" }).waitFor();
  }),
);
