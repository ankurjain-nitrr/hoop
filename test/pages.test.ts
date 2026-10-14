import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { example, tempHome, BROWSER_SKIP, withBrowser } from "./helpers.js";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

const TRACKER = `# Tracker

Work items.

| ID | Parent | Type | Title | Status | Phase |
|---|---|---|---|---|---|
| CR-1 | | epic | An epic. | in progress | build |
| T-1 | CR-1 | task | Write the \`parser\`. | todo | |
`;

/** Serious and critical axe findings on the page, as "rule: target" strings. */
async function axeProblems(page: Page) {
  await page.addScriptTag({ path: AXE });
  const found = await page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: () => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe.run();
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
  });
  return found;
}

/** Tabs through the page and returns, for each stop, its label and whether it shows a focus outline. */
async function tabStops(page: Page, max: number) {
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const stops: { label: string; outlined: boolean }[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return { label: `${el.tagName.toLowerCase()} ${(el.getAttribute("aria-label") || el.textContent || el.id || "").trim().slice(0, 30)}`, outlined: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 };
    });
    if (!stop) break;
    stops.push(stop);
  }
  return stops;
}

/**
 * How many Tab stops the page should have: every visible link, button, field and select. A radio
 * group is one stop, because the arrow keys move inside it.
 */
const focusable = (page: Page) => page.evaluate(() => {
  const radios = new Set<string>();
  return [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")]
    .filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
    .filter((el) => {
      const r = el as HTMLInputElement;
      if (r.type !== "radio") return true;
      if (radios.has(r.name)) return false;
      radios.add(r.name);
      return true;
    }).length;
});

test("NFR-1 to NFR-3: every page works in both themes, at phone width, from the keyboard, offline and with no serious accessibility problems", { skip: BROWSER_SKIP }, async () => {
  const dir = tempHome();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "TRACKER.md"), TRACKER);
  process.env.HOOP_REPO_DIR = dir;
  await withBrowser(async ({ hoop, base, browser }) => {
    const { review_id } = hoop.submit(example());
    const pages = [
      { name: "list", path: "/", ready: ".list .group" },
      { name: "review", path: `/r/${review_id}`, ready: ".top h1" },
      { name: "tracker", path: "/tracker", ready: "tr.trow" },
    ];
    const problems: string[] = [];
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme, viewport: { width: 1200, height: 900 } });
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
      for (const p of pages) {
        const where = `${p.name} (${colorScheme})`;
        await page.setViewportSize({ width: 1200, height: 900 });
        await page.goto(base + p.path);
        await page.locator(p.ready).first().waitFor();
        await page.locator("header.frame").waitFor();
        for (const a of await axeProblems(page)) problems.push(`${where} axe ${a}`);

        // NFR-2: Tab reaches every control, and each one shows a focus outline.
        const count = await focusable(page);
        const stops = await tabStops(page, Math.min(count, 60));
        if (stops.length < Math.min(count, 60)) problems.push(`${where}: Tab reached ${stops.length} of ${count} controls`);
        for (const s of stops.filter((x) => !x.outlined)) problems.push(`${where}: no focus outline on ${s.label}`);

        // NFR-1: at 400 pixels the page doesn't scroll sideways, and the frame stays visible.
        await page.setViewportSize({ width: 400, height: 800 });
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (wide > 0) problems.push(`${where}: scrolls ${wide}px sideways at 400px`);
        if (!(await page.locator("header.frame .brand").isVisible())) problems.push(`${where}: frame hidden at 400px`);
        if (p.name === "review" && !(await page.locator("#finishBtn").isVisible())) problems.push(`${where}: finish button hidden at 400px`);
      }
      assert.deepEqual(outside, [], "no page asks another host for anything");
      assert.deepEqual(errors, []);
      await context.close();
    }
    assert.deepEqual(problems, []);
  });
});
