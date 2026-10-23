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
    await page
      .locator(".sub", { has: page.locator(".rev", { hasText: "rev 1" }) })
      .locator('.badge[data-status="changes_requested"]', { hasText: "Changes requested" })
      .waitFor();
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
    hoop.review(review_id, {
      verdict: "changes_requested",
      comments: [
        { item: "FR-3", line: 1, body: "use created_at" },
        { item: "FR-2", line: 1, body: "keep this" },
      ],
    });
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
      const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!,
        at = node.textContent!.indexOf("requirements");
      const r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, at + "requirements".length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Comment on selection" }).click();
    assert.match(await page.locator(".composer .lab").first().innerText(), /title \(applies to the whole document\), selected text/);
    await page.locator("#cbody").fill("Say spec");
    await page.getByRole("button", { name: "Add review comment" }).click();
    await page.locator("#q-Q-1-a").check(); // every question is answered before a submit
    await page.getByRole("button", { name: /Finish your review/ }).click();
    await page.getByRole("button", { name: "Submit review" }).click();
    await page.getByText(/Review submitted/).waitFor();
    const fb = hoop.feedback(review_id);
    const comments = fb.status === "reviewed" ? fb.feedback[0]!.comments : [];
    assert.deepEqual(
      comments.map((c) => [c.item, c.line, c.range?.quote]),
      [
        ["FR-3", 0, undefined],
        ["DOC", 1, "requirements"],
      ],
    );
    assert.equal(await page.locator("#item-FR-3 > .thread").count(), 1);
  });
});

test("Apply suggestion puts the suggested text into the document in a new revision", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(example());
    const line = example().items[2].body as string,
      start = line.indexOf("created");
    hoop.review(review_id, {
      verdict: "comment",
      comments: [{ item: "FR-3", line: 1, range: { start, end: start + 7, quote: "created" }, suggestion: "placed" }],
    });
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
    hoop.proposeEdits(
      review_id,
      thread,
      [
        { item: "FR-3", line: 1, find: "in that range", replace: "within both bounds, inclusive" },
        { item: "FR-3", line: 1, find: "orders", replace: "purchases" },
      ],
      "Inclusive bounds; 'purchases' per your comment",
    );
    await page.goto(`${base}/r/${review_id}`);
    const line = page.locator('[data-sel-item="FR-3"][data-sel-line="0"]');
    await line.locator("del.tc-del").first().waitFor();
    assert.deepEqual(await line.locator("del.tc-del").allInnerTexts(), ["orders", "in that range"]);
    assert.deepEqual(await line.locator("ins.tc-ins").allInnerTexts(), ["purchases", "within both bounds, inclusive"]);
    await page.locator(".edit-card", { hasText: "Inclusive" }).first().waitFor();
    const cards = page.locator(".edit-card");
    assert.equal(await cards.count(), 2);
    // Accept the bounds edit, reject the wording one.
    const bounds = hoop.store.proposals(review_id)[0]!.id,
      words = hoop.store.proposals(review_id)[1]!.id;
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
      r.setStart(node!, at);
      r.setEnd(node!, at + 7);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Comment on selection" }).click();
    await page.locator("#cbody").fill("updated?");
    await page.getByRole("button", { name: "Start a review" }).click();
    await page.locator("#q-Q-1-a").check(); // every question is answered before a submit
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
    await page.goto(`${base}/r/${approved}`);
    await page.locator('.actions .badge[data-status="approved"]', { hasText: "Approved" }).waitFor();
    await page.locator('.sub .badge[data-status="approved"]').waitFor();
    // Regression: the status badge style leaked onto the outline's count badge and drew empty rings.
    const ring = await page
      .locator(".outline .badge")
      .first()
      .evaluate((el) => getComputedStyle(el).borderStyle);
    assert.equal(ring, "none", "the outline count badge has no ring");
    await page.goto(base);
    await page.locator('.list .badge[data-status="approved"]').waitFor();
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
    const quoteFor = (word: string) =>
      page.evaluate(async (w) => {
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
    const lines = Array.from({ length: 1000 }, (_, i) =>
      i % 5 === 0 ? `- item ${i} with **bold** and \`code\`` : `Line ${i} with *some* [link](https://x.y/${i}).`,
    );
    const { review_id } = hoop.submit(parseMarkdown(`# Big\n\n## Body\n\n${lines.join("\n\n")}\n`));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".line").nth(999).waitFor();
    const times = await page.evaluate(async () => {
      const app = "/app.js"; // a page module, loaded in the browser
      const { render } = await import(app);
      const out: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        render();
        out.push(performance.now() - t);
      }
      return out;
    });
    assert.ok(Math.min(...times) < 200, `render took ${times.map((t) => t.toFixed(0)).join(", ")} ms`);
  });
});

test("FR-4, FR-5: titles format, stored anchors keep their words, and the Changes tab shows markup changes", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const md = "# Use `hoop audit`\n\n## Part\n\nRead the **bold words** and the [docs](https://a.example).\n";
    const { review_id } = hoop.submit(parseMarkdown(md));
    const doc = hoop.store.revision(review_id);
    const item = doc.items[0]!.id,
      text = doc.items[0]!.body!.trim();
    const start = text.indexOf("**bold"),
      end = text.indexOf(" and the");
    // A comment stored before formatting existed keeps its source range and quote.
    hoop.review(review_id, { verdict: "comment", comments: [{ item, line: 1, body: "Why bold?", range: { start, end, quote: text.slice(start, end) } }] });
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("mark.hl").first().waitFor();
    assert.equal((await page.locator(".items mark.hl").allInnerTexts()).join(""), "bold words", "the highlight covers the same words");
    assert.equal(await page.locator("h1 code").innerText(), "hoop audit", "the title formats its code");

    // Regression: a change to a link target alone looked the same on both sides of the Changes tab.
    hoop.submit({ ...parseMarkdown(md.replace("https://a.example", "https://b.example")), review_id });
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("#tab-changes").click();
    await page.locator(".line.del").first().waitFor();
    assert.match(await page.locator(".line.del .text").first().innerText(), /a\.example/);
    assert.match(await page.locator(".line.add .text").first().innerText(), /b\.example/);
  });
});

test("FR-5a: typed words, formatted quotes and the suggestion check work on formatted lines", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown("# Doc\n\n## Part\n\nSet the `foo` value here.\n\n- keep this marker\n"));
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".add-btn").nth(2).waitFor();
    await page.getByRole("button", { name: /line 1$/ }).click();
    await page.locator("#cpart").fill("the foo value");
    await page.locator("#cpartHint", { hasText: "Found in this line." }).waitFor();
    await page.locator("#cbody").fill("Which value?");
    await page.getByRole("button", { name: "Start a review" }).click();
    const quote = page.locator(".thread .quote").first();
    await quote.waitFor();
    assert.equal(await quote.locator("code").innerText(), "foo", "the quote shows formatted");
    const draft = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith("hoop:"))?.[1] ?? "");
    assert.match(draft, /"quote":"the `foo` value"/, "the stored quote is the whole source text");

    // A suggestion that removes the list marker is stopped on the page, with a message.
    await page.getByRole("button", { name: /line 2$/ }).click();
    await page.getByRole("button", { name: "Suggest a change" }).click();
    await page.locator("#csugg").fill("keep this marker");
    await page.getByRole("button", { name: "Add review comment" }).click();
    await page.locator("#csuggHint", { hasText: "can't change the line's markdown structure" }).waitFor();
    assert.equal(await page.locator(".pending").count(), 1, "nothing new is stored");
    await page.locator("#csugg").fill("- keep this list marker");
    await page.getByRole("button", { name: "Add review comment" }).click();
    await page.locator(".pending").nth(1).waitFor();
    assert.deepEqual(errors, []);
  });
});

test("FR-5a: the page refuses the suggestions the server would refuse, on titles, the TL;DR and structured reviews", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const suggest = async (button: RegExp | string, text: string) => {
      await page.getByRole("button", { name: button }).first().click();
      await page.getByRole("button", { name: "Suggest a change" }).click();
      await page.locator("#csugg").fill(text);
      await page.locator("#addComment").click();
      const hint = (await page.locator("#csuggHint").count()) ? await page.locator("#csuggHint").innerText() : "";
      if (await page.locator("#cancelComment").count()) await page.locator("#cancelComment").click();
      return hint;
    };
    // Regression: the title and the automatic TL;DR skipped the check.
    const doc = hoop.submit(parseMarkdown("# Plan\n\nFirst paragraph.\n")).review_id;
    await page.goto(`${base}/r/${doc}`);
    await page.locator(".top h1").waitFor();
    assert.match(await suggest(/Comment on the title/, "# New title"), /markdown structure/);
    // An automatic TL;DR has no comment button of its own any more (FR-8), so no suggestion can reach it.
    assert.equal(await page.getByRole("button", { name: /Comment on the TL;DR/ }).count(), 0);
    // Regression: a structured review stored a suggestion with a line break, which the server refuses.
    const structured = hoop.submit(example()).review_id;
    await page.goto(`${base}/r/${structured}`);
    await page.locator(".top h1").waitFor();
    await page.getByRole("button", { name: "Comment on FR-1 line 1" }).click();
    await page.getByRole("button", { name: "Suggest a change" }).click();
    await page.locator("#csugg").evaluate((el: HTMLTextAreaElement) => {
      el.value = "two\nlines";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.locator("#addComment").click();
    assert.match(await page.locator("#csuggHint").innerText(), /line breaks/);
    await page.locator("#csugg").fill("");
    await page.locator("#addComment").click();
    assert.match(await page.locator("#csuggHint").innerText(), /remove a whole line/);
    await page.locator("#cancelComment").click();
    // Regression: a structured review's quote was formatted, although its lines show as written.
    const spec = example();
    spec.items[1].body = "Use *args* for the rest.";
    const plain = hoop.submit(spec).review_id;
    hoop.review(plain, {
      verdict: "comment",
      comments: [{ item: spec.items[1].id, line: 1, body: "Why?", range: { start: 0, end: 10, quote: "Use *args*" } }],
    });
    await page.goto(`${base}/r/${plain}`);
    await page.locator(".thread .quote").first().waitFor();
    assert.equal(await page.locator(".thread .quote").first().innerText(), "Use *args*");
  });
});

test("FR-6 to FR-9: the gutter button, hidden document IDs, one automatic TL;DR and no empty badge", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const md = "# Plan\n\nThe first paragraph says what this is.\n\n## Goals\n\nShip it.\n";
    const { review_id } = hoop.submit(parseMarkdown(md));
    // An earlier comment on the automatic TL;DR (DOC line 2) still shows, under the title.
    hoop.review(review_id, { verdict: "comment", comments: [{ item: "DOC", line: 2, body: "Too short." }] });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/r/${review_id}`);
    const head = page.locator(".item-head").nth(1);
    await head.waitFor();

    // FR-6: pointing at a heading doesn't move its text, and the button sits left of the text.
    const title = head.locator(".t .anchor");
    const before = await title.boundingBox();
    await head.hover();
    const btn = head.locator(".add-btn");
    await btn.waitFor();
    const after = await title.boundingBox(),
      b = await btn.boundingBox();
    assert.deepEqual([after!.x, after!.y], [before!.x, before!.y], "the heading text doesn't move");
    assert.ok(b!.x + b!.width <= after!.x, "the button sits in the gutter");

    // FR-7: no section IDs in headings, the outline or comment labels.
    assert.equal(await page.locator(".item-head .id").count(), 0);
    assert.doesNotMatch(await page.locator("nav.outline").innerText(), /\bS-\d/);
    await btn.click();
    assert.equal(await page.locator('label[for="cbody"]').innerText(), 'Comment on "Goals" heading (applies to the whole section)');
    await page.getByRole("button", { name: "Cancel" }).click();

    // FR-8: the automatic TL;DR shows once, as the first paragraph, and its comment shows.
    assert.equal(await page.locator(".tldr").count(), 0);
    const body = await page.locator("main .items").innerText();
    assert.equal(body.split("The first paragraph says what this is.").length - 1, 1);
    assert.equal(await page.locator("main > .tldr").count(), 0, "no separate TL;DR box repeats it");
    await page.getByText("Too short.").waitFor();

    // FR-9: no badge until something is pending.
    assert.equal(await page.locator("#finishBtn .n").count(), 0);
    await page.getByRole("button", { name: 'Comment on "Goals" line 1' }).click();
    await page.locator("#cbody").fill("A note.");
    await page.getByRole("button", { name: "Start a review" }).click();
    assert.equal(await page.locator("#finishBtn .n").innerText(), "1");
    assert.deepEqual(errors, []);
  });
});

test("FR-7: a structured review keeps its item IDs", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(example());
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".item-head .id").first().waitFor();
    assert.equal(await page.locator(".item-head .id").first().innerText(), "FR-1");
    assert.match(await page.locator("nav.outline").innerText(), /FR-1 Export all orders as CSV/);
  });
});

test("FR-6 to FR-8: the button stays out of the text at phone width, repeated titles get distinct names, and a hidden TL;DR's thread says where it is", {
  skip: BROWSER_SKIP,
}, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const md =
      "# Plan\n\nFirst paragraph.\n\n## A heading long enough to wrap onto several lines at phone width for sure\n\nText.\n\n## Notes\n\nOne.\n\n## Notes\n\nTwo.\n";
    const { review_id } = hoop.submit(parseMarkdown(md));
    hoop.review(review_id, { verdict: "comment", comments: [{ item: "DOC", line: 2, body: "Shorter, please." }] });
    await page.setViewportSize({ width: 400, height: 900 });
    await page.goto(`${base}/r/${review_id}`);
    const head = page.locator(".item-head", { hasText: "A heading long enough" });
    await head.waitFor();
    const text = head.locator(".t .anchor");
    const lines = await text.evaluate((el) => el.getClientRects().length);
    assert.ok(lines > 1, "the heading wraps");
    // Regression: the button sat in the text flow, so the text started after it; now hiding it moves nothing.
    const before = await text.boundingBox();
    await head.locator(".inline-gutter").evaluate((el) => {
      (el as HTMLElement).style.display = "none";
    });
    const hidden = await text.boundingBox();
    await head.locator(".inline-gutter").evaluate((el) => {
      (el as HTMLElement).style.display = "";
    });
    assert.deepEqual([hidden!.x, hidden!.y], [before!.x, before!.y], "the button takes no room in the text");
    // Regression: the button was centered on the whole heading; it now sits beside the first line.
    const first = await text.evaluate((el) => {
      const r = el.getClientRects()[0]!;
      return { top: r.top, bottom: r.bottom };
    });
    const btn = await head.locator(".add-btn").boundingBox();
    const mid = btn!.y + btn!.height / 2;
    assert.ok(mid >= first.top && mid <= first.bottom, `the button (${mid}) sits beside the first line (${first.top} to ${first.bottom})`);
    // Regression: two "Notes" sections gave two buttons with the same name.
    const names = await page.locator(".item-head .add-btn").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    assert.equal(new Set(names).size, names.length, `every heading button has its own name: ${names.join("; ")}`);
    // Regression: a thread on the hidden automatic TL;DR said only "line 2".
    assert.match(await page.locator(".thread-head").first().innerText(), /Conversation on the TL;DR: First paragraph\./);
  });
});

/** A document with two agent threads, one of them resolved, and a highlight on the open one's line. */
async function reviewWithThreads(hoop: import("../src/hoop.js").Hoop) {
  const { review_id } = hoop.submit(parseMarkdown("# Plan\n\n## Goals\n\nShip the export soon.\n\n## Risks\n\nNone known yet.\n"));
  const items = hoop.store.revision(review_id).items;
  const goals = items.find((i) => i.title === "Goals")!,
    risks = items.find((i) => i.title === "Risks")!;
  const fb = hoop.review(review_id, {
    verdict: "comment",
    reviewer: "staff engineer (agent)",
    comments: [
      { item: goals.id, line: 1, body: "Which date is soon?" },
      { item: risks.id, line: 1, body: "Name one risk.", range: { start: 0, end: 4, quote: "None" } },
    ],
  });
  const [a, b] = fb.comments.map((c) => c.thread!);
  // Claude's proposed edit on the Goals line: its inserted words hide, its struck words stay.
  hoop.proposeEdits(review_id, a!, [{ item: goals.id, line: 1, find: "soon", replace: "in May" }]);
  await new Promise((r) => setTimeout(r, 5));
  hoop.review(review_id, { verdict: "comment", reviewer: "owner", comments: [], resolved_threads: [a] });
  return { review_id, goals, risks, a: a!, b: b! };
}

test("resolved threads collapse, open on demand, and a later reply reopens them", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id, goals, a } = await reviewWithThreads(hoop);
    const open = () => page.goto(`${base}/r/${review_id}`).then(() => page.locator(".top h1").waitFor());
    await open();
    const row = page.locator(`details[data-thread="${a}"]`);
    // FR-1: a summary row with its place and count, and none of its comment text, at phone width too.
    assert.equal(await row.getAttribute("open"), null);
    assert.match(await row.locator("summary").innerText(), /Resolved · 1 comment/);
    assert.equal(await page.getByText("Which date is soon?").isVisible(), false);
    await page.setViewportSize({ width: 400, height: 800 });
    assert.equal(await page.getByText("Which date is soon?").isVisible(), false);
    await page.setViewportSize({ width: 1200, height: 900 });

    // FR-2: it opens, stays open through a render, and a reload closes it again.
    await row.locator("summary").click();
    await page.getByText("Which date is soon?").waitFor();
    await page.locator(`#viewed-${goals.id}`).check();
    await page.locator(`#viewed-${goals.id}`).uncheck();
    assert.notEqual(await page.locator(`details[data-thread="${a}"]`).getAttribute("open"), null, "an opened thread stays open");
    await open();
    assert.equal(await page.locator(`details[data-thread="${a}"]`).getAttribute("open"), null);

    // FR-3: the open thread shows in full, collapses on Resolve, and shows again on Unresolve.
    await page.getByRole("button", { name: "Resolve conversation" }).click();
    assert.equal(await page.locator("details.thread").count(), 2);
    await page.locator("details.thread").nth(1).locator("summary").click();
    await page.getByRole("button", { name: "Unresolve" }).click();
    assert.equal(await page.locator("details.thread").count(), 1);

    // FR-3: a reply after the resolution reopens the thread, which can then be resolved again.
    await new Promise((r) => setTimeout(r, 5));
    hoop.reply(a, "The date is in the plan now.");
    await open();
    assert.equal(await page.locator(`details[data-thread="${a}"]`).count(), 0, "the reopened thread shows in full");
    assert.equal(await page.getByRole("button", { name: "Resolve conversation" }).count(), 2);
  });
});

test("one control hides every comment without moving focus, and the verdict always sees them", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id, risks } = await reviewWithThreads(hoop);
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".top h1").waitFor();
    const line = page.locator(`[data-sel-item="${risks.id}"][data-sel-line="0"]`);
    const text = await line.innerText();
    const control = page.locator("#hideComments");
    await control.focus();
    await page.keyboard.press("Enter");
    // FR-4: every comment hides, the line keeps its words, focus stays, and the control counts.
    assert.equal(await page.locator('[data-comment="hide"]:visible').count(), 0);
    // Regression: the test only counted marked elements, so an unmarked comment would have passed.
    const shown = await page.locator("main").innerText();
    for (const words of ["Which date is soon?", "Name one risk.", "in May"]) assert.equal(shown.includes(words), false, `"${words}" is hidden`);
    assert.equal(await line.innerText(), text, "the line keeps its words");
    assert.match(shown, /Ship the export soon\./, "Claude's struck words stay as the document's own text");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "hideComments");
    assert.equal(await control.innerText(), "Show comments (2)");
    assert.equal(await control.getAttribute("aria-pressed"), "true");
    // The mode survives a render.
    await page.locator(`#viewed-${risks.id}`).check();
    assert.equal(await page.locator('[data-comment="hide"]:visible').count(), 0, "a render keeps the mode");
    // Regression: the control stayed clickable inside the finish panel and the comment box.
    await page.locator("#hideComments").click();
    await page.locator("#finishBtn").click();
    assert.equal(await page.locator("#hideComments").count(), 0, "no hide control while finishing");
    await page.locator("#cancelFinish").click();
    await page.locator(".line .add-btn").first().click();
    await page.locator("#cbody").waitFor();
    assert.equal(await page.locator("#hideComments").count(), 0, "no hide control while writing a comment");
    await page.locator("#cancelComment").click();
    await page.locator("#hideComments").click();
    // FR-5: the finish panel shows every comment again.
    await page.locator("#finishBtn").click();
    assert.ok((await page.locator('[data-comment="hide"]:visible').count()) > 0);
    await page.locator("#cancelFinish").click();
    assert.ok((await page.locator('[data-comment="hide"]:visible').count()) > 0, "the mode stays ended after the next render");
    // FR-5: so does the comment box, and a reload starts with comments shown.
    await page.locator("#hideComments").click();
    await page.locator(`#viewed-${risks.id}`).uncheck();
    await page.locator(".line .add-btn").first().click();
    await page.locator("#cbody").waitFor();
    assert.ok((await page.locator('[data-comment="hide"]:visible').count()) > 0);
    await page.locator("#cancelComment").click();
    await page.locator("#hideComments").click();
    await page.reload();
    await page.locator(".top h1").waitFor();
    assert.ok((await page.locator('[data-comment="hide"]:visible').count()) > 0);
  });
});

test("a resolved thread under a table row collapses too", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const md = "# Costs\n\n## Rows\n\n| Item | Owner | Kind | Note | State |\n|---|---|---|---|---|\n| Servers | | rent | Write it. | open |\n";
    const { review_id } = hoop.submit(parseMarkdown(md));
    const rows = hoop.store.revision(review_id).items.find((i) => i.title === "Rows")!;
    const fb = hoop.review(review_id, { verdict: "comment", reviewer: "agent", comments: [{ item: rows.id, line: 3, body: "Say what it writes." }] });
    await new Promise((r) => setTimeout(r, 5));
    hoop.review(review_id, { verdict: "comment", reviewer: "owner", comments: [], resolved_threads: [fb.comments[0]!.thread!] });
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("table.md-table").first().waitFor();
    const row = page.locator(`details[data-thread="${fb.comments[0]!.thread}"]`);
    await row.waitFor();
    assert.equal(await row.getAttribute("open"), null);
    assert.equal(await page.getByText("Say what it writes.").isVisible(), false);
  });
});

test("FR-74, FR-75: a reviewer deletes selected text in one action, or edits a line in place, and Apply applies each", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(example());
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/r/${review_id}`);
    await page.getByText("Export all orders as CSV").first().waitFor();
    const fr3 = page.locator('[data-sel-item="FR-3"][data-sel-line="0"]');
    const before = await fr3.innerText();

    // Delete: select a word and delete it in one action.
    await fr3.evaluate((el) => {
      const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
      const at = node.textContent!.indexOf("created");
      const r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, at + "created".length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Delete selection" }).click();

    // Edit in place: FR-1 line 2 opens with its text, ready to change.
    await page.locator('[data-sel-item="FR-1"][data-sel-line="1"]').hover();
    await page.getByRole("button", { name: "Edit FR-1 line 2 in place" }).click();
    const box = page.locator("#csugg");
    const original = await box.inputValue();
    assert.ok(original.length > 0);
    await box.fill(`${original} Each row ends with a newline.`);
    await page.getByRole("button", { name: "Add review comment" }).click();

    await page.locator("#q-Q-1-a").check(); // every question is answered before a submit
    await page.getByRole("button", { name: /Finish your review/ }).click();
    await page.getByRole("button", { name: "Submit review" }).click();
    await page.getByText(/Review submitted/).waitFor();

    // Both show as suggestions with Apply, and each applies.
    for (let n = 0; n < 2; n++) {
      await page.getByRole("button", { name: "Apply suggestion" }).first().click();
      await page
        .locator(".rev", { hasText: `rev ${n + 2}` })
        .first()
        .waitFor();
    }
    const after = await page.locator('[data-sel-item="FR-3"][data-sel-line="0"]').innerText();
    assert.equal(after, before.replace("created ", ""));
    assert.match(await page.locator('[data-sel-item="FR-1"][data-sel-line="1"]').innerText(), /Each row ends with a newline\.$/);
    assert.deepEqual(errors, []);
  });
});

test("a reviewer answers a question in a markdown document, and the answer reaches the agent", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const doc = parseMarkdown(
      "# Plan\n\n## Question: Should approving save the text?\n\n- A. Nothing is written (recommended)\n- B. Write back to the source file\n",
    );
    const { review_id } = hoop.submit(doc);
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("#q-S-1-b").check();
    const shown = await page.locator("#item-S-1").innerText();
    assert.equal(shown.split("Nothing is written").length - 1, 1, "each option shows once");
    assert.equal(shown.split("Write back to the source file").length - 1, 1, "each option shows once");
    assert.equal(await page.locator("#item-S-1 .line.option").count(), 2, "each option line carries its radio button");
    assert.equal(await page.locator('#item-S-1 .line.option:has-text("Write back") input[type=radio]').isChecked(), true);
    assert.equal(await page.locator("#item-S-1 .line.option .add-btn").count(), 2, "an option line can still be commented on");
    assert.equal(await page.locator("#item-S-1 .qopts input").count(), 1, "only Other follows the options");
    await page.getByRole("button", { name: /Finish your review/ }).click();
    await page.getByRole("button", { name: "Submit review" }).click();
    await page.getByText(/Review submitted/).waitFor();
    const fb = hoop.feedback(review_id);
    assert.deepEqual(fb.status === "reviewed" ? fb.feedback[0]!.answers : [], [{ item: "S-1", choice: "b" }]);
  });
});

test("Submit is refused while a question is unanswered, and Other is answered in a comment on the question", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const doc = parseMarkdown(
      "# Plan\n\n## Question: Which store?\n\n- A. Files (recommended)\n- B. SQLite\n\n## Question: When do we ship?\n\n- Now\n- Next week\n",
    );
    const { review_id } = hoop.submit(doc);
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("#q-S-1-b").check();
    await page.getByRole("button", { name: /Finish your review/ }).click();
    await page.getByRole("button", { name: "Submit review" }).click();
    assert.match(await page.locator("#finishError").innerText(), /Answer every question before you submit\. Not answered yet: Question: When do we ship\?/);
    assert.equal(hoop.feedback(review_id).status, "pending", "nothing is sent");
    await page.locator("#q-S-2-other").check();
    assert.match(await page.locator("#item-S-2 .composer label").first().innerText(), /Your answer to/);
    await page.getByRole("button", { name: "Submit review" }).click();
    assert.match(await page.locator("#finishError").innerText(), /choose Other and write your answer in the comment/);
    await page.locator("#cancelFinish").click();
    await page.locator("#cbody").fill("After the holidays.");
    await page.locator("#addComment").click();
    await page.locator("#q-S-2-other").check();
    assert.equal(await page.locator("#item-S-2 .composer").count(), 0, "a written answer opens no second comment");
    await page.getByRole("button", { name: /Finish your review/ }).click();
    await page.getByRole("button", { name: "Submit review" }).click();
    await page.getByText(/Review submitted/).waitFor();
    const fb = hoop.feedback(review_id);
    const sent = fb.status === "reviewed" ? fb.feedback[0]! : undefined;
    assert.deepEqual(sent?.answers, [
      { item: "S-1", choice: "b" },
      { item: "S-2", choice: "other", text: "After the holidays." },
    ]);
    assert.deepEqual(
      sent?.comments.map((c) => [c.item, c.line, c.body]),
      [["S-2", 0, "After the holidays."]],
    );
    assert.equal(await page.locator("#q-S-2-other").isChecked(), true, "the sent answer stays shown");
    assert.match(await page.locator("#item-S-2").innerText(), /After the holidays\./, "the reviewer's own words stay on the page");
  });
});

test("an answer sent on an earlier revision still counts, so approving a revision doesn't ask again", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const md = "# Plan\n\n## Question: Which store?\n\n- Files\n- SQLite\n\n## Steps\n\n- Build it.\n";
    const { review_id } = hoop.submit(parseMarkdown(md));
    hoop.review(review_id, { verdict: "comment", reviewer: "priya", answers: [{ item: "S-1", choice: "a" }] });
    hoop.submit({ ...parseMarkdown(md.replace("Build it.", "Build it with files.")), review_id });
    await page.goto(`${base}/r/${review_id}`);
    await page.getByRole("button", { name: /Finish your review/ }).click();
    await page.getByRole("button", { name: "Submit review" }).click();
    await page.getByText(/Review submitted/).waitFor();
  });
});
