import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoIdentity } from "../src/util.js";
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

test("the frame marks the current page and escapes the repository name", () => {
  const html = frame("home", "<p>body</p>", { name: "a<b>", key: "k" });
  assert.match(html, /<a href="\/" aria-current="page">/);
  assert.doesNotMatch(frame("", ""), /aria-current/);
  assert.ok(html.includes("a&lt;b&gt;") && html.endsWith("<p>body</p>"));
  assert.doesNotMatch(frame("home", ""), /frame-repo/, "no repository, no name");
});

test("Home says what each review is about: its TL;DR as plain text, or else its first prose line", () => {
  const doc = (tldr: string, body?: string) => ({ ...example(), tldr, items: [{ id: "a", type: "section", title: "A", body }] });
  assert.equal(reviewSummary(doc("Ship **bold** `hoop_submit` via [the docs](https://x.example)", "Body")), "Ship bold hoop_submit via the docs");
  assert.equal(reviewSummary(doc(" ", "- a list item\n\nThe first *prose* line\n\nMore")), "The first prose line");
  assert.equal(reviewSummary(doc(" ", "- only a list")), "");
});

test("every page shows the same frame, and Home splits reviews into Pending and Completed", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id: a } = hoop.submit(example());
    hoop.submit({ ...example(), title: "Second review", tldr: "What the second review is about." });
    hoop.review(a, { verdict: "changes_requested" });
    const { review_id: done } = hoop.submit({ ...example(), slug: "done", title: "Done review" });
    hoop.review(done, { verdict: "approved" });
    // Revising an approved review supersedes it: the old one stays completed, the new one is pending.
    hoop.submit({ ...example(), slug: "done", title: "Done review, again" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // The server's own folder is the first open repository, and these reviews come from it.
    const name = (await (await fetch(`${base}/api/info`)).json()).repos[0].name;
    const frameOf = () =>
      page.locator("header.frame").evaluate((el) => ({
        brand: el.querySelector(".brand")?.textContent,
        links: [...el.querySelectorAll("nav a")].map((x) => x.textContent),
        repo: el.querySelector(".frame-repo")?.textContent ?? null,
        current: el.querySelector("[aria-current]")?.textContent ?? null,
      }));

    await page.goto(base);
    await page.locator(".list .group").first().waitFor();
    const list = await frameOf();
    // Home holds reviews from every repository, and neither the frame nor a row names one.
    assert.deepEqual(list, { brand: "hoop", links: ["Home"], repo: null, current: "Home" });
    assert.equal(await page.locator(".list-head h1").textContent(), "Home");
    assert.equal(await page.title(), "Home · hoop");
    const sections = await page.locator(".list .group").evaluateAll((els) =>
      els.map((el) => ({
        head: el.querySelector("h2")!.textContent!.replace(/\s+/g, " ").trim(),
        rows: [...el.querySelectorAll("a")].map((x) => [x.querySelector(".t")!.textContent, x.querySelector(".badge")!.textContent]),
      })),
    );
    assert.deepEqual(sections, [
      {
        head: "Pending 3",
        rows: [
          ["Done review, again", "Awaiting review"],
          ["Order export: requirements", "Changes requested"],
          ["Second review", "Awaiting review"],
        ],
      },
      { head: "Completed 1", rows: [["Done review", "Approved"]] },
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
    assert.deepEqual(await frameOf(), { ...list, repo: name, current: null });

    // Regression: a stalled /api/info used to keep every page on "Loading…".
    await page.route("**/api/info", () => {
      /* never answers */
    });
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
