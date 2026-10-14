import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoIdentity } from "../src/util.js";
import { frame } from "../web/frame.js";
import { example, BROWSER_SKIP, withBrowser } from "./helpers.js";

test("FR-1: repoIdentity names a folder with a stable opaque key, and gives nothing for a missing folder", () => {
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

test("FR-1: the frame marks the current page and escapes the repository name", () => {
  const html = frame("tracker", "<p>body</p>", { name: "a<b>", key: "k" });
  assert.match(html, /<a href="\/tracker" aria-current="page">/);
  assert.doesNotMatch(html, /<a href="\/" aria-current/);
  assert.ok(html.includes("a&lt;b&gt;") && html.endsWith("<p>body</p>"));
  assert.doesNotMatch(frame("reviews", ""), /frame-repo/, "no repository, no name");
});

test("FR-1, FR-3: every page shows the same frame, and the list groups reviews by status", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id: a } = hoop.submit(example());
    hoop.submit({ ...example(), title: "Second review" });
    hoop.review(a, { verdict: "changes_requested" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const name = (await (await fetch(`${base}/api/info`)).json()).repo.name;
    const frameOf = () => page.locator("header.frame").evaluate((el) => ({
      brand: el.querySelector(".brand")?.textContent, links: [...el.querySelectorAll("nav a")].map((x) => x.textContent),
      repo: el.querySelector(".frame-repo")?.textContent ?? null, current: el.querySelector("[aria-current]")?.textContent ?? null,
    }));

    await page.goto(base);
    await page.locator(".list .group").first().waitFor();
    const list = await frameOf();
    assert.deepEqual(list, { brand: "hoop", links: ["Reviews", "Tracker"], repo: name, current: "Reviews" });
    const groups = await page.locator(".list .group h2").allTextContents();
    assert.deepEqual(groups.map((g) => g.replace(/\s+/g, " ").trim()), ["Changes requested 1", "Awaiting review 1"]);
    assert.equal(await page.locator('.list a[href="/tracker"]').count(), 0, "no row links to the tracker");
    const meta = await page.locator(".list .m").first().textContent();
    assert.match(meta!, /^Local · updated /);
    assert.doesNotMatch(meta!, /\d:\d\d:\d\d/, "dates show without seconds");

    await page.goto(`${base}/r/${a}`);
    await page.locator(".top h1").waitFor();
    assert.deepEqual(await frameOf(), { ...list, current: null });

    await page.goto(`${base}/tracker`);
    await page.locator(".tracker-page").waitFor();
    assert.deepEqual(await frameOf(), { ...list, current: "Tracker" });

    // Regression: a stalled /api/info used to keep every page on "Loading…".
    await page.route("**/api/info", () => { /* never answers */ });
    await page.goto(base);
    await page.locator(".list .group").first().waitFor({ timeout: 5000 });
    assert.equal((await frameOf()).repo, null);
    await page.unroute("**/api/info");

    // When /api/info fails, the frame shows no repository name and the page still loads.
    await page.route("**/api/info", (r) => r.fulfill({ status: 500, body: "{}" }));
    await page.goto(base);
    await page.locator(".list .group").first().waitFor();
    assert.equal((await frameOf()).repo, null);
    assert.deepEqual(errors, []);
  });
});
