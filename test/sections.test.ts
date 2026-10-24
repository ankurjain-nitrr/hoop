import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { commentScope, sectionItems } from "../src/contract.js";
import { Hoop } from "../src/hoop.js";
import { matchSections, parseMarkdown } from "../src/markdown.js";
import { Store } from "../src/store.js";
import { reviewView } from "../src/web.js";
import { BROWSER_SKIP, MERMAID_SRI, MERMAID_URL, mermaidFile, serveMermaid, tempHome, withBrowser } from "./helpers.js";

const DEEP = "# Plan\n\nIntro.\n\n## Two\n\nA.\n\n### Three\n\nB.\n\n#### Four\n\nC.\n\n##### Five\n\nD.\n\n###### Six\n\nE.\n\n## Next\n\nF.\n";

test("a comment on a heading covers its section and every section nested in it", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(parseMarkdown(DEEP, {}));
  const doc = hoop.store.revision(review_id);
  const two = doc.items.find((i) => i.title === "Two")!.id;
  const nested = doc.items.filter((i) => ["Two", "Three", "Four", "Five", "Six"].includes(i.title)).map((i) => i.id);
  assert.deepEqual(sectionItems(doc, two), nested);
  assert.deepEqual(commentScope(doc, { item: two, line: 0 }), { kind: "section", items: nested });
  // An edit for the heading's comment may change a nested section.
  const fb = hoop.review(review_id, { verdict: "comment", comments: [{ item: two, line: 0, body: "Tighten all of this" }] });
  const six = doc.items.find((i) => i.title === "Six")!.id;
  const { proposals } = hoop.proposeEdits(review_id, fb.comments[0]!.thread!, [{ item: six, line: 1, find: "E.", replace: "E, done." }]);
  assert.equal(proposals[0]!.item, six);
});

test("a renamed section keeps its ID by level, parent and place; two equal headings keep their own", () => {
  const before = parseMarkdown("# Doc\n\n## Goals\n\nA.\n\n### Detail\n\nB.\n\n## Risks\n\nC.\n\n## Risks\n\nD.\n", {});
  const after = parseMarkdown("# Doc\n\n## Aims\n\nA.\n\n### More detail\n\nB.\n\n## Risks\n\nC2.\n\n## Risks\n\nD2.\n", {});
  const { doc, renamed } = matchSections(before, after);
  assert.deepEqual(
    doc.items.map((i) => i.id),
    before.items.map((i) => i.id),
  );
  const [goals, detail] = [before.items[0]!.id, before.items[1]!.id];
  assert.deepEqual(renamed, { [goals]: "Goals", [detail]: "Detail" });
  // A heading that moves to another level or parent is a new section.
  const moved = matchSections(before, parseMarkdown("# Doc\n\n## Goals\n\nA.\n\n## Risks\n\nC.\n\n## Risks\n\nD.\n\n### Detail renamed\n\nB.\n", {}));
  assert.ok(!moved.doc.items.some((i) => i.title === "Detail renamed" && i.id === detail));
});

test("comments stay on a renamed section, and a review stored before keeps every comment", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const first = "# Doc\n\n## Goals\n\nShip it.\n\n## Risks\n\nNone.\n";
  const sub = hoop.submit(parseMarkdown(first, {}));
  const goals = hoop.store.revision(sub.review_id).items[0]!.id;
  hoop.review(sub.review_id, { verdict: "comment", comments: [{ item: goals, line: 1, body: "When?" }] });
  hoop.receive(sub.review_id);
  // A review stored before this change has no renamed record, and opens with its comments in place.
  const stored = reviewView(hoop, sub.review_id);
  assert.deepEqual(stored.renamed, {});
  assert.equal(stored.feedback[0]!.comments[0]!.item, goals);
  hoop.submit({ ...parseMarkdown(first.replace("## Goals", "## Aims"), {}), review_id: sub.review_id });
  const view = reviewView(hoop, sub.review_id);
  const aims = view.doc.items.find((i: { title: string }) => i.title === "Aims")!;
  assert.equal(aims.id, goals);
  assert.deepEqual(view.renamed, { [goals]: "Goals" });
  assert.equal(view.feedback[0]!.comments[0]!.item, aims.id);
});

test("the diagram library's pinned hash matches the mermaid devDependency", () => {
  const sri = `sha384-${createHash("sha384").update(mermaidFile()).digest("base64")}`;
  assert.equal(MERMAID_SRI, sri, "update MERMAID_SRI in web/diagram.js with the new version");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(MERMAID_URL, `https://cdn.jsdelivr.net/npm/mermaid@${pkg.devDependencies.mermaid}/dist/mermaid.min.js`);
});

test("six heading levels show as five nested levels under the title, and a section collapses", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DEEP, {}));
    await page.goto(`${base}/r/${review_id}`);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.locator(".outline").waitFor();
    const depth = (title: string) =>
      page
        .locator(".outline li", { hasText: title })
        .last()
        .evaluate((li) => {
          let n = 0;
          for (let el: Element | null = li; el; el = el.parentElement?.closest("li") ?? null) n++;
          return n;
        });
    assert.deepEqual(await Promise.all(["Two", "Three", "Four", "Five", "Six", "Next"].map(depth)), [1, 2, 3, 4, 5, 1]);
    await page.getByRole("button", { name: "Collapse Two" }).click();
    assert.equal(await page.locator(".outline").getByText("Six").count(), 0);
    await page.getByRole("button", { name: "Expand Two" }).click();
    assert.equal(await page.locator(".outline").getByText("Six").count(), 1);
    // Each nested section sits inside its parent on the page, indented by its depth.
    const indent = (title: string) =>
      page
        .locator(".item", { hasText: title })
        .last()
        .evaluate((el) => getComputedStyle(el).marginLeft);
    assert.ok(Number.parseFloat(await indent("Six")) > Number.parseFloat(await indent("Two")));
  });
});

test("a table shows a header row and aligned columns, and a comment on a row stays on it", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const md = "# Plan\n\n## Costs\n\n| Item | Cost |\n|---|--:|\n| Servers | 40 |\n| People | 900 |\n";
    const { review_id } = hoop.submit(parseMarkdown(md, {}));
    const costs = hoop.store.revision(review_id).items[0]!.id;
    hoop.review(review_id, { verdict: "comment", comments: [{ item: costs, line: 4, body: "Per month?" }] });
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".md-table").waitFor();
    assert.deepEqual(await page.locator(".md-table th").allInnerTexts(), ["Item", "Cost"]);
    assert.equal(
      await page
        .locator(".md-table tr.tline")
        .nth(2)
        .locator("td")
        .nth(2)
        .evaluate((td) => getComputedStyle(td).textAlign),
      "right",
    );
    // The comment shows right under the People row.
    const after = page.locator(`.md-table tr.tline[data-sel-line="3"] + tr.tafter`);
    assert.match(await after.innerText(), /Per month\?/);
  });
});

test("diagrams draw in a sandbox from the pinned library, broken ones show their source, and pages without one load no library", {
  skip: BROWSER_SKIP,
}, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const requests: string[] = [];
    page.context().on("request", (r) => requests.push(r.url()));
    // Other hosts are blocked, so a diagram that reached one would fail; the library's address
    // answers from the devDependency.
    await page.context().route(
      (url) => !url.href.startsWith(base),
      (route) => route.abort(),
    );
    await serveMermaid(page.context());

    const plain = hoop.submit(parseMarkdown("# Plan\n\n## A\n\nNo diagram here.\n", {}));
    await page.goto(`${base}/r/${plain.review_id}`);
    await page.getByText("No diagram here.").waitFor();
    assert.equal(requests.filter((u) => /mermaid|diagram-frame/.test(u)).length, 0, "no diagram file loads");

    const hostile =
      "```mermaid\nflowchart LR\n  a[\"<img src=x onerror=parent.document.title='pwned'>\"] --> b\n  click a href \"javascript:parent.document.title='pwned'\"\n```";
    const md = `# Plan\n\n## Flow\n\n\`\`\`mermaid\nflowchart LR\n  a[Start] --> b[End]\n\`\`\`\n\n## Broken\n\n\`\`\`mermaid\nflowchart LR\n  a -->\n\`\`\`\n\n## Hostile\n\n${hostile}\n`;
    const { review_id } = hoop.submit(parseMarkdown(md, {}));
    await page.goto(`${base}/r/${review_id}`);
    // The placeholder shows first, then the drawing.
    await page.locator(".diagram-wait").first().waitFor();
    // Regression: the frames were once taken as soon as one diagram drew, and the broken diagram's
    // frame, which the page removes when the library refuses it, then failed with "Frame was
    // detached". Every diagram settles first, drawn or replaced by its source.
    await page.waitForFunction(() => [...document.querySelectorAll(".diagram")].every((d) => d.querySelector(".diagram-frame.drawn, .diagram-error")), null, {
      timeout: 20000,
    });
    // Regression: a frame drawn while hidden measured nothing, so a diagram showed 40 pixels tall.
    const flow = page.locator("#item-" + hoop.store.revision(review_id).items[0]!.id + " .diagram-frame.drawn");
    assert.ok((await flow.evaluate((f) => f.getBoundingClientRect().height)) > 60);
    const flowFrame = (await (await flow.elementHandle())!.contentFrame())!;
    assert.ok((await flowFrame.locator("svg").count()) > 0);
    assert.match(await page.locator(".diagram-error").first().innerText(), /can't be drawn/);
    assert.match(await page.locator(".diagram-src").first().innerText(), /a -->/);
    await page.waitForTimeout(1000);
    assert.notEqual(await page.title(), "pwned");
    const outside = requests.filter((u) => !u.startsWith(base) && !u.startsWith("about:") && !u.startsWith("data:"));
    assert.ok(outside.length > 0 && outside.every((u) => u === MERMAID_URL), `only the library's address: ${outside}`);
    // The frame can't reach the page's origin.
    const frameOrigin = await flowFrame.evaluate(() => {
      try {
        return String(parent.location.href);
      } catch {
        return "blocked";
      }
    });
    assert.equal(frameOrigin, "blocked");
  });
});

test("with the diagram library unreachable, a diagram shows its source and the page has no errors", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.context().route(
      (url) => !url.href.startsWith(base),
      (route) => route.abort(),
    );
    const md = "# Plan\n\n## Flow\n\n```mermaid\nflowchart LR\n  a[Start] --> b[End]\n```\n\n## Next\n\nShip it.\n";
    const { review_id } = hoop.submit(parseMarkdown(md, {}));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".diagram-error").waitFor({ timeout: 20000 });
    assert.match(await page.locator(".diagram-error").innerText(), /can't be drawn/);
    assert.match(await page.locator(".diagram-src").innerText(), /a\[Start\] --> b\[End\]/);
    assert.equal(await page.locator(".diagram-frame").count(), 0);
    assert.ok(await page.getByText("Ship it.").isVisible());
    assert.deepEqual(errors, []);
  });
});

test("a library that doesn't match the pinned hash doesn't run", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    await page.context().route(MERMAID_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/javascript",
        headers: { "access-control-allow-origin": "*" },
        // The real library plus one comment, which would draw if the hash weren't checked.
        body: Buffer.concat([mermaidFile(), Buffer.from("\n// changed\n")]),
      }),
    );
    const { review_id } = hoop.submit(parseMarkdown("# Plan\n\n## Flow\n\n```mermaid\nflowchart LR\n  a --> b\n```\n", {}));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".diagram-error").waitFor({ timeout: 20000 });
    assert.equal(await page.locator(".diagram-frame").count(), 0);
  });
});
