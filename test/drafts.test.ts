import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { BROWSER_SKIP, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";
import { type Now, rebase } from "../web/drafts.js";

const now = (revision: number, lines: Record<string, string[]>, choices: Record<string, Record<string, string>> = {}): Now => ({
  revision,
  lineAt: (item, line) => lines[item]?.[line],
  linesOf: (item) => lines[item],
  choiceLabel: (item, choice) => (choice === "other" && choices[item] ? "Other" : choices[item]?.[choice]),
});

test("drafts stay on unchanged lines, follow a moved line, and go to the stale list otherwise", () => {
  const d = rebase(
    {
      revision: 1,
      pending: [
        { key: "a", item: "S-1", line: 0, text: "Same." },
        { key: "b", item: "S-1", line: 1, text: "Moved." },
        { key: "c", item: "S-1", line: 2, text: "Changed." },
        { key: "d", item: "S-1", line: 2, text: "Changed.", thread: "t1" },
        { key: "e", item: "S-2", line: 0, text: "Gone." },
      ],
      answers: { "S-3": "a", "S-4": "b" },
      labels: { "S-3": { title: "Which?", label: "One" }, "S-4": { title: "How?", label: "Fast" } },
      summary: "Overall.",
    },
    now(2, { "S-1": ["Same.", "New.", "Moved.", "Changed!"] }, { "S-3": { a: "One" }, "S-4": { b: "Slow" } }),
  );
  assert.equal(d.revision, 2);
  assert.deepEqual(
    d.pending.map((p) => [p.key, p.line]),
    [
      ["a", 0],
      ["b", 2],
      ["d", 2],
    ],
    "a reply stays while its line exists",
  );
  assert.deepEqual(
    d.stale.map((s) => [s.key, s.revision]),
    [
      ["c", 1],
      ["e", 1],
      ["a1-S-4", 1],
    ],
  );
  assert.deepEqual(d.answers, { "S-3": "a" }, "an answer whose option reads differently is not kept");
  assert.equal(d.summary, "Overall.");
  // On the same revision nothing moves, and a draft stored before texts were kept takes the line's.
  const same = rebase({ revision: 2, pending: [{ key: "x", item: "S-1", line: 3 }] }, now(2, { "S-1": ["", "", "", "Text."] }));
  assert.equal(same.pending[0]!.text, "Text.");
});

const DOC = (keep: string, change: string, extra = "") =>
  `# Plan\n\nWhy we do it.\n\n## Steps\n\n${extra}${keep}\n\n${change}\n\n## Question: Which store?\n\n- A. Files (recommended)\n- B. SQLite\n`;

const stored = (page: Page, id: string) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), `hoop:${id}:drafts`) as Promise<{
    pending: { line: number; body: string }[];
    summary: string;
  } | null>;

async function comment(page: Page, line: RegExp, body: string) {
  await page.getByRole("button", { name: line }).click();
  await page.locator("#cbody").fill(body);
  await page.locator("#addComment").click();
}

test("a new revision shows a bar without a reload, and Show it keeps every unsent draft", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC("Keep this line.", "Change this line.")));
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      (window as unknown as { HOOP_PENDING_MS: number }).HOOP_PENDING_MS = 150;
    });
    await page.goto(`${base}/r/${review_id}`);
    await comment(page, /"Steps" line 1$/, "Keep me.");
    await comment(page, /"Steps" line 2$/, "Reword this.");
    await page.getByRole("radio", { name: /SQLite/ }).check();
    await page.locator("#finishBtn").click();
    await page.locator("#summary").fill("Nearly there.");
    await page.locator("#cancelFinish").click();
    // Words typed in an open comment box are a draft too.
    await page.getByRole("button", { name: /"Steps" line 1$/ }).click();
    await page.locator("#cbody").fill("Half written");
    await page.evaluate(() => ((window as unknown as { loaded: boolean }).loaded = true));

    // Claude adds a line above the first and rewrites the second.
    hoop.submit({ ...parseMarkdown(DOC("Keep this line.", "Changed line.", "A new first line.\n\n")), review_id });
    const bar = page.locator(".new-revision");
    await bar.getByText("Revision 2 is ready").waitFor({ timeout: 5000 });
    assert.equal(await page.locator(".top .rev").innerText(), "rev 1", "the page doesn't move by itself");
    assert.equal(await page.locator("#cbody").inputValue(), "Half written");
    assert.equal(await page.locator("#cbody").evaluate((el) => el === document.activeElement), true, "typing keeps its focus");

    await bar.getByRole("button", { name: "Show it" }).click();
    await page.locator(".top .rev", { hasText: "rev 2" }).waitFor();
    assert.equal(await bar.isHidden(), true);
    // The comment on the unchanged line followed it to line 2, with the open comment box.
    const drafts = (await stored(page, review_id))!;
    assert.deepEqual(
      drafts.pending.map((p) => [p.line, p.body]),
      [[1, "Keep me."]],
    );
    assert.equal(await page.locator(".pending").count(), 1);
    assert.equal(await page.locator("#cbody").inputValue(), "Half written");
    assert.equal(await page.getByRole("radio", { name: /SQLite/ }).isChecked(), true, "the answer is kept");
    // The comment on the rewritten line waits in the list, quoting the line as it was.
    const list = page.locator(".stale-drafts");
    assert.equal(await list.locator("h2").innerText(), "Drafts from revision 1");
    assert.equal(await list.locator(".quote").innerText(), "Change this line.");
    assert.match(await list.innerText(), /Reword this\./);
    await page.locator("#cancelComment").click();
    await page.locator("#finishBtn").click();
    assert.equal(await page.locator("#summary").inputValue(), "Nearly there.");
    await page.locator("#cancelFinish").click();

    // Placing it again puts its words in a comment on the chosen line.
    await list.getByRole("button", { name: "Place again" }).click();
    await page.getByRole("button", { name: /"Steps" line 3$/ }).click();
    assert.equal(await page.locator("#cbody").inputValue(), "Reword this.");
    await page.locator("#addComment").click();
    await page.locator(".pending").nth(1).waitFor();
    assert.equal(await list.count(), 0, "the list is gone once every draft is placed");
    assert.equal(await page.evaluate(() => (window as unknown as { loaded?: boolean }).loaded), true, "the page wasn't reloaded");
    assert.deepEqual(errors, []);
  }),
);

test("drafts survive a reload, a closed tab and a new revision, and are cleared once sent", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, browser }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC("Keep this line.", "Change this line.")));
    const context = await browser.newContext();
    let page = await context.newPage();
    await page.goto(`${base}/r/${review_id}`);
    await comment(page, /"Steps" line 1$/, "Keep me.");
    await comment(page, /"Steps" line 2$/, "Reword this.");
    await page.reload();
    await page.locator(".pending").nth(1).waitFor();

    await page.close();
    page = await context.newPage();
    hoop.submit({ ...parseMarkdown(DOC("Keep this line.", "Changed line.")), review_id });
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".stale-drafts .quote", { hasText: "Change this line." }).waitFor();
    assert.equal(await page.locator(".items .pending").count(), 1);

    // Sending clears what was sent; the unplaced draft waits until it is placed or discarded.
    await page.getByRole("radio", { name: /SQLite/ }).check();
    await page.locator("#finishBtn").click();
    await page.locator("#summary").fill("Sent.");
    await page.locator("#submitReview").click();
    await page.getByText(/Review submitted: Comment\./).waitFor();
    const after = (await stored(page, review_id))!;
    assert.deepEqual([after.pending, after.summary], [[], ""]);
    await page.reload();
    await page.locator(".stale-drafts").waitFor();
    assert.equal(await page.locator(".items .pending").count(), 0);
    await page.getByRole("button", { name: "Discard" }).click();
    assert.equal(await page.locator(".stale-drafts").count(), 0);
    await page.reload();
    await page.locator(".top h1").waitFor();
    assert.equal(await page.locator(".stale-drafts").count(), 0);
    await context.close();
  }),
);
