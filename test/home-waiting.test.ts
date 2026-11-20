import { test } from "node:test";
import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { reviewStatus } from "../src/rules.js";
import { createWebServer, waitsOnYou } from "../src/web.js";
import { workSessionPath } from "../web/links.js";
import { BROWSER_SKIP, example, hasFocus, tempHome, withBrowser } from "./helpers.js";

// Home's Waiting on you lists everything Claude waits on the person for, oldest first, each with what
// it asks, its age and its session; what it lists leaves its session's group under Pending.

const OUTLINE = "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\n## Options\n";
const KEEP = { question: "Keep the old endpoint?", options: [{ label: "Keep it as an alias", recommended: true }, { label: "Remove it" }] };
const action = OPS.find((o) => o.name === "action")!;
const comment = [{ item: "FR-3", line: 1, body: "Inclusive?" }];

const waits = (hoop: Hoop, id: string) => {
  const meta = hoop.store.meta(id);
  return waitsOnYou(hoop, meta, reviewStatus(hoop.store, meta).status_key);
};

test("what waits on you: a revision awaiting your verdict, an unanswered question, a build with an empty section", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const review = hoop.submit(example()).review_id;
  assert.deepEqual(waits(hoop, review), { kind: "review", since: hoop.store.revisionAt(review) });
  hoop.review(review, { verdict: "comment", reviewer: "ana", comments: comment });
  assert.equal(waits(hoop, review), undefined, "once reviewed, it waits on Claude");

  const ask = hoop.ask({ questions: [KEEP] }).review_id;
  assert.deepEqual(waits(hoop, ask), { kind: "question", since: hoop.store.meta(ask).created });

  const build = hoop.startBuild(OUTLINE).review_id;
  assert.equal(waits(hoop, build)?.kind, "build");
  // Generate all asks Claude for every empty section: the build waits on Claude, not on you.
  hoop.buildChange(build, { op: "generate_all" });
  assert.ok((hoop.builds.read(build).requests ?? []).some((r) => r.status !== "written"));
  assert.equal(waits(hoop, build), undefined);

  const approved = hoop.submit(example()).review_id;
  hoop.review(approved, { verdict: "approved", reviewer: "ana" });
  assert.equal(waits(hoop, approved), undefined);
});

test("Home lists what waits on you oldest first, with what it asks, its age and session, and leaves it out of Pending", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const old = hoop.submit(example()).review_id;
    // The oldest: its revision was written an hour ago.
    const hourAgo = new Date(Date.now() - 3600_000);
    utimesSync(join(hoop.store.dirOf(old), "rev-1.json"), hourAgo, hourAgo);
    const ask = hoop.ask({ questions: [KEEP] }).review_id;
    const commented = hoop.submit({ ...example(), title: "Commented plan" }).review_id;
    hoop.review(commented, { verdict: "comment", reviewer: "ana", comments: comment });
    action.run(hoop, { title: "Merge the export PR", description: "It is green.", done_when: { kind: "manual" } } as never, { actor: "claude" });
    // A Work session whose step waits on a permission prompt.
    await page.route("**/api/work", (route) =>
      route.fulfill({
        json: {
          sessions: [
            {
              id: "work-session-1",
              name: "Export work",
              state: "busy",
              doing: { what: "Run npm publish", at: new Date().toISOString(), open: true, waiting: "permission" },
              agents: [],
              todos: [],
              changes: [],
            },
          ],
        },
      }),
    );
    await page.goto(base);
    const rows = page.locator("#g-waiting-body > .waiting-row, #g-waiting-body > .action");
    await page.locator("#g-waiting-body .waiting-row .kind", { hasText: "Work" }).waitFor();
    const texts = await rows.allTextContents();
    assert.equal(texts.length, 4, texts.join("\n"));
    assert.match(texts[0]!, /^Review · Approve or request changes.*1 h.* ago/, "the oldest first, with its age");
    assert.match(texts[1]!, /^Question · Answer/);
    assert.ok(
      texts.slice(2).some((t) => /^Work · Answer the prompt.*Run npm publish.*Export work/.test(t)),
      "a Work prompt, with its session",
    );
    assert.ok(
      texts.slice(2).some((t) => /Merge the export PR/.test(t)),
      "an open action item",
    );
    assert.equal(await page.locator(`#g-waiting-body a[href="/r/${old}"]`).count(), 1, "the title links to the review");
    assert.equal(await page.locator(`#g-waiting-body a[href="/r/${ask}"]`).count(), 1);
    // Below, Pending keeps only what doesn't wait on you.
    const pending = page.locator("#g-pending-body");
    assert.equal(await pending.locator(`a[href="/r/${commented}"]`).count(), 1);
    assert.equal(await pending.locator(`a[href="/r/${old}"]`).count(), 0, "what waits on you leaves its session group");
    assert.equal(await pending.locator(`a[href="/r/${ask}"]`).count(), 0);
  }),
);

test("a build waits on you from its last change, and no longer once a section is being written", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const build = hoop.startBuild(OUTLINE).review_id;
  assert.deepEqual(waits(hoop, build), { kind: "build", since: hoop.store.meta(build).updated });
  const section = hoop.builds.read(build).blocks.find((b) => b.text.startsWith("## Where"))!.id;
  hoop.buildChange(build, { op: "generate", block: section });
  assert.equal(waits(hoop, build), undefined, "Claude has a request to write a section");
});

test("regression: an unreadable build.json leaves the build out of Waiting on you, and the list still loads", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const build = hoop.startBuild(OUTLINE).review_id;
  const review = hoop.submit(example()).review_id;
  writeFileSync(join(hoop.store.dirOf(build), "build.json"), "{ not json");
  assert.equal(waits(hoop, build), undefined);
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/reviews`);
    assert.equal(res.status, 200);
    const list = (await res.json()) as { id: string; waits_on_you?: { kind: string } }[];
    assert.equal(list.find((m) => m.id === review)?.waits_on_you?.kind, "review");
    assert.ok(
      list.some((m) => m.id === build),
      "the build is still listed",
    );
  } finally {
    server.close();
  }
});

/** A Work session as /api/work gives it, with `doing` on the session and on each of `agents`. */
const workSession = (id: string, name: string, doing?: object, agents: object[] = []) => ({ id, name, state: "busy", doing, agents, todos: [], changes: [] });

test(
  "Waiting on you lists Claude Code's prompts, questions and dialogs, a subagent's too, by time, and keeps them through a failed Work read",
  { skip: BROWSER_SKIP },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      // A second apart; the review's time has milliseconds and the prompts' don't, which a string sort puts in the wrong order.
      const t0 = Date.now() - 600_000;
      const at = (s: number) => new Date(t0 + s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const review = hoop.submit(example()).review_id;
      const reviewAt = new Date(Math.floor(t0 / 1000) * 1000 + 1500);
      utimesSync(join(hoop.store.dirOf(review), "rev-1.json"), reviewAt, reviewAt);
      const sessions = [
        workSession("work-session-1", "Export work", { what: "Run npm publish", at: at(1), open: true, waiting: "permission" }),
        workSession("work-session-2", "Docs work", { what: "Which format?", at: at(0), open: true, waiting: "question" }, [
          { id: "a1", description: "Check links", doing: { what: "Allow curl?", at: at(3), open: true, waiting: "dialog" } },
        ]),
        workSession("work-session-3", "Review work", { what: "Waiting on review", at: at(2), open: true, waiting: "review" }),
      ];
      let fail = false;
      await page.addInitScript(() => Object.assign(window, { HOOP_WORK_ALERT_MS: 200 }));
      await page.route("**/api/work", (route) => (fail ? route.fulfill({ status: 500, body: "{}" }) : route.fulfill({ json: { sessions } })));
      await page.goto(base);
      const titles = () => page.locator("#g-waiting-body .waiting-row .t").allTextContents();
      await page.locator("#g-waiting-body .waiting-row .t", { hasText: "Allow curl?" }).waitFor();
      assert.deepEqual(await titles(), ["Which format?", "Run npm publish", "Order export: requirements", "Allow curl?"], "oldest first, by time");
      assert.equal(
        await page.locator("#g-waiting-body .waiting-row", { hasText: "Waiting on review" }).count(),
        0,
        "a wait on a hoop review lists as that review",
      );
      assert.equal(
        await page.locator("#g-waiting-body a", { hasText: "Run npm publish" }).getAttribute("href"),
        workSessionPath("work-session-1"),
        "a prompt links to its session on Work",
      );
      // A failed read keeps the prompts last read.
      fail = true;
      await page.waitForTimeout(800);
      assert.equal((await titles()).length, 4);
    }),
);

test("regression: Close on a Waiting on you row puts focus on the next row there", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const ids = ["First plan", "Second plan", "Third plan"].map((title) => hoop.submit({ ...example(), title }).review_id);
    ids.forEach((id, i) => {
      const t = new Date(Date.now() - 600_000 + i * 1000);
      utimesSync(join(hoop.store.dirOf(id), "rev-1.json"), t, t);
    });
    const pending = hoop.submit({ ...example(), title: "Pending plan" }).review_id;
    hoop.review(pending, { verdict: "comment", reviewer: "ana", comments: comment });
    await page.goto(base);
    await page.locator(`#g-waiting-body [data-close-review="${ids[1]}"]`).click();
    await page.keyboard.press("Enter");
    await page.locator(`#g-completed-body a[href="/r/${ids[1]}"]`).waitFor({ state: "attached" });
    assert.ok(await hasFocus(page.locator(`#g-waiting-body a[href="/r/${ids[2]}"]`)), "the next row in Waiting on you, not Pending's first");
  }),
);
