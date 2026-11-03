import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "../src/markdown.js";
import { BROWSER_SKIP, withBrowser } from "./helpers.js";

const DOC =
  "# Plan with `code` in it\n\n*Run with `npx hoop`*\n\nWhat this decides, with `plain code` in it.\n\n## Steps\n\n- Run `npm test` first\n\n| Command | Why |\n|---|---|\n| `npm ci` | installs |\n\n```\nnpm run build\n```\n";

const LOOK = ["backgroundColor", "paddingLeft", "paddingRight", "borderRadius", "fontFamily"] as const;

test("inline code on the build page looks as it does on the review page, in both themes (#387)", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: reviewId } = hoop.submit(parseMarkdown(DOC));
    const { review_id: buildId } = hoop.startBuild(DOC);
    const looks = (selector: string) =>
      page.$$eval(
        selector,
        (els, keys) =>
          els.map((el): Record<string, string> => {
            const s = getComputedStyle(el) as unknown as Record<string, string>;
            // Its size relative to the words around it, so code in a heading compares too.
            const em = (parseFloat(s.fontSize!) / parseFloat(getComputedStyle(el.parentElement!).fontSize)).toFixed(2);
            return { ...Object.fromEntries(keys.map((k) => [k, s[k]])), em };
          }),
        [...LOOK],
      );
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto(`${base}/r/${reviewId}`);
      await page.locator(".text code").first().waitFor();
      const [review] = await looks(".text code");
      const codeBg = await page.evaluate(() => {
        const probe = document.body.appendChild(document.createElement("i"));
        probe.style.background = "var(--code)";
        const bg = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return bg;
      });
      assert.equal(review!.backgroundColor, codeBg, `the review page's inline code is on --code (${colorScheme})`);

      await page.goto(`${base}/r/${buildId}`);
      await page.locator(".bpara code").waitFor();
      for (const where of [".bh code", ".bsub code", ".bpara code", ".blist code", ".md-table code"]) {
        const found = await looks(`.bbody ${where}`);
        assert.equal(found.length, 1, `${where} has its code span (${colorScheme})`);
        assert.deepEqual(found[0], review, `${where} matches the review page (${colorScheme})`);
      }
      // A code block keeps its own look: its code has no inline padding of its own.
      const [block] = await looks(".bcode code");
      assert.equal(block!.paddingLeft, "0px", `a code block's code is not padded as inline code (${colorScheme})`);
    }
  }),
);
