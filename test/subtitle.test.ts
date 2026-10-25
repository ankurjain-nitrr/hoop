import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { kindOf } from "../src/build.js";
import { anchorText, validateReview } from "../src/contract.js";
import { Hoop } from "../src/hoop.js";
import { exportMarkdown, parseMarkdown } from "../src/markdown.js";
import { Store } from "../src/store.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

const DOCS = new URL("./fixtures/docs/", import.meta.url).pathname;
const roundTrip = (md: string) => assert.equal(exportMarkdown(parseMarkdown(md)), md);

test("a line of emphasis under the title is the subtitle, and the document exports byte for byte", () => {
  const cases: [string, string, "_" | undefined][] = [
    [
      "# Billing\n\n*Q4 plan · draft for the platform team*\n\nWe move billing.\n\n## Plan\n\nIn batches.\n",
      "Q4 plan · draft for the platform team",
      undefined,
    ],
    ["# Billing\n\n_Q4 plan_\n\nWe move billing.\n", "Q4 plan", "_"],
    ["# Billing\n\n*Q4 plan*\n\n## Plan\n\nIn batches.\n", "Q4 plan", undefined],
    ["# Billing\n\n*Q4 plan*\n", "Q4 plan", undefined],
  ];
  for (const [md, subtitle, mark] of cases) {
    const doc = parseMarkdown(md);
    assert.equal(doc.subtitle, subtitle, md);
    assert.equal(doc.subtitle_mark, mark, md);
    assert.ok(validateReview(doc).ok, md);
    roundTrip(md);
  }
  // The TL;DR is still the first paragraph, not the subtitle.
  assert.equal(parseMarkdown(cases[0]![0]).tldr, "We move billing.");
  assert.equal(parseMarkdown(cases[0]![0]).items[0]!.body, "\nWe move billing.\n");
});

test("other lines of emphasis are not a subtitle, and documents without one export as before", () => {
  for (const md of [
    "# Billing\n*Q4 plan*\n\nWe move billing.\n", // no blank line between
    "# Billing\n\n*Q4 plan*\n## Plan\n", // a heading right after
    "# Billing\n\n**Q4 plan**\n\nText.\n", // bold
    "# Billing\n\nWe move billing.\n\n*Q4 plan*\n", // not right under the title
    "# Billing\n\n* Q4 plan\n\nText.\n", // a list item
  ]) {
    assert.equal(parseMarkdown(md).subtitle, undefined, md);
    roundTrip(md);
  }
  // Under a title that isn't the first thing in the document.
  assert.equal(parseMarkdown("Intro first.\n\n# Billing\n\n*Q4 plan*\n\nText.\n").subtitle, undefined);
  for (const f of readdirSync(DOCS)) {
    const md = readFileSync(DOCS + f, "utf8");
    assert.equal(parseMarkdown(md).subtitle, undefined, f);
  }
});

test("a comment on the subtitle is DOC line 3, and the title and TL;DR keep lines 1 and 2", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const md = "# Billing\n\n*Q4 plan for billing*\n\nWe move billing.\n\n## Plan\n\nIn batches.\n";
  const { review_id } = hoop.submit({ ...parseMarkdown(md), tldr: "Move billing to the ledger." });
  const doc = hoop.store.revision(review_id);
  assert.deepEqual(
    [1, 2, 3].map((l) => anchorText(doc, "DOC", l)),
    ["Billing", "Move billing to the ledger.", "Q4 plan for billing"],
  );
  const fb = hoop.review(review_id, { verdict: "comment", comments: [{ words: "Q4 plan", body: "Say which quarter's plan." }] });
  assert.deepEqual([fb.comments[0]!.item, fb.comments[0]!.line], ["DOC", 3]);
  assert.throws(
    () => hoop.review(review_id, { verdict: "comment", comments: [{ item: "DOC", line: 4, body: "x" }] }),
    (err: Error & { errors?: { message: string }[] }) => /DOC has lines 1-3/.test(err.errors![0]!.message),
  );
  // Apply changes only the subtitle's words; the rest of the document is as it was.
  const t = hoop.review(review_id, { verdict: "comment", comments: [{ item: "DOC", line: 3, suggestion: "Q1 plan for billing" }] }).comments[0]!.thread!;
  hoop.applySuggestion(review_id, t);
  assert.equal(exportMarkdown(hoop.store.revision(review_id)), md.replace("Q4", "Q1"));
  // A suggestion that would break the line of emphasis is refused.
  const bad = hoop.review(review_id, { verdict: "comment", comments: [{ item: "DOC", line: 3, suggestion: "Q1 *plan* for billing" }] }).comments[0]!.thread!;
  assert.throws(() => hoop.applySuggestion(review_id, bad), /keeps_markup/);
  // Without a subtitle, DOC has lines 1-2 as before.
  const plain = hoop.submit(parseMarkdown("# Plain\n\nText.\n")).review_id;
  assert.throws(() => hoop.review(plain, { verdict: "comment", comments: [{ item: "DOC", line: 3, body: "x" }] }), /invalid feedback/);
});

test("a submitted subtitle must export as one line of emphasis", () => {
  const doc = parseMarkdown("# Billing\n\nText.\n");
  assert.ok(validateReview({ ...doc, subtitle: "Q4 plan" }).ok);
  for (const subtitle of [" Q4", "Q4 *plan*", "two\nlines"]) assert.equal(validateReview({ ...doc, subtitle }).ok, false, subtitle);
});

test("the builder adds a subtitle under the title, and Finish makes it the review's subtitle", () => {
  assert.equal(kindOf("*Q4 plan*"), "subtitle");
  assert.equal(kindOf("**Q4 plan**"), "paragraph");
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.startBuild("# Billing\n\nWe move billing.\n");
  hoop.buildChange(id, { op: "add", kind: "subtitle", after: "b1" });
  assert.equal(hoop.markdownOf(id), "# Billing\n\n*Subtitle*\n\nWe move billing.\n");
  hoop.buildChange(id, { op: "edit", block: "b3", text: "*Q4 plan*" });
  hoop.finishBuild(id);
  const doc = hoop.store.revision(id);
  assert.equal(doc.subtitle, "Q4 plan");
  assert.equal(exportMarkdown(doc), "# Billing\n\n*Q4 plan*\n\nWe move billing.\n");
});

test("the builder's Subtitle field takes words and keeps them a line of emphasis", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild("# Billing\n\n_Draft_\n\nWe move billing.\n");
    await page.goto(`${base}/r/${id}`);
    assert.equal(await page.locator(".bsub").innerText(), "Draft");
    await page.getByRole("button", { name: "Edit Subtitle 2" }).click();
    const box = page.getByLabel("Text of Subtitle 2");
    assert.equal(await box.inputValue(), "Draft");
    await box.fill("Q4 plan for the platform team");
    await box.press("Enter");
    await page.locator(".bsub", { hasText: "Q4 plan for the platform team" }).waitFor();
    assert.equal(hoop.markdownOf(id), "# Billing\n\n_Q4 plan for the platform team_\n\nWe move billing.\n");
  }),
);

test("the review page shows the subtitle under the title, and a comment on it says so", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown("# Billing\n\n*Q4 plan*\n\nWe move billing.\n\n## Plan\n\nIn batches.\n"));
    await page.goto(`${base}/r/${review_id}`);
    const sub = page.locator(".top .subtitle");
    assert.equal(await sub.locator(".anchor").innerText(), "Q4 plan");
    assert.equal(await sub.evaluate((el) => getComputedStyle(el).fontStyle), "italic");
    await page.getByRole("button", { name: "Comment on the subtitle (applies to the whole document)" }).click();
    await page.locator("#cbody").fill("Which quarter?");
    await page.getByRole("button", { name: "Start a review" }).click();
    await page.getByRole("button", { name: /Finish your review/ }).click();
    await page.getByRole("button", { name: "Submit review" }).click();
    await page.getByText(/Review submitted/).waitFor();
    const fb = hoop.feedback(review_id);
    const c = fb.status === "reviewed" ? fb.feedback[0]!.comments[0]! : undefined;
    assert.deepEqual([c?.item, c?.line], ["DOC", 3]);
    await page.getByText("Conversation on the subtitle").waitFor();
  }),
);
