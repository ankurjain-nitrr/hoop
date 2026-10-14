import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { example, tempHome, BROWSER_SKIP, withBrowser } from "./helpers.js";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

// Every item type, so axe sees every badge and chip the tracker can show.
const TRACKER = `# Tracker

Work items.

| ID | Parent | Type | Title | Status | Phase |
|---|---|---|---|---|---|
| CR-1 | | epic | An epic. | in progress | build |
| ST-1 | CR-1 | story | A story. | in review | |
| T-1 | ST-1 | task | Write the \`parser\`. | todo | |
| S-1 | T-1 | sub-task | A step. | done | |
| B-1 | CR-1 | bug | A bug. | blocked | |
| T-2 | ST-1 | task | A dropped task. | dropped | |
`;

/** Serious and critical axe findings on the page, as "rule: target" strings. */
async function axeProblems(page: Page) {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: () => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe.run();
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
  });
}

/**
 * Marks every control that Tab must reach, and returns how many there are: every visible link,
 * button, field and select. A radio group is one stop, because the arrow keys move inside it.
 */
const markFocusable = (page: Page) => page.evaluate(() => {
  const radios = new Set<string>();
  let n = 0;
  for (const el of document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")) {
    el.removeAttribute("data-tabk");
    if (el.tabIndex < 0 || (el as HTMLButtonElement).disabled || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
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
      return { key: el.dataset.tabk ?? `unmarked ${el.tagName}`, label: `${el.tagName.toLowerCase()} ${(el.getAttribute("aria-label") || el.textContent || el.id || "").trim().slice(0, 30)}`,
        outlined: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 };
    });
    if (!stop || stop.key === first) return { reached, unlit, wrapped: true };
    first ??= stop.key;
    reached.add(stop.key);
    if (!stop.outlined) unlit.push(stop.label);
  }
  return { reached, unlit, wrapped: false };
}

test("NFR-1 to NFR-3: every page works in both themes, at phone width, from the keyboard, offline and with no serious accessibility problems", { skip: BROWSER_SKIP }, async () => {
  const dir = tempHome();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "TRACKER.md"), TRACKER);
  process.env.HOOP_REPO_DIR = dir;
  await withBrowser(async ({ hoop, base, browser }) => {
    const { review_id } = hoop.submit(example());
    hoop.submit({ ...example(), review_id, items: example().items.slice(0, 3) });
    // Each page, and the states a reviewer opens on it, are checked with axe and at phone width.
    const pages: { name: string; path: string; ready: string; states: Record<string, (p: Page) => Promise<void>> }[] = [
      { name: "list", path: "/", ready: ".list .group", states: {} },
      { name: "review", path: `/r/${review_id}`, ready: ".top h1", states: {
        "comment box": async (p) => { await p.locator(".add-btn").nth(2).click(); await p.locator("#cbody").waitFor(); },
        "finish panel": async (p) => { await p.keyboard.press("Escape"); await p.locator("#finishBtn").click(); await p.locator("#finishPop").waitFor(); },
        "changes tab": async (p) => { await p.locator("#tab-changes").click(); await p.locator("#tab-changes[aria-selected=true]").waitFor(); },
      } },
      { name: "tracker", path: "/tracker", ready: "tr.trow", states: {
        "hovered row": async (p) => { await p.locator("tr.trow").first().hover(); },
      } },
    ];
    const problems: string[] = [];
    const fonts = new Set<string>();
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme, viewport: { width: 1400, height: 900 } });
      const outside: string[] = [];
      // NFR-3: requests to any other host are blocked, and the page must still render fully.
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

        // NFR-1: one type scale and one content width on every page.
        const look = await page.evaluate(() => {
          const body = getComputedStyle(document.body);
          const widths = [...document.querySelectorAll<HTMLElement>("header.frame, .top, .list, .tracker-page")].map((el) => el.getBoundingClientRect().width);
          return { font: `${body.fontFamily} ${body.fontSize}`, widest: Math.max(...widths) };
        });
        fonts.add(look.font);
        if (look.widest > 1180) problems.push(`${where}: content is ${look.widest}px wide, over 1180px`);

        for (const a of await axeProblems(page)) problems.push(`${where} axe ${a}`);
        // NFR-2: Tab reaches every control, and each one shows a focus outline.
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
  });
});
