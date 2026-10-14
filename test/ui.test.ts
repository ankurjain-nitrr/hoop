import { test } from "node:test";
import assert from "node:assert/strict";
import { example, tempHome, BROWSER_SKIP, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";


test("a reviewer comments on a line, on selected text and by typed text, answers, and requests changes", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
  const { review_id } = hoop.submit(example());
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
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
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
  assert.equal(await page.locator("#q-Q-1-b").isChecked(), true, "a re-render keeps the chosen answer");
  await page.getByRole("button", { name: /Finish your review/ }).click();
  await page.locator("#v-changes").check();
  await page.locator("#summary").fill("Close. Two questions on dates.");
  await page.getByRole("button", { name: "Submit review" }).click();
  await page.getByText(/Review submitted: Changes requested/).waitFor();
  assert.equal(await page.locator("#q-Q-1-b").isChecked(), true);
  await page.locator(".sub", { has: page.locator(".rev", { hasText: "rev 1" }) }).locator('.badge[data-status="changes_requested"]', { hasText: "Changes requested" }).waitFor();
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
  });
});

test("a revision marks threads on changed lines as outdated", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
  const { review_id } = hoop.submit(example());
  hoop.review(review_id, { verdict: "changes_requested", comments: [
    { item: "FR-3", line: 1, body: "use created_at" }, { item: "FR-2", line: 1, body: "keep this" }] });
  const rev2 = example();
  rev2.items[2].body = "When from or to are given, the system shall include orders created at or after from.";
  hoop.submit({ ...rev2, review_id });
  hoop.reply(`th_${review_id.slice(3)}_1`, "Changed the wording in rev 2.");
  await page.goto(`${base}/r/${review_id}`);
  const fr3 = page.locator("#item-FR-3 .thread");
  await fr3.first().waitFor();
  assert.match(await fr3.first().innerText(), /Outdated/);
  assert.match(await fr3.first().innerText(), /Changed the wording in rev 2\./);
  assert.doesNotMatch(await page.locator("#item-FR-2 .thread").first().innerText(), /Outdated/);
  await page.getByRole("tab", { name: /Changes since rev 1 \(1\)/ }).click();
  assert.equal(await page.locator("#item-FR-3 .line.del").count(), 1);
  assert.equal(await page.locator("#item-FR-2").count(), 0);
  });
});

test("a reviewer comments on a section heading and on selected title text", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
  const { review_id } = hoop.submit(example());
  await page.goto(`${base}/r/${review_id}`);
  await page.locator("#item-FR-3 .item-head").hover();
  await page.getByRole("button", { name: "Comment on FR-3 heading (applies to the whole section)" }).click();
  await page.locator("#cbody").fill("Merge this section into FR-1.");
  await page.getByRole("button", { name: "Start a review" }).click();
  await page.locator('[data-sel-item="DOC"][data-sel-line="0"]').evaluate((el) => {
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!, at = node.textContent!.indexOf("requirements");
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
  });
});

test("Apply suggestion puts the suggested text into the document in a new revision", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
  const { review_id } = hoop.submit(example());
  const line = example().items[2].body as string, start = line.indexOf("created");
  hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-3", line: 1, range: { start, end: start + 7, quote: "created" }, suggestion: "placed" }] });
  await page.goto(`${base}/r/${review_id}`);
  await page.getByRole("button", { name: "Apply suggestion" }).click();
  await page.locator(".rev", { hasText: "rev 2" }).first().waitFor();
  assert.match(await page.locator('[data-sel-item="FR-3"][data-sel-line="0"]').innerText(), /orders placed in that range/);
  assert.match(await page.locator("#item-FR-3 .thread").first().innerText(), /Applied in rev 2/);
  assert.equal(await page.getByRole("button", { name: "Apply suggestion" }).count(), 0);
  });
});

test("Claude's edits show as tracked changes; Accept applies one, Reject drops another", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
  const { review_id } = hoop.submit(example());
  const fb = hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-3", line: 0, body: "inclusive bounds, and say purchases" }] });
  const thread = fb.comments[0]!.thread!;
  hoop.proposeEdits(review_id, thread, [
    { item: "FR-3", line: 1, find: "in that range", replace: "within both bounds, inclusive" },
    { item: "FR-3", line: 1, find: "orders", replace: "purchases" },
  ], "Inclusive bounds; 'purchases' per your comment");
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
  await page.locator(".rev", { hasText: "rev 2" }).first().waitFor();
  await page.locator(`#card-${words}`).getByRole("button", { name: "Reject" }).click();
  await page.getByText("Edit rejected.").waitFor();
  assert.equal(await line.innerText(), "When from or to are given, the system shall include only orders created within both bounds, inclusive.");
  assert.equal(await page.locator(".edit-card").count(), 0);
  assert.match(await page.locator("#item-FR-3 > .thread").first().innerText(), /Applied in rev 2/);
  });
});

test("selecting text after a pending tracked change anchors to the line's own text", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
  const { review_id } = hoop.submit(example());
  const t = hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-3", line: 0, body: "x" }] }).comments[0]!.thread!;
  hoop.proposeEdits(review_id, t, [{ item: "FR-3", line: 1, find: "When from or to", replace: "Whenever a start or end date" }]);
  await page.goto(`${base}/r/${review_id}`);
  const line = page.locator('[data-sel-item="FR-3"][data-sel-line="0"]');
  await line.locator("ins.tc-ins").waitFor();
  await line.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent!.includes("created")) node = n;
    const at = node!.textContent!.indexOf("created");
    const r = document.createRange();
    r.setStart(node!, at); r.setEnd(node!, at + 7);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Comment on selection" }).click();
  await page.locator("#cbody").fill("updated?");
  await page.getByRole("button", { name: "Start a review" }).click();
  await page.getByRole("button", { name: /Finish your review/ }).click();
  await page.getByRole("button", { name: "Submit review" }).click();
  await page.getByText(/Review submitted/).waitFor();
  const fb = hoop.feedback(review_id);
  const c = fb.status === "reviewed" ? fb.feedback.at(-1)!.comments[0]! : undefined;
  const text = example().items[2].body as string;
  assert.deepEqual(c?.range, { start: text.indexOf("created"), end: text.indexOf("created") + 7, quote: "created" });
  });
});

test("FR-2: the header, the list and the frozen review show statuses as shared badges", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id: approved } = hoop.submit(example());
    hoop.review(approved, { verdict: "approved" });
    const { review_id: closed } = hoop.submit({ ...example(), title: "Closed one" });
    hoop.store.update(closed, { status: "closed" });
    await page.goto(`${base}/r/${approved}`);
    await page.locator('.actions .badge[data-status="approved"]', { hasText: "Approved" }).waitFor();
    await page.locator('.sub .badge[data-status="approved"]').waitFor();
    // Regression: the status badge style leaked onto the outline's count badge and drew empty rings.
    const ring = await page.locator(".outline .badge").first().evaluate((el) => getComputedStyle(el).borderStyle);
    assert.equal(ring, "none", "the outline count badge has no ring");
    await page.goto(base);
    await page.locator('.list .badge[data-status="approved"]').waitFor();
    await page.locator('.list .badge[data-status="closed"]', { hasText: "Closed" }).waitFor();
  });
});

const SAMPLE = `# Sample

## Formatting

A line with \`code\`, **bold text**, *italic* and a [link](https://example.com).

- A list item with **bold** words
  - A nested item

> A quote with \`code\`

\`\`\`
const fenced = "code";
\`\`\`

***
`;

test("FR-4, FR-5: a document reads as formatted text, and selections inside it store whole source runs", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(SAMPLE));
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".ln-code").first().waitFor();
    const shown = await page.locator("main .items").innerText();
    for (const marker of ["**", "`", "](", "\n- ", "\n> ", "***"]) assert.ok(!shown.includes(marker), `no "${marker}" shows: ${shown}`);
    assert.equal(await page.locator(".items hr.ln-break").count(), 1);
    assert.equal(await page.locator(".items .ln-list").count(), 2);

    // Selects `word` inside the first rendered line and returns the quote the page would store.
    const quoteFor = (word: string) => page.evaluate(async (w) => {
      const el = document.querySelector('[data-sel-line="0"].text')!;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const at = n.textContent!.indexOf(w);
        if (at < 0) continue;
        const r = document.createRange();
        r.setStart(n, at + 1);
        r.setEnd(n, at + w.length - 1);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(r);
        const page = "/select.js"; // a page module, loaded in the browser
        const { selectionTarget } = await import(page);
        return selectionTarget()?.range.quote ?? null;
      }
      return null;
    }, word);
    assert.equal(await quoteFor("bold text"), "**bold text**");
    assert.equal(await quoteFor("code"), "`code`");
    assert.equal(await quoteFor("link"), "[link](https://example.com)");
    assert.deepEqual(errors, []);
  });
});

test("Speed: a 1000-line document renders in under 200 milliseconds", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const lines = Array.from({ length: 1000 }, (_, i) => i % 5 === 0 ? `- item ${i} with **bold** and \`code\`` : `Line ${i} with *some* [link](https://x.y/${i}).`);
    const { review_id } = hoop.submit(parseMarkdown(`# Big\n\n## Body\n\n${lines.join("\n\n")}\n`));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".line").nth(999).waitFor();
    const times = await page.evaluate(async () => {
      const app = "/app.js"; // a page module, loaded in the browser
      const { render } = await import(app);
      const out: number[] = [];
      for (let i = 0; i < 3; i++) { const t = performance.now(); render(); out.push(performance.now() - t); }
      return out;
    });
    assert.ok(Math.min(...times) < 200, `render took ${times.map((t) => t.toFixed(0)).join(", ")} ms`);
  });
});
