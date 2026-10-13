import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { example, tempHome } from "./helpers.js";

const CHROME = process.env.HOOP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NODE_OK = Number(process.versions.node.split(".")[0]) >= 20; // Playwright needs Node 20+; hoop itself runs on 18
const SKIP = !NODE_OK ? "browser test needs Node 20+" : !existsSync(CHROME) ? "Chrome not found (set HOOP_CHROME)" : false;

test("a reviewer comments on a line, on selected text and by typed text, answers, and requests changes", { skip: SKIP }, async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { review_id } = hoop.submit(example());
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/r/${review_id}`);
    await page.getByText("Export all orders as CSV").first().waitFor();

    // Whole-line comment with a suggestion on FR-1 line 2.
    await page.locator('[data-sel-item="FR-1"][data-sel-line="1"]').hover();
    await page.getByRole("button", { name: "Comment on FR-1 line 2" }).click();
    await page.locator("#cbody").fill("Say what happens when the client disconnects.");
    await page.getByRole("button", { name: "Suggest a change" }).click();
    await page.locator("#csugg").fill("Rows shall stream as they are read; a disconnect stops the query.");
    await page.getByRole("button", { name: "Start a review" }).click();

    // Drag-select "created" in FR-3 line 1 and comment on just that word.
    const text = page.locator('[data-sel-item="FR-3"][data-sel-line="0"]');
    await text.evaluate((el) => {
      const node = el.firstChild!;
      const at = node.textContent!.indexOf("created");
      const r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, at + "created".length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Comment on selection" }).click();
    await page.locator("#cbody").fill("created_at or updated_at?");
    await page.getByRole("button", { name: "Add review comment" }).click();
    assert.equal(await page.locator('[data-sel-item="FR-3"] mark.hl').textContent(), "created");

    // Keyboard path: "+" then type the words in "Only about this text".
    await page.locator('[data-sel-item="FR-2"][data-sel-line="0"]').hover();
    await page.getByRole("button", { name: "Comment on FR-2 line 1" }).click();
    await page.locator("#cpart").fill("createdAt");
    assert.equal(await page.locator("#cpartHint").textContent(), "Found in this line.");
    await page.locator("#cbody").fill("ISO 8601 in UTC.");
    await page.getByRole("button", { name: "Add review comment" }).click();

    // Answer the question, mark an item viewed, then request changes.
    await page.locator("#q-Q-1-b").check();
    await page.locator("#viewed-FR-1").check();
    await page.getByRole("button", { name: /Finish your review/ }).click();
    await page.locator("#v-changes").check();
    await page.locator("#summary").fill("Close. Two questions on dates.");
    await page.getByRole("button", { name: "Submit review" }).click();
    await page.getByText(/Review submitted: Changes requested/).waitFor();
    assert.equal(await page.locator("#q-Q-1-b").isChecked(), true);
    await page.getByText("rev 1 · changes requested").waitFor();
    await page.screenshot({ path: `${process.env.HOOP_SCREENSHOT_DIR ?? tempHome()}/review.png`, fullPage: true });

    const fb = hoop.feedback(review_id);
    assert.equal(fb.status, "reviewed");
    if (fb.status !== "reviewed") return;
    const f = fb.feedback[0]!;
    assert.equal(f.verdict, "changes_requested");
    assert.equal(f.summary, "Close. Two questions on dates.");
    assert.deepEqual(
      f.comments.map((c) => ({ item: c.item, line: c.line, quote: c.range?.quote, suggestion: c.suggestion })),
      [
        { item: "FR-1", line: 2, quote: undefined, suggestion: "Rows shall stream as they are read; a disconnect stops the query." },
        { item: "FR-3", line: 1, quote: "created", suggestion: undefined },
        { item: "FR-2", line: 1, quote: "createdAt", suggestion: undefined },
      ],
    );
    assert.deepEqual(f.answers, [{ item: "Q-1", choice: "b" }]);
    assert.deepEqual(f.viewed, ["FR-1"]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

test("a revision marks threads on changed lines as outdated", { skip: SKIP }, async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { review_id } = hoop.submit(example());
    hoop.review(review_id, { verdict: "changes_requested", comments: [
      { item: "FR-3", line: 1, body: "use created_at" }, { item: "FR-2", line: 1, body: "keep this" }] });
    const rev2 = example();
    rev2.items[2].body = "When from or to are given, the system shall include orders created at or after from.";
    hoop.submit({ ...rev2, review_id });
    hoop.reply(`th_${review_id.slice(3)}_1`, "Changed the wording in rev 2.");
    const page = await browser.newPage();
    await page.goto(`${base}/r/${review_id}`);
    const fr3 = page.locator("#item-FR-3 .thread");
    await fr3.first().waitFor();
    assert.match(await fr3.first().innerText(), /Outdated/);
    assert.match(await fr3.first().innerText(), /Changed the wording in rev 2\./);
    assert.doesNotMatch(await page.locator("#item-FR-2 .thread").first().innerText(), /Outdated/);
    await page.getByRole("tab", { name: /Changes since rev 1 \(1\)/ }).click();
    assert.equal(await page.locator("#item-FR-3 .line.del").count(), 1);
    assert.equal(await page.locator("#item-FR-2").count(), 0);
  } finally {
    await browser.close();
    server.close();
  }
});

test("a reviewer comments on a section heading and on selected title text", { skip: SKIP }, async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { review_id } = hoop.submit(example());
    const page = await browser.newPage();
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("#item-FR-3 .item-head").hover();
    await page.getByRole("button", { name: "Comment on FR-3 heading (applies to the whole section)" }).click();
    await page.locator("#cbody").fill("Merge this section into FR-1.");
    await page.getByRole("button", { name: "Start a review" }).click();
    await page.locator('[data-sel-item="DOC"][data-sel-line="0"]').evaluate((el) => {
      const node = el.firstChild!, at = node.textContent!.indexOf("requirements");
      const r = document.createRange();
      r.setStart(node, at); r.setEnd(node, at + "requirements".length);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Comment on selection" }).click();
    assert.match(await page.locator(".composer .lab").first().innerText(), /title \(applies to the whole document\), selected text/);
    await page.locator("#cbody").fill("Say spec");
    await page.getByRole("button", { name: "Add review comment" }).click();
    await page.getByRole("button", { name: /Finish your review/ }).click();
    await page.getByRole("button", { name: "Submit review" }).click();
    await page.getByText(/Review submitted/).waitFor();
    const fb = hoop.feedback(review_id);
    const comments = fb.status === "reviewed" ? fb.feedback[0]!.comments : [];
    assert.deepEqual(comments.map((c) => [c.item, c.line, c.range?.quote]), [["FR-3", 0, undefined], ["DOC", 1, "requirements"]]);
    assert.equal(await page.locator("#item-FR-3 > .thread").count(), 1);
  } finally {
    await browser.close();
    server.close();
  }
});

test("Apply suggestion puts the suggested text into the document in a new revision", { skip: SKIP }, async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { review_id } = hoop.submit(example());
    const line = example().items[2].body as string, start = line.indexOf("created");
    hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-3", line: 1, range: { start, end: start + 7, quote: "created" }, suggestion: "placed" }] });
    const page = await browser.newPage();
    await page.goto(`${base}/r/${review_id}`);
    await page.getByRole("button", { name: "Apply suggestion" }).click();
    await page.getByText("rev 2 · ").first().waitFor();
    assert.match(await page.locator('[data-sel-item="FR-3"][data-sel-line="0"]').innerText(), /orders placed in that range/);
    assert.match(await page.locator("#item-FR-3 .thread").first().innerText(), /Applied in rev 2/);
    assert.equal(await page.getByRole("button", { name: "Apply suggestion" }).count(), 0);
  } finally {
    await browser.close();
    server.close();
  }
});

test("Claude's edits show as tracked changes; Accept applies one, Reject drops another", { skip: SKIP }, async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { review_id } = hoop.submit(example());
    const fb = hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-3", line: 0, body: "inclusive bounds, and say purchases" }] });
    const thread = fb.comments[0]!.thread!;
    hoop.proposeEdits(review_id, thread, [
      { item: "FR-3", line: 1, find: "in that range", replace: "within both bounds, inclusive" },
      { item: "FR-3", line: 1, find: "orders", replace: "purchases" },
    ], "Inclusive bounds; 'purchases' per your comment");
    const page = await browser.newPage();
    await page.goto(`${base}/r/${review_id}`);
    const line = page.locator('[data-sel-item="FR-3"][data-sel-line="0"]');
    await line.locator("del.tc-del").first().waitFor();
    assert.deepEqual(await line.locator("del.tc-del").allInnerTexts(), ["orders", "in that range"]);
    assert.deepEqual(await line.locator("ins.tc-ins").allInnerTexts(), ["purchases", "within both bounds, inclusive"]);
    await page.locator(".edit-card", { hasText: "Inclusive" }).first().waitFor();
    const cards = page.locator(".edit-card");
    assert.equal(await cards.count(), 2);
    // Accept the bounds edit, reject the wording one.
    const bounds = hoop.store.proposals(review_id)[0]!.id, words = hoop.store.proposals(review_id)[1]!.id;
    await page.locator(`#card-${bounds}`).getByRole("button", { name: "Accept", exact: true }).click();
    await page.getByText("rev 2 · ").first().waitFor();
    await page.locator(`#card-${words}`).getByRole("button", { name: "Reject" }).click();
    await page.getByText("Edit rejected.").waitFor();
    assert.equal(await line.innerText(), "When from or to are given, the system shall include only orders created within both bounds, inclusive.");
    assert.equal(await page.locator(".edit-card").count(), 0);
    assert.match(await page.locator("#item-FR-3 > .thread").first().innerText(), /Applied in rev 2/);
  } finally {
    await browser.close();
    server.close();
  }
});
