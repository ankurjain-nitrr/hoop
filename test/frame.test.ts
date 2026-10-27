import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clip, repoIdentity } from "../src/util.js";
import { reviewSummary } from "../src/web.js";
import { frame } from "../web/frame.js";
import { example, BROWSER_SKIP, withBrowser } from "./helpers.js";

test("repoIdentity names a folder with a stable opaque key, and gives nothing for a missing folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoop-ident-"));
  const a = repoIdentity(dir);
  assert.ok(a);
  assert.equal(a.name, dir.split("/").at(-1));
  // Regression: a symlink or another spelling of the same folder used to give a second key.
  symlinkSync(dir, join(tmpdir(), `hoop-ident-link-${process.pid}`));
  assert.deepEqual(repoIdentity(join(tmpdir(), `hoop-ident-link-${process.pid}`)), a, "a symlink to the folder gets the same key");
  unlinkSync(join(tmpdir(), `hoop-ident-link-${process.pid}`));
  if (existsSync(dir.toUpperCase())) assert.deepEqual(repoIdentity(dir.toUpperCase()), a, "another case of the same folder gets the same key");
  assert.notEqual(repoIdentity(tmpdir())?.key, a.key);
  assert.equal(repoIdentity(join(dir, "missing")), undefined);
  writeFileSync(join(dir, "file"), "");
  assert.equal(repoIdentity(join(dir, "file")), undefined, "a file is not a folder");
  assert.equal(repoIdentity(undefined), undefined);
});

test("the frame marks the current page, shows the version, and names no repository or person", () => {
  const html = frame("home", "<p>body</p>", { release: "1.2.3", login: "a<b>" });
  assert.match(html, /<a href="\/" aria-current="page">/);
  assert.match(frame("work", ""), /<a href="\/work" aria-current="page">/);
  assert.doesNotMatch(frame("", ""), /aria-current/);
  assert.ok(html.includes("v1.2.3") && html.endsWith("<p>body</p>"));
  assert.doesNotMatch(html, /a<b>|a&lt;b&gt;/, "no sign-in, so no login in the frame");
  // hoop is organized by Claude session: the frame shows no repository, whatever a caller passes.
  assert.doesNotMatch(html, /frame-repo|Repository/);
});

test("Home says what each review is about: its TL;DR as plain text, or else its first prose line", () => {
  const doc = (tldr: string, body?: string) => ({ ...example(), tldr, items: [{ id: "a", type: "section", title: "A", body }] });
  assert.equal(reviewSummary(doc("Ship **bold** `hoop_submit` via [the docs](https://x.example)", "Body")), "Ship bold hoop_submit via the docs");
  assert.equal(reviewSummary(doc(" ", "- a list item\n\nThe first *prose* line\n\nMore")), "The first prose line");
  assert.equal(reviewSummary(doc(" ", "- only a list")), "");
  // Regression (#202): an older hoop cut a long TL;DR at character 279, inside a word ("Ea…").
  const sentence = "Hoop checks whether agents actually follow hoop's rules.";
  const old = { ...doc(`${`${"word ".repeat(44)}${sentence} Each`.slice(-279)}…`), tldr_auto: true };
  assert.equal(old.tldr.length, 280);
  assert.ok(reviewSummary(old).endsWith(`${sentence} …`), reviewSummary(old));
  const long = reviewSummary(doc(" ", `${"Many words here. ".repeat(30)}`));
  assert.ok(long.length <= 280 && long.endsWith("here. …"), long);
  // An old cut of one long word, such as CJK text without spaces, has no word to drop and stays as it was.
  const word = { ...doc(`${"字".repeat(279)}…`), tldr_auto: true };
  assert.equal(reviewSummary(word), word.tldr);
});

test("clip cuts at a sentence end, else at a space, never inside a word", () => {
  assert.equal(clip("Short.", 20), "Short.");
  assert.equal(clip("One sentence here. Then a second one that runs on", 30), "One sentence here. …");
  assert.equal(clip("no sentence ends in this long line of words", 20), "no sentence ends…");
  assert.equal(clip("x".repeat(30), 10), `${"x".repeat(8)}…`);
  for (const n of [40, 41, 57, 99]) assert.ok(clip("A b c. ".repeat(40), n).length <= n);
  // An emoji is two UTF-16 units: a cut never leaves half of one.
  for (let n = 5; n < 14; n++) {
    const out = clip("😀".repeat(20), n);
    assert.ok(out.length <= n && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), `${n}: ${out}`);
  }
  // Chinese and Japanese full stops end a sentence with no space after them.
  assert.equal(clip("这是第一句话。这是第二句话，它很长很长很长很长", 12), "这是第一句话。…");
  assert.equal(clip("最初の文です！次の文はとても長いです", 12), "最初の文です！…");
  // A max too short for a word and an ellipsis gives what fits.
  assert.equal(clip("Hello", 2), "…");
  assert.equal(clip("Hello", 0), "");
  assert.equal(clip("Hello there", 3), "H…");
});

test("every page shows the same frame, and Home splits reviews into Pending and Completed", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id: a } = hoop.submit(example());
    hoop.submit({ ...example(), title: "Second review", tldr: "What the second review is about." });
    hoop.review(a, { verdict: "changes_requested", summary: "Split it." });
    const { review_id: done } = hoop.submit({ ...example(), slug: "done", title: "Done review" });
    hoop.review(done, { verdict: "approved" });
    // Revising an approved review supersedes it: the old one stays completed, the new one is pending.
    hoop.submit({ ...example(), slug: "done", title: "Done review, again" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const frameOf = () =>
      page.locator("header.frame").evaluate((el) => ({
        brand: el.querySelector(".brand")?.textContent,
        links: [...el.querySelectorAll("nav a")].map((x) => x.textContent),
        current: el.querySelector("[aria-current]")?.textContent ?? null,
      }));

    await page.goto(base);
    await page.locator(".list .group").first().waitFor();
    const list = await frameOf();
    // Home holds reviews from every repository, and neither the frame nor a row names one.
    assert.deepEqual(list, { brand: "hoop", links: ["Home", "Work"], current: "Home" });
    assert.equal(await page.locator(".list-head h1").textContent(), "Home");
    assert.match(await page.title(), /^(\(2\) )?Home · hoop$/, "the count of reviews awaiting the person may lead the title");
    const sections = await page.locator(".list .group").evaluateAll((els) =>
      els.map((el) => ({
        head: el.querySelector("h2")!.textContent!.replace(/\s+/g, " ").trim(),
        rows: [...el.querySelectorAll("a[href]")].map((x) => [x.querySelector(".t")!.textContent, x.querySelector(".badge")?.textContent ?? ""]),
      })),
    );
    // A row shows its status only where it differs from its section's usual one (#201).
    assert.deepEqual(sections, [
      {
        head: "Pending 3",
        rows: [
          ["Done review, again", ""],
          ["Order export: requirements", "Changes requested"],
          ["Second review", ""],
        ],
      },
      { head: "Completed 1", rows: [["Done review", ""]] },
    ]);
    const summary = page.locator(".list a", { hasText: "Second review" }).locator(".s");
    assert.equal(await summary.textContent(), "What the second review is about.");
    assert.equal(await summary.getAttribute("title"), "What the second review is about.");
    assert.equal(await summary.evaluate((el) => getComputedStyle(el).webkitLineClamp), "2", "the TL;DR keeps to two lines");
    const meta = await page.locator(".list .m").first().textContent();
    assert.equal(meta!.startsWith("updated "), true, "Home names no repository or project");
    assert.equal(await page.locator(".list-head select, #list-project").count(), 0, "Home has no project filter");
    assert.doesNotMatch(meta!, /\d:\d\d:\d\d/, "dates show without seconds");

    await page.goto(`${base}/r/${a}`);
    await page.locator(".top h1").waitFor();
    assert.deepEqual(await frameOf(), { ...list, current: null }, "the review page's frame names no repository either");

    // Regression: a stalled /api/info used to keep every page on "Loading…".
    await page.route("**/api/info", () => {
      /* never answers */
    });
    await page.goto(base);
    await page.locator(".list .group").first().waitFor();
    await page.unroute("**/api/info");

    // When /api/info fails, the page still loads.
    await page.route("**/api/info", (r) => r.fulfill({ status: 500, body: "{}" }));
    await page.goto(base);
    await page.locator(".list .group").first().waitFor();
    assert.equal((await frameOf()).current, "Home");
    assert.deepEqual(errors, []);
  });
});
