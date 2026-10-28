import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "../src/markdown.js";
import { BROWSER_SKIP, hasFocus, withBrowser } from "./helpers.js";

const doc = (title: string) => parseMarkdown(`# ${title}\n\nWhy it matters.\n`);

test("Close on a Home row: confirm and cancel from the keyboard, the row moves to Completed and the link still opens", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const older = hoop.submit(doc("Cache keys")).review_id;
    const newer = hoop.submit(doc("Order export")).review_id;
    await page.goto(base);
    const row = (id: string) => page.locator(".list-row", { has: page.locator(`a[href="/r/${id}"]`) });
    await row(newer).locator("[data-close-review]").waitFor({ state: "attached" });
    assert.equal(await page.locator("a button, a form").count(), 0, "no control sits inside a row's link");

    // The row's link, then its Close, in tab order.
    await row(newer).locator("a.row").focus();
    await page.keyboard.press("Tab");
    assert.ok(await hasFocus(row(newer).getByRole("button", { name: "Close: Order export" })));
    await page.keyboard.press("Enter");
    assert.ok(await hasFocus(page.getByLabel("Reason (optional)")));
    // Escape cancels and puts focus back on Close.
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".row-confirm").count(), 0);
    assert.ok(await hasFocus(row(newer).getByRole("button", { name: "Close: Order export" })));
    assert.equal(hoop.store.meta(newer).closed, undefined);
    // So does Cancel.
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Cancel" }).click();
    assert.equal(await page.locator(".row-confirm").count(), 0);

    await row(newer).getByRole("button", { name: "Close: Order export" }).click();
    await page.getByLabel("Reason (optional)").fill("Not needed");
    await page.keyboard.press("Enter");
    await page.locator(`#g-completed-body a[href="/r/${newer}"] [data-status="closed"]`, { hasText: "Closed (not approved)" }).waitFor({ state: "attached" });
    assert.equal(await page.locator(`#g-pending-body a[href="/r/${newer}"]`).count(), 0, "it left Pending");
    assert.equal(hoop.store.meta(newer).closed?.reason, "Not needed");
    assert.notEqual(hoop.store.meta(newer).status, "approved", "closing approves nothing");
    // Focus goes to the next row, and screen readers hear what happened.
    assert.ok(await hasFocus(page.locator(`a[href="/r/${older}"]`)));
    await page.waitForFunction(
      () => document.querySelector("#page-live[role=status]")?.textContent === "Closed “Order export” without approving it. It's under Completed.",
    );

    // The link beside Close still opens the review.
    await page.keyboard.press("Enter");
    await page.waitForURL(`${base}/r/${older}`);
  });
});

test("Home offers Close only on rows the person can close", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const open = hoop.submit(doc("Still open")).review_id;
    const approved = hoop.submit(doc("Approved one")).review_id;
    hoop.store.update(approved, { status: "approved", approved_at: new Date().toISOString(), approved_revision: 1 });
    const closed = hoop.submit(doc("Closed one")).review_id;
    hoop.close(closed, "Not needed");
    const question = { question: "Keep it?", options: [{ label: "Yes", recommended: true }, { label: "No" }] };
    const ask = hoop.ask({ questions: [question] }).review_id;
    const answered = hoop.ask({ questions: [question] }).review_id;
    hoop.answer(answered, { question: "Q1", choice: "A" });
    const build = hoop.startBuild("# Being built\n").review_id;
    await page.goto(base);
    await page.locator(`a[href="/r/${closed}"]`).waitFor({ state: "attached" });
    const offered = await page.locator("[data-close-review]").evaluateAll((bs) => bs.map((b) => b.getAttribute("data-close-review")));
    assert.deepEqual(offered.sort(), [open, ask].sort());
    for (const id of [approved, closed, answered, build]) assert.equal(await page.locator(`a[href="/r/${id}"]`).count(), 1, `${id} is listed`);
  });
});

/** Makes Home refresh its list every `ms` milliseconds. */
const refreshEvery = (ms: number) => ((window as unknown as { HOOP_PENDING_MS: number }).HOOP_PENDING_MS = ms);

test("A row's Close takes focus over another open form and keeps its reason through a repaint", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const id = hoop.submit(doc("Order export")).review_id;
    await page.goto(base);
    await page.locator("[data-rename]").first().click();
    await page.locator(".rename input").waitFor();
    await page.locator(`[data-close-review="${id}"]`).click();
    assert.ok(await hasFocus(page.locator(`#${id}-closeReason`)), "focus is in this row's reason box, not the rename field");
    await page.keyboard.type("Not needed");
    await page.getByRole("button", { name: "Expand all" }).click();
    assert.equal(await page.locator(`#${id}-closeReason`).inputValue(), "Not needed");
  });
});

test("A row's Close confirmation goes once its question is answered elsewhere, and Home keeps refreshing", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    await page.addInitScript(refreshEvery, 200);
    const question = { question: "Keep it?", options: [{ label: "Yes", recommended: true }, { label: "No" }] };
    const ask = hoop.ask({ questions: [question] }).review_id;
    await page.goto(base);
    await page.locator(`[data-close-review="${ask}"]`).click();
    await page.locator(".row-confirm").waitFor();
    hoop.answer(ask, { question: "Q1", choice: "A" });
    await page.locator(".row-confirm").waitFor({ state: "detached" });
    const later = hoop.submit(doc("Later")).review_id;
    await page.locator(`a[href="/r/${later}"]`).waitFor({ state: "attached" });
  });
});

test("A refused close shows in the confirmation on screen, even after a repaint while it was sent", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const id = hoop.submit(doc("Order export")).review_id;
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/reviews/*/close", async (route) => {
      await held;
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "It's closed already." }) });
    });
    await page.goto(base);
    await page.locator(`[data-close-review="${id}"]`).click();
    await page.keyboard.type("Not needed");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Expand all" }).click();
    release();
    await page.locator(".row-confirm .steer-error", { hasText: "It's closed already." }).waitFor();
    const input = page.locator(`#${id}-closeReason`);
    assert.ok(await hasFocus(input));
    assert.equal(await input.getAttribute("aria-invalid"), "true");
    assert.equal(await input.inputValue(), "Not needed");
  });
});

test("Closing from Home keeps focus on the next row while the list refreshes, and says less when the list can't be fetched", {
  skip: BROWSER_SKIP,
}, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    await page.addInitScript(refreshEvery, 100);
    const older = hoop.submit(doc("Cache keys")).review_id;
    const newer = hoop.submit(doc("Order export")).review_id;
    let closed = false;
    await page.route("**/api/reviews/*/close", async (route) => {
      closed = true;
      await route.continue();
    });
    // Each list request takes a while, so refreshes land while the close is fetching the list; after the close, they fail.
    await page.route("**/api/reviews", async (route) => {
      await new Promise((r) => setTimeout(r, 300));
      if (closed) await route.fulfill({ status: 500, body: "{}" });
      else await route.continue();
    });
    await page.goto(base);
    await page.locator(`[data-close-review="${newer}"]`).click();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#page-live")?.textContent === "Closed “Order export” without approving it.");
    assert.ok(await hasFocus(page.locator(`a[href="/r/${older}"]`)));
  });
});
