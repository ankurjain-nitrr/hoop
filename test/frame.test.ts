import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clip, repoIdentity } from "../src/util.js";
import { reviewSummary } from "../src/web.js";
import { frame } from "../web/frame.js";
import { example, BROWSER_SKIP, withBrowser } from "./helpers.js";
import { hasWork, removeWork, workHook } from "../src/work.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));

test("the frame's Work link shows once a session recorded todos or subagents, and always on the Work page", () => {
  const links = (html: string) => [...html.matchAll(/<span>([^<]+)<\/span>/g)].map((x) => x[1]);
  assert.deepEqual(links(frame("home", "", { work: false })), ["Home"], "hidden while no session recorded work");
  assert.deepEqual(links(frame("home", "", { work: true })), ["Home", "Work"]);
  assert.deepEqual(links(frame("work", "", { work: false })), ["Home", "Work"], "the Work page, which its address reaches, shows its own link");
  assert.deepEqual(links(frame("home", "")), ["Home"], "without the server's info, the link waits for it, so it never shows and then goes");
});

test("the pages say whether this machine has work from hoop's own records, and an open page's frame follows without a reload", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const info = async () => (await (await fetch(`${base}/api/info`)).json()) as { work: boolean };
    assert.equal((await info()).work, false, "no session recorded work");
    await page.goto(`${base}/work`);
    await page.locator('header.frame nav a[href="/work"][aria-current="page"]').waitFor();
    await page.addInitScript(() => Object.assign(window, { HOOP_INFO_MS: 200 }));
    await page.goto(base);
    await page.locator("header.frame").waitFor();
    assert.equal(await page.locator('header.frame nav a[href="/work"]').count(), 0, "Home has no Work link yet");
    workHook(hoop.store.home, {
      ...HOOKS["post-taskcreate"],
      tool_input: { subject: "Run the tests" },
      tool_response: { task: { id: "1", subject: "Run the tests" } },
    });
    assert.equal((await info()).work, true, "a session recorded a todo");
    await page.locator('header.frame nav a[href="/work"]').waitFor({ timeout: 5000 });
    // Polls that change nothing touch nothing: focus on Home stays through them.
    const home = page.locator('header.frame nav a[href="/"]');
    await home.focus();
    await page.waitForTimeout(700);
    assert.equal(await home.evaluate((el) => el === document.activeElement), true, "focus stays on Home through unchanged polls");
    // The Work link holding focus as its last record goes hands focus to Home.
    await page.locator('header.frame nav a[href="/work"]').focus();
    assert.equal(
      removeWork(hoop.store.home, HOOKS["post-taskcreate"].session_id as string, { sessions: () => [], now: Date.now() + 365 * 86_400_000 }),
      "removed",
    );
    await page.locator('header.frame nav a[href="/work"]').waitFor({ state: "detached", timeout: 5000 });
    assert.equal(await home.evaluate((el) => el === document.activeElement), true, "focus goes to Home");
  }),
);

test("whether this machine has work is read once, then kept until hoop writes or removes a work record", () => {
  const home = mkdtempSync(join(tmpdir(), "hoop-work-cache-"));
  assert.equal(hasWork(home), false);
  // A record that appears behind hoop's back isn't read: the answer is kept.
  const session = HOOKS["post-taskcreate"].session_id as string;
  mkdirSync(join(home, "work"), { recursive: true });
  const record = { session, updated: "2026-01-01T00:00:00Z", todos: [{ id: "1", text: "x", status: "queued" }], agents: [], pending: [] };
  writeFileSync(join(home, "work", `${session}.json`), JSON.stringify(record));
  assert.equal(hasWork(home), false, "the kept answer is used");
  // hoop's own write drops it, so the next ask reads the records again.
  workHook(home, { ...HOOKS["post-taskcreate"], tool_input: { subject: "Run the tests" }, tool_response: { task: { id: "2", subject: "Run the tests" } } });
  assert.equal(hasWork(home), true);
  assert.equal(removeWork(home, session, { sessions: () => [], now: Date.now() + 365 * 86_400_000 }), "removed");
  assert.equal(hasWork(home), false, "removing the record drops it too");
});

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

test("regression: a message said while the live region is first made replaces the first one, so the newest is heard", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ base, page }) => {
    await page.goto(base);
    await page.locator("header.frame").waitFor();
    await page.evaluate(`(async () => {
      const { announce } = await import("/frame.js");
      document.getElementById("page-live")?.remove();
      announce("Dismissed.");
      announce("Put back.");
    })()`);
    await page.waitForFunction(() => document.querySelector("#page-live")?.textContent !== "");
    await page.waitForTimeout(150);
    assert.equal(await page.locator("#page-live").textContent(), "Put back.");
  });
});

test("every page shows the same frame, and Home splits reviews into Pending and Completed", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id: a } = hoop.submit(example());
    const { review_id: second } = hoop.submit({ ...example(), title: "Second review", tldr: "What the second review is about." });
    hoop.review(a, { verdict: "changes_requested", summary: "Split it." });
    // Commented, it waits on Claude and stays under Pending; one awaiting your verdict shows in Waiting on you.
    hoop.review(second, { verdict: "comment", reviewer: "ana", comments: [{ item: "FR-3", line: 1, body: "Inclusive?" }] });
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
    // Home holds reviews from every repository, and neither the frame nor a row names one. No session
    // recorded todos or subagents here, so the frame has no Work link yet.
    assert.deepEqual(list, { brand: "hoop", links: ["Home"], current: "Home" });
    assert.equal(await page.locator(".list-head h1").textContent(), "Home");
    assert.match(await page.title(), /^(\(1\) )?Home · hoop$/, "the count of reviews awaiting the person may lead the title");
    // A review here has an answer, so Home ends with Your response times, which loads after the reviews.
    await page.locator("#g-response-times").waitFor();
    const sections = await page.locator(".list .group").evaluateAll((els) =>
      els.map((el) => ({
        head: el.querySelector("h2")!.textContent!.replace(/\s+/g, " ").trim(),
        rows: [...el.querySelectorAll("a[href]")].map((x) => [x.querySelector(".t")!.textContent, x.querySelector(".badge")?.textContent ?? ""]),
      })),
    );
    // A row shows its status only where it differs from its section's usual one (#201); what waits on
    // you leads, in Waiting on you, and leaves Pending.
    assert.deepEqual(sections, [
      { head: "Waiting on you 1", rows: [["Done review, again", ""]] },
      {
        head: "Pending 2",
        rows: [
          ["Second review", "Commented"],
          ["Order export: requirements", "Changes requested"],
        ],
      },
      { head: "Completed 1", rows: [["Done review", ""]] },
      { head: "Your response times", rows: [] },
    ]);
    const summary = page.locator(".list a", { hasText: "Second review" }).locator(".s");
    assert.equal(await summary.textContent(), "What the second review is about.");
    assert.equal(await summary.getAttribute("title"), "What the second review is about.");
    assert.equal(await summary.evaluate((el) => getComputedStyle(el).webkitLineClamp), "2", "the TL;DR keeps to two lines");
    const meta = await page.locator("#g-pending-body .m").first().textContent();
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
