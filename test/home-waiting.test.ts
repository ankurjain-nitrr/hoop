import { test } from "node:test";
import assert from "node:assert/strict";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { reviewStatus } from "../src/rules.js";
import { waitsOnYou } from "../src/web.js";
import { BROWSER_SKIP, example, tempHome, withBrowser } from "./helpers.js";

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
