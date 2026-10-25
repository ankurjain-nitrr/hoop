import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "../src/markdown.js";
import { headerAlignment, reviewLayout } from "./every-page.js";
import { BROWSER_SKIP, withBrowser } from "./helpers.js";

test(
  "at 1440px a long review title stays on one line, with the controls at the header's right and a medium outline entry on one line",
  {
    skip: BROWSER_SKIP,
  },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const title = "Add quick questions, plan-to-work tracing and agent evals to hoop";
      const medium = "Linking a plan to its work and tests";
      const { review_id } = hoop.submit(parseMarkdown(`# ${title}\n\nWhy.\n\n## ${medium}\n\nShip it.\n`));
      hoop.review(review_id, { verdict: "comment", reviewer: "owner", comments: [{ item: "S-1", line: 1, body: "When?" }] });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${base}/r/${review_id}`);
      await page.locator("#hideComments").waitFor();
      const oneLine = (selector: string) =>
        page
          .locator(selector)
          .first()
          .evaluate((el) => el.getBoundingClientRect().height < parseFloat(getComputedStyle(el).lineHeight) * 1.5);
      assert.ok(await oneLine(".top h1"), "the title is one line tall");
      assert.ok(await oneLine(".outline .ol-t"), `"${medium}" is one line in the outline`);
      const row = (await page.locator(".title-row").boundingBox())!;
      const finish = (await page.locator("#finishBtn").boundingBox())!;
      assert.ok(Math.abs(row.x + row.width - (finish.x + finish.width)) < 2, "Finish your review ends at the header's right edge");
      assert.deepEqual([...(await headerAlignment(page)), ...(await reviewLayout(page))], []);
    }),
);

test("a code line uses the card's full width in the Proposal and Changes views, and prose keeps to its measure", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const prose =
      "A paragraph long enough to reach the reading measure on a wide screen, so its line stops well before the card's right edge does, as it should.";
    const fence = "```";
    const md = (cmd: string) => `# Deploy\n\nWhy.\n\n## Steps\n\n${prose}\n\n${fence}sh\n${cmd}\n${fence}\n`;
    const { review_id } = hoop.submit(parseMarkdown(md("deploy --env staging")));
    hoop.submit({ ...parseMarkdown(md("deploy --env production --region eu-west-1")), review_id });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".item .lines").first().waitFor();
    const widths = () =>
      page.evaluate(`[...document.querySelectorAll(".item .lines > .line")].map((l) => ({
        code: l.textContent.includes("deploy --env"),
        text: Math.round(l.querySelector(".text").getBoundingClientRect().width),
        column: Math.round(l.parentElement.getBoundingClientRect().width - l.querySelector(".gutter").getBoundingClientRect().width),
      }))`) as Promise<{ code: boolean; text: number; column: number }[]>;
    const proposal = await widths();
    assert.ok(proposal.some((l) => l.code));
    for (const l of proposal.filter((l) => l.code)) assert.ok(Math.abs(l.text - l.column) <= 1, `Proposal: a code line is ${l.text}px of ${l.column}px`);
    assert.ok(
      proposal.some((l) => !l.code && l.text < l.column - 100),
      "Proposal: prose keeps to its measure",
    );
    await page.locator("#tab-changes").click();
    await page.locator("#tab-changes[aria-selected=true]").waitFor();
    const changes = await widths();
    assert.ok(changes.some((l) => l.code));
    for (const l of changes.filter((l) => l.code)) assert.ok(Math.abs(l.text - l.column) <= 1, `Changes: a code line is ${l.text}px of ${l.column}px`);
  }),
);
