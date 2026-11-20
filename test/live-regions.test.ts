import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { BROWSER_SKIP, example, webSources, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";

// docs/DESIGN-LANGUAGE.md, Live region: one hidden status region per page, written through
// `announce()` (web/frame.js), for a change with no visible message. A toast announces itself, and an
// error line is an alert. No other element is a live region.

/** The roles that make a live region. */
const LIVE_ROLES = new Set(["status", "alert", "log", "marquee", "timer"]);

/** The classes an error line has (Errors): one of them, as a whole class. */
const ERROR_LINE = new Set(["error", "berr", "steer-error", "rename-error", "warn", "empty"]);

/**
 * How many live regions each file may make, by role. An alert must also sit on an error line's
 * element. Anything else, or one more, fails.
 */
const KNOWN: Record<string, Record<string, number>> = {
  // announce()'s region.
  "web/frame.js": { status: 1 },
  // The page that couldn't start says why, as an error.
  "web/index.html": { alert: 1 },
  // The toast, which says something succeeded out of view, and error lines.
  "web/review.js": { status: 1, alert: 4 },
  // Its error lines, Open a sample review's on Home among them (#417).
  "web/app.js": { alert: 6 },
  "web/ask.js": { alert: 1 },
  "web/build.js": { alert: 5 },
  "web/build-drafts.js": { alert: 1 },
  "web/build-history.js": { alert: 1 },
  "web/context.js": { alert: 2 },
  // A permission prompt's error line, under Allow once and Deny or its reason box.
  "web/permissions.js": { alert: 1 },
  "web/revise.js": { alert: 1 },
  "web/work.js": { alert: 4 },
};

/** A source with its comments blanked, keeping every offset, so a role named in a comment doesn't count. */
const uncommented = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|(?<![:"'`\\])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/**
 * Every live region the pages' source makes, in any form: a role written as an attribute (quoted or
 * not), passed to setAttribute or Object.assign, or set as a property; aria-live or ariaLive; and the
 * output element. A role whose value isn't written out (a variable, a template) counts as unknown.
 */
function liveRegions(sources = webSources()) {
  const found: { file: string; line: number; role: string; classes: string[] }[] = [];
  const odd: string[] = [];
  for (const { name, text } of sources) {
    const src = uncommented(text);
    const lineOf = (i: number) => src.slice(0, i).split("\n").length;
    for (const m of src.matchAll(/aria-?live|<output\b/gi)) odd.push(`${name}:${lineOf(m.index)}: ${m[0]}`);
    for (const m of src.matchAll(/\brole\b/g)) {
      const at = m.index;
      // A class named "role" is a style, not a role.
      if (/class=\\?["'][^"'<>]*$/.test(src.slice(Math.max(0, at - 120), at))) continue;
      const after = src.slice(at + 4, at + 60);
      // Reading a property named role (e.role) sets nothing.
      if (src[at - 1] === "." && !/^\s*=(?!=)/.test(after)) continue;
      const value = after.match(/^(?:\s*=\s*\\?["'`]?|["'`]?\s*,\s*["'`]|\s*:\s*["'`])([a-z]+)\b/i);
      if (!value) {
        odd.push(`${name}:${lineOf(at)}: role${after.slice(0, 20)}`);
        continue;
      }
      const role = value[1]!.toLowerCase();
      if (!LIVE_ROLES.has(role)) continue;
      // A class list may carry a template part ("berr${cls}"): its fixed classes count.
      const tag = src.slice(src.lastIndexOf("<", at), at);
      const classes = tag.match(/class=\\?["']([^"']*)/)?.[1]?.split(/[\s$]+/) ?? [];
      found.push({ file: name, line: lineOf(at), role, classes });
    }
  }
  return { found, odd };
}

test("no page makes a live region of its own: the one status region is announce()'s, besides the toast and error lines", () => {
  const { found, odd } = liveRegions();
  assert.deepEqual(odd, [], "a role written so that the scan can't read it, or aria-live, or an output element");
  const counts: Record<string, Record<string, number>> = {};
  for (const f of found) {
    counts[f.file] ??= {};
    counts[f.file]![f.role] = (counts[f.file]![f.role] ?? 0) + 1;
  }
  assert.deepEqual(counts, KNOWN, "the live regions each file makes");
  const notErrors = found.filter((f) => f.role === "alert" && f.file !== "web/index.html" && !f.classes.some((c) => ERROR_LINE.has(c)));
  assert.deepEqual(
    notErrors.map((f) => `${f.file}:${f.line}: class="${f.classes.join(" ")}"`),
    [],
    "every alert is an error line",
  );
});

test("the scan finds a live region however it is written, and skips a class or a property named role", () => {
  const scan = (text: string) => {
    const { found, odd } = liveRegions([{ name: "probe.js", text }]);
    return found.length + odd.length;
  };
  // Each probe is one live region, in a form the first scan missed.
  for (const probe of [
    "<h2 role=status>",
    '`<p class="x" data-a="${a > b}" role="status">`',
    "el.setAttribute('role', kind);",
    "el.setAttribute(`role`, `status`);",
    "el.role = 'status';",
    "Object.assign(el, { role: 'log' });",
    "el.ariaLive = 'polite';",
    "<output>",
  ])
    assert.equal(scan(probe), 1, probe);
  for (const fine of ['<span class="role">reply</span>', "${esc(e.role)}", '<div role="tablist">', "// role=status in a comment"])
    assert.equal(scan(fine), 0, fine);
  // An alert on an element that isn't an error line's is told apart by its class.
  const [diagram] = liveRegions([{ name: "probe.js", text: '<p class="diagram-error" role="alert">' }]).found;
  assert.ok(!diagram!.classes.some((c) => ERROR_LINE.has(c)), "diagram-error isn't an error line's class");
});

/** What the page's one live region said, in order, from a recorder the page starts with. */
const RECORD = () => {
  const said: string[] = [];
  Object.assign(window, { said });
  new MutationObserver(() => {
    const live = document.getElementById("page-live");
    const text = live?.textContent ?? "";
    if (text) said.push(text);
  }).observe(document, { subtree: true, childList: true, characterData: true });
};
const saidSoFar = (page: Page) => page.evaluate(() => (window as unknown as { said: string[] }).said);

/** The live regions on the page now, by ID or class: only announce()'s should be there. */
const regionsOn = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="status"], [role="alert"], [role="log"], [aria-live], output')]
      .filter((el) => el.getClientRects().length || el.id === "page-live")
      .map((el) => el.id || el.className),
  );

test("the review, quick question and build pages each have one live region, and what changes is said in it", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown("# Plan\n\nWhy we move.\n\n## Steps\n\n- Copy.\n\n- Check.\n"));
    const ask = hoop.ask({
      questions: [
        { question: "Keep it?", options: [{ label: "Keep", recommended: true }, { label: "Remove" }] },
        { question: "Which format?", options: [{ label: "CSV", recommended: true }, { label: "JSON" }] },
      ],
    }).review_id;
    const build = hoop.startBuild("# Cost\n\n## Summary\n\nMost of it is compute.\n").review_id;
    await page.addInitScript(RECORD);
    await page.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 200, HOOP_BUILD_MS: 200 }));
    const said = (text: string) =>
      page
        .waitForFunction((t) => (window as unknown as { said: string[] }).said.includes(t), text, { timeout: 5000 })
        .then(
          () => true,
          () => false,
        );

    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".top h1").waitFor();
    await page.getByRole("button", { name: 'Comment on "Steps" line 1' }).click();
    await page.locator("#cpart").fill("Copy");
    assert.ok(await said("Found in this line."), "the part hint is said");
    await page.locator("#cbody").fill("Which bucket?");
    await page.locator("#addComment").click();
    assert.ok(await said("Now Request changes: 1 new comment"), "the verdict change is said");
    hoop.receive(review_id);
    hoop.submit({ ...parseMarkdown("# Plan\n\nWhy we move.\n\n## Steps\n\n- Copy all.\n"), review_id });
    assert.ok(await said("Revision 2 is ready. Show it is in the header."), "the new revision is said");
    assert.deepEqual(await regionsOn(page), ["page-live"], "the review page");

    // A quick question: each answer saved is said, the second as well as the first, though the words are the same.
    await page.goto(`${base}/r/${ask}`);
    await page.locator(".ask-opt").first().waitFor();
    await page.locator('[data-q="Q1"][data-choice="A"]').click();
    await page.locator(".ask-status", { hasText: /\S/ }).waitFor();
    const message = (await page.locator(".ask-status").textContent()) ?? "";
    await page.locator('[data-q="Q2"][data-choice="A"]').click();
    await page.waitForFunction((m) => (window as unknown as { said: string[] }).said.filter((s) => s === m).length >= 2, message, { timeout: 5000 });
    assert.deepEqual(await regionsOn(page), ["page-live"], "the quick question page");

    // The build page: a request Claude takes is said.
    await page.goto(`${base}/r/${build}`);
    await page.locator(".bblock").first().waitFor();
    const summary = hoop.builds.read(build).blocks.find((x) => x.text === "## Summary")!.id;
    hoop.buildChange(build, { op: "generate", block: summary });
    assert.ok(await said("Heading 1 “Summary”: Queued: Claude writes everything under this heading."), "a queued request is said");
    hoop.takeRequests(build);
    assert.ok(await said("Heading 1 “Summary”: Claude is writing everything under this heading…"), "a taken request is said");
    assert.deepEqual(await regionsOn(page), ["page-live"], "the build page");
  }),
);

test("regression: an ended session's line, polled again and again with a review unread, is said once at most", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(example());
    hoop.review(review_id, { verdict: "comment", reviewer: "ana", comments: [{ item: example().items[0].id, line: 1, body: "A point." }] });
    await page.addInitScript(RECORD);
    await page.addInitScript(() => Object.assign(window, { HOOP_RECEIPTS_MS: 100, HOOP_AGENT_MS: 100 }));
    await page.goto(`${base}/r/${review_id}`);
    const line = page.locator(".agent-state");
    await line.waitFor();
    assert.match((await line.textContent()) ?? "", /Claude's session has ended/);
    // Ten polls of the receipts and the agent's state.
    await page.waitForTimeout(1200);
    const told = (await saidSoFar(page)).filter((s) => s.startsWith("Claude's session"));
    assert.ok(told.length <= 1, `the unchanged line is said ${told.length} times`);
  }),
);

test(
  "a quick question Claude withdraws, and a review replaced, while the page is open, are said once; a page that loads with them says nothing",
  {
    skip: BROWSER_SKIP,
  },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const KEEP = { question: "Keep it?", options: [{ label: "Keep", recommended: true }, { label: "Remove" }] };
      const ask = hoop.ask({ questions: [KEEP] }).review_id;
      const { review_id } = hoop.submit(parseMarkdown("# Plan\n\nWhy we move.\n"));
      const newer = hoop.submit(parseMarkdown("# Plan, again\n\nWhy we move.\n")).review_id;
      await page.addInitScript(RECORD);
      await page.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 100 }));
      const count = async (text: string) => (await saidSoFar(page)).filter((s) => s === text).length;

      await page.goto(`${base}/r/${ask}`);
      await page.locator(".ask-opt").first().waitFor();
      hoop.withdraw(ask, "Found it in the logs");
      const withdrew = "Claude withdrew this question: Found it in the logs";
      await page.locator(".ask .decided", { hasText: withdrew }).waitFor();
      await page.waitForTimeout(600);
      assert.equal(await count(withdrew), 1, "the withdrawal is said once");
      await page.reload();
      await page.locator(".ask .decided").waitFor();
      await page.waitForTimeout(600);
      assert.equal(await count(withdrew), 0, "a page that loads withdrawn says nothing");

      await page.goto(`${base}/r/${review_id}`);
      await page.locator(".top h1").waitFor();
      hoop.store.update(review_id, { superseded_by: newer });
      const replaced = `A newer review replaced this one: ${newer}.`;
      await page.locator(".decided", { hasText: "A newer review replaced this one" }).waitFor();
      await page.waitForTimeout(600);
      assert.equal(await count(replaced), 1, "the replacement is said once");
      await page.reload();
      await page.locator(".decided").waitFor();
      await page.waitForTimeout(600);
      assert.equal(await count(replaced), 0, "a page that loads replaced says nothing");
    }),
);

test("announce() says the same words again: the region clears, then holds them", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ base, page }) => {
    await page.goto(base);
    await page.locator("header.frame").waitFor();
    const steps = await page.evaluate(`(async () => {
      const { announce } = await import("/frame.js");
      announce("Saved.");
      await new Promise((r) => setTimeout(r, 200));
      const live = document.getElementById("page-live");
      const seen = [];
      new MutationObserver(() => seen.push(live.textContent)).observe(live, { childList: true, characterData: true, subtree: true });
      announce("Saved.");
      await new Promise((r) => setTimeout(r, 200));
      return seen;
    })()`);
    assert.deepEqual(steps, ["", "Saved."]);
  }),
);
