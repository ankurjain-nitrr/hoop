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
