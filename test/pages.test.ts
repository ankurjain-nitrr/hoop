import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Page } from "playwright-core";
import { example, tempHome, BROWSER_SKIP, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { trackPr } from "../src/prs.js";
import { readFileSync } from "node:fs";

// Home lists pull requests in each state, from gh's own JSON.
const GH = JSON.parse(readFileSync(new URL("./fixtures/gh-pr-view.json", import.meta.url), "utf8"));
const PRS: Record<string, unknown> = {
  "https://github.com/acme/shop/pull/1": GH.ready,
  "https://github.com/acme/shop/pull/2": { ...GH.failing, mergeable: "CONFLICTING" },
  "https://github.com/acme/shop/pull/3": GH.review_requested,
  "https://github.com/acme/shop/pull/4": GH.merged,
  "https://github.com/acme/shop/pull/5": undefined,
};
const gh = async (args: string[]) => {
  if (args[0] === "api") return "octocat\n";
  const v = PRS[args[2]!];
  if (!v) throw new Error("gh: not signed in");
  return JSON.stringify(v);
};

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/** Serious and critical axe findings on the page, as "rule: target" strings. */
async function axeProblems(page: Page) {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const r = await (
      window as unknown as { axe: { run: () => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }
    ).axe.run();
    return r.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map(
        (v) =>
          `${v.id}: ${v.nodes
            .map((n) => n.target.join(" "))
            .slice(0, 3)
            .join(", ")}`,
      );
  });
}

/**
 * Marks every control that Tab must reach, and returns how many there are: every visible link,
 * button, field and select. A radio group is one stop, because the arrow keys move inside it.
 */
const markFocusable = (page: Page) =>
  page.evaluate(() => {
    const radios = new Set<string>();
    let n = 0;
    for (const el of document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")) {
      el.removeAttribute("data-tabk");
      if (el.tabIndex < 0 || (el as HTMLButtonElement).disabled || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
      // A closed disclosure keeps its contents out of the Tab order, as it should.
      if (el.closest("details:not([open])") && !el.closest("summary")) continue;
      const r = el as HTMLInputElement;
      if (r.type === "radio") {
        if (radios.has(r.name)) continue;
        radios.add(r.name);
        for (const g of document.querySelectorAll<HTMLElement>(`input[type=radio][name="${CSS.escape(r.name)}"]`)) g.dataset.tabk = String(n);
      }
      el.dataset.tabk = String(n++);
    }
    return n;
  });

/**
 * Tabs until focus wraps around, and returns the marked controls it reached and any stop without a
 * focus outline. It fails when `max` stops pass without a wrap, so a long page can't hide a gap.
 */
async function tabThrough(page: Page, max = 200) {
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const reached = new Set<string>();
  const unlit: string[] = [];
  let first: string | null = null;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return {
        key: el.dataset.tabk ?? `unmarked ${el.tagName}`,
        label: `${el.tagName.toLowerCase()} ${(el.getAttribute("aria-label") || el.textContent || el.id || "").trim().slice(0, 30)}`,
        outlined: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0,
      };
    });
    if (!stop || stop.key === first) return { reached, unlit, wrapped: true };
    first ??= stop.key;
    reached.add(stop.key);
    if (!stop.outlined) unlit.push(stop.label);
  }
  return { reached, unlit, wrapped: false };
}

test("every page works in both themes, at phone width, from the keyboard, offline and with no serious accessibility problems", {
  skip: BROWSER_SKIP,
}, async () => {
  process.env.HOOP_REPO_DIR = tempHome();
  const home = tempHome();
  for (const url of Object.keys(PRS)) trackPr(home, url, "sess-pages");
  await withBrowser(
    async ({ hoop, base, browser }) => {
      const { review_id } = hoop.submit(example());
      hoop.submit({ ...example(), review_id, items: example().items.slice(0, 3) });
      // A resolved conversation is on screen as a collapsed row.
      const fb = hoop.review(review_id, {
        verdict: "comment",
        reviewer: "agent",
        comments: [{ item: example().items[0].id, line: 1, body: "A resolved point." }],
      });
      hoop.review(review_id, { verdict: "comment", reviewer: "owner", comments: [], resolved_threads: [fb.comments[0]!.thread!] });
      // A document with nested sections, a renamed section, a table and a diagram.
      const docMd = (h: string) =>
        `# Plan\n\nIntro.\n\n## ${h}\n\nA.\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\nDeep text.\n\n## Costs\n\n| Item | Cost |\n|---|--:|\n| Servers | 40 |\n\n## Flow\n\n\`\`\`mermaid\nflowchart LR\n  a[Start] --> b[End]\n\`\`\`\n`;
      const docReview = hoop.submit(parseMarkdown(docMd("Goals"), {})).review_id;
      hoop.submit({ ...parseMarkdown(docMd("Aims"), {}), review_id: docReview });
      // Each page, and the states a reviewer opens on it, are checked with axe and at phone width.
      const pages: { name: string; path: string; ready: string; states: Record<string, (p: Page) => Promise<void>> }[] = [
        { name: "list", path: "/", ready: ".list a.pr .badge", states: {} },
        {
          name: "review",
          path: `/r/${review_id}`,
          ready: ".top h1",
          states: {
            // The page checks also run with every comment hidden.
            "comments hidden": async (p) => {
              await p.locator("#hideComments").click();
              await p.locator("#app.comments-hidden").waitFor();
            },
            "comment box": async (p) => {
              await p.locator(".add-btn").nth(2).click();
              await p.locator("#cbody").waitFor();
            },
            "finish panel": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator("#finishBtn").click();
              await p.locator("#finishPop").waitFor();
            },
            "finish panel, approve": async (p) => {
              await p.locator("#v-approve").check();
              await p.locator("#signinPanel:not([hidden])").waitFor();
            },
            history: async (p) => {
              await p.keyboard.press("Escape");
              await p.locator(".trail summary").click();
            },
            "changes tab": async (p) => {
              await p.locator("#tab-changes").click();
              await p.locator("#tab-changes[aria-selected=true]").waitFor();
            },
          },
        },
        {
          name: "document",
          path: `/r/${docReview}`,
          ready: ".diagram-frame.drawn",
          states: {
            "outline collapsed": async (p) => {
              await p.setViewportSize({ width: 1400, height: 900 });
              await p.getByRole("button", { name: "Collapse Aims" }).click();
            },
            "edit in place": async (p) => {
              await p.locator(".edit-btn").first().click();
              await p.locator(".composer.in-place #csugg").waitFor();
            },
          },
        },
      ];
      const problems: string[] = [];
      const fonts = new Set<string>();
      for (const colorScheme of ["light", "dark"] as const) {
        const context = await browser.newContext({ colorScheme, viewport: { width: 1400, height: 900 } });
        const outside: string[] = [];
        // Requests to any other host are blocked, and the page must still render fully.
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.hostname === "127.0.0.1") return route.continue();
          outside.push(url.href);
          return route.abort();
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const phone = async (where: string, name: string) => {
          await page.setViewportSize({ width: 400, height: 800 });
          const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (wide > 0) problems.push(`${where}: scrolls ${wide}px sideways at 400px`);
          if (!(await page.locator("header.frame .brand").isVisible())) problems.push(`${where}: frame hidden at 400px`);
          if (name === "review" && !(await page.locator("#finishBtn").isVisible())) problems.push(`${where}: finish button hidden at 400px`);
          await page.setViewportSize({ width: 1400, height: 900 });
        };
        for (const p of pages) {
          const where = `${p.name} (${colorScheme})`;
          await page.goto(base + p.path);
          await page.locator(p.ready).first().waitFor();
          await page.locator("header.frame").waitFor();

          // One type scale and one content width on every page.
          const look = await page.evaluate(() => {
            const body = getComputedStyle(document.body);
            const widths = [...document.querySelectorAll<HTMLElement>("header.frame, .top, .list")].map((el) => el.getBoundingClientRect().width);
            return { font: `${body.fontFamily} ${body.fontSize}`, widest: Math.max(...widths) };
          });
          fonts.add(look.font);
          if (look.widest > 1180) problems.push(`${where}: content is ${look.widest}px wide, over 1180px`);

          for (const a of await axeProblems(page)) problems.push(`${where} axe ${a}`);
          // Tab reaches every control, and each one shows a focus outline.
          const count = await markFocusable(page);
          const tab = await tabThrough(page);
          if (!tab.wrapped) problems.push(`${where}: Tab didn't wrap within 200 stops`);
          const missed = Array.from({ length: count }, (_, i) => String(i)).filter((k) => !tab.reached.has(k));
          if (missed.length) problems.push(`${where}: Tab missed ${missed.length} of ${count} controls`);
          for (const label of tab.unlit) problems.push(`${where}: no focus outline on ${label}`);
          await phone(where, p.name);

          for (const [state, open] of Object.entries(p.states)) {
            await open(page);
            for (const a of await axeProblems(page)) problems.push(`${where}, ${state}: axe ${a}`);
            await phone(`${where}, ${state}`, p.name);
          }
        }
        assert.deepEqual(outside, [], "no page asks another host for anything");
        assert.deepEqual(errors, []);
        await context.close();
      }
      assert.equal(fonts.size, 1, `every page uses one body font and size: ${[...fonts].join("; ")}`);
      assert.deepEqual(problems, []);
    },
    new Hoop(new Store(home)),
    { gh },
  );
});
