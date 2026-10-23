import { test } from "node:test";
import assert from "node:assert/strict";
import { arrivals, countedTitle, faviconHref, waiting } from "../web/pending.js";
import { example, BROWSER_SKIP, withBrowser } from "./helpers.js";

const row = (id: string, status_key: string, extra = {}) => ({ id, title: id, revisions: 1, status_key, ...extra });

test("the count is the reviews awaiting the person, in front of the title, with a dot on the favicon", () => {
  const list = [row("a", "awaiting_review"), row("b", "awaiting_review", { superseded_by: "c" }), row("c", "changes_requested"), row("d", "approved")];
  assert.deepEqual(
    waiting(list).map((m) => m.id),
    ["a"],
  );
  assert.equal(countedTitle("Home · hoop", 2), "(2) Home · hoop");
  assert.equal(countedTitle("(2) Home · hoop", 3), "(3) Home · hoop", "a new count replaces the old one");
  assert.equal(countedTitle("(2) Home · hoop", 0), "Home · hoop");
  assert.match(faviconHref(1), /id='dot'/);
  assert.doesNotMatch(faviconHref(0), /dot/);
  const seen = new Set(["a:1"]);
  assert.deepEqual(
    arrivals(seen, [row("a", "awaiting_review"), row("e", "awaiting_review"), { ...row("a", "awaiting_review"), revisions: 2 }]).map(
      (m) => `${m.id}:${m.revisions}`,
    ),
    ["e:1", "a:2"],
    "a new review and a new revision waiting again are new",
  );
});

type Win = { shown: { title: string; tag: string }[]; asked: number; vis: string; last?: { onclick: () => void } };

test("every tab counts waiting reviews; a hidden tab notifies of a new one only after Notify me", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    // A Notification that records what it would show, and a visibility the test sets. The script
    // goes to the page as text, so no compiled helper can be missing there.
    await page.addInitScript(`
      Object.assign(window, { shown: [], asked: 0, vis: "visible", HOOP_PENDING_MS: 100 });
      function Stub(title, opts) {
        shown.push({ title, tag: opts.tag });
        this.onclick = () => {};
        this.close = () => {};
        window.last = this;
      }
      Stub.permission = "default";
      Stub.requestPermission = async () => {
        asked++;
        Stub.permission = "granted";
        return "granted";
      };
      window.Notification = Stub;
      Object.defineProperty(document, "visibilityState", { get: () => vis, configurable: true });
    `);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const win = () =>
      page.evaluate(() => {
        const w = window as unknown as Win;
        return { shown: w.shown, asked: w.asked };
      });
    const hide = (hidden: boolean) => page.evaluate((v) => ((window as unknown as Win).vis = v), hidden ? "hidden" : "visible");
    const titled = (re: RegExp) => page.waitForFunction((src) => new RegExp(src).test(document.title), re.source);
    const submit = (title: string) => hoop.submit({ ...example(), title }).review_id;

    submit("First plan");
    await page.goto(base);
    await titled(/^\(1\) Home · hoop$/);
    const icon = page.locator("link[rel=icon]");
    assert.equal(await icon.getAttribute("data-count"), "1");
    assert.match((await icon.getAttribute("href"))!, /id='dot'/, "the favicon shows a dot");

    // Hidden, but notifications are off: the count goes up and nothing shows.
    await hide(true);
    submit("Second plan");
    await titled(/^\(2\) /);
    assert.deepEqual((await win()).shown, []);
    assert.equal((await win()).asked, 0, "the page never asks for permission on its own");

    // Notify me asks once; a review arriving while the tab is visible still shows nothing.
    await hide(false);
    const notify = page.getByRole("button", { name: "Notify me" });
    assert.equal(await notify.getAttribute("aria-pressed"), "false");
    await notify.click();
    await page.locator('#notifyMe[aria-pressed="true"]').waitFor();
    assert.equal((await win()).asked, 1);
    submit("Third plan");
    await titled(/^\(3\) /);
    assert.deepEqual((await win()).shown, []);
    // The list on Home shows it too.
    await page.getByRole("link", { name: /Third plan/ }).waitFor();

    // Hidden and on: a new review shows a notification, and clicking it opens the review.
    await hide(true);
    const fourth = submit("Fourth plan");
    await page.waitForFunction(() => (window as unknown as Win).shown.length > 0);
    assert.deepEqual((await win()).shown, [{ title: "New review: Fourth plan", tag: fourth }]);
    await page.evaluate(() => (window as unknown as Win).last!.onclick());
    await page.waitForURL(`**/r/${fourth}`);
    await titled(/^\(4\) /);

    // A review page counts too, and the count and dot go when nothing waits.
    for (const id of hoop.store.list().map((m) => m.id)) hoop.review(id, { verdict: "approved" });
    await page.waitForFunction(() => !/^\(\d+\)/.test(document.title));
    assert.equal(await icon.getAttribute("data-count"), "0");
    assert.doesNotMatch((await icon.getAttribute("href"))!, /dot/);
    assert.deepEqual(errors, []);
  }),
);
