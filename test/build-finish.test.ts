import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hoop } from "../src/hoop.js";
import { INSTRUCTIONS } from "../src/mcp.js";
import { OPS } from "../src/ops.js";
import { reviewStatus } from "../src/rules.js";
import { Store } from "../src/store.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

const OUTLINE =
  "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\nWhat we spend on.\n\n## Options\n\nWhat we could cut.\n";
const run = (hoop: Hoop, name: string, input: Record<string, unknown>) => OPS.find((o) => o.name === name)!.run(hoop, input, { actor: "claude" });

test("Finish makes the build the review's next revision, which exports byte for byte and takes reviews", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.startBuild(OUTLINE);
  const sections = hoop.store.revision(id).items.map((i) => [i.id, i.title]);
  hoop.buildWrite(
    id,
    "b3",
    "Compute, then storage.\n\n| Item | Share |\n|---|--:|\n| Compute | 70% |\n\n```mermaid\nflowchart LR\n  a[Compute] --> b[Bill]\n```",
  );
  hoop.buildChange(id, { op: "edit", block: "b5", text: "## Ways to cut" });
  const built = hoop.markdownOf(id);

  const done = hoop.finishBuild(id);
  assert.deepEqual([done.revision, done.outcome], [2, "revised"]);
  const meta = hoop.store.meta(id);
  assert.equal(meta.build, undefined);
  assert.deepEqual(reviewStatus(hoop.store, meta), { status_key: "awaiting_review" });
  const out = run(hoop, "export", { review_id: id }) as { markdown: string; revision: number };
  assert.equal(out.markdown, built, "the review exports the build's markdown exactly");
  // The section kept by its heading keeps its ID; the renamed one is matched by place.
  const now = hoop.store.revision(id).items.map((i) => [i.id, i.title]);
  assert.deepEqual(now[0], sections[0]);
  assert.equal(now[1]![0], sections[1]![0]);
  assert.throws(() => hoop.finishBuild(id), /not a document being built/);
  assert.throws(() => hoop.buildChange(id, { op: "remove", block: "b1" }), /not a document being built/);

  // Claude's build loop hears that the build is finished, and its cursor waits for the first review.
  const finished = (await run(hoop, "build_wait", { review_id: id, seconds: 1 })) as { status: string; cursor: string };
  assert.equal(finished.status, "finished");
  hoop.review(id, { verdict: "approved", reviewer: "ana" });
  const reviewed = (await run(hoop, "wait", { review_id: id, after: finished.cursor, seconds: 1 })) as { status: string; approved: boolean };
  assert.deepEqual([reviewed.status, reviewed.approved], ["reviewed", true]);
});

test("the instructions and the skill build the document on the page and finish it into a review", () => {
  assert.match(INSTRUCTIONS, /Start a build with hoop_build/);
  assert.match(INSTRUCTIONS, /Call hoop_build_wait/);
  assert.match(INSTRUCTIONS, /hoop_build_write/);
  assert.match(INSTRUCTIONS, /When they press Finish, hoop_build_wait says finished/);
  const skill = readFileSync(new URL("../plugins/hoop/skills/build-document/SKILL.md", import.meta.url), "utf8");
  for (const word of ["hoop_build", "hoop_build_wait", "hoop_build_write", "hoop_build_suggest", "Finish"]) assert.ok(skill.includes(word), word);
  // Claude starts from the title and asks nothing first.
  const building = INSTRUCTIONS.slice(INSTRUCTIONS.indexOf("Building a document together:"), INSTRUCTIONS.indexOf("The loop:"));
  assert.match(building, /ask nothing first/);
  assert.match(building, /only a working title/);
  for (const asked of [/## Question:/, /who it's for/i, /how long/i, /hoop_submit/]) assert.doesNotMatch(building, asked);
  assert.match(building, /hoop_build_suggest/);
});

test("Finish on the build page turns it into the review page", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    await page.goto(`${base}/r/${id}`);
    await page.getByRole("button", { name: "Finish and review" }).click();
    await page.locator("#finishBtn").waitFor();
    assert.equal(await page.locator(".bblock").count(), 0);
    assert.match((await page.locator(".top h1").textContent()) ?? "", /Cutting cloud cost/);
    assert.equal(hoop.store.meta(id).revisions, 2);
  }),
);
