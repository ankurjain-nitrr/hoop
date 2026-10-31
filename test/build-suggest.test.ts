import { test } from "node:test";
import assert from "node:assert/strict";
import { joinBlocks } from "../src/build.js";
import { Hoop } from "../src/hoop.js";
import { OPS } from "../src/ops.js";
import { Store } from "../src/store.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

const run = (hoop: Hoop, name: string, input: Record<string, unknown>) => OPS.find((o) => o.name === name)!.run(hoop, input, { actor: "claude" });

function started(md = "# Cutting cloud cost\n") {
  const hoop = new Hoop(new Store(tempHome()));
  return { hoop, id: hoop.startBuild(md).review_id };
}

// b1 # T, b2 ## A, b3 A text, b4 ### A1, b5 ## B, b6 B text
const NESTED = "# T\n\n## A\n\nA text.\n\n### A1\n\n## B\n\nB text.\n";

test("a build starts from only a title, and Suggest an outline queues a request Claude takes with its level", () => {
  const { hoop, id } = started();
  assert.equal(hoop.markdownOf(id), "# Cutting cloud cost\n");
  hoop.buildChange(id, { op: "suggest", block: "b1", kind: "outline", note: " for the finance team; see the Q3 bill " });
  const [task] = hoop.takeRequests(id);
  assert.deepEqual(
    { ...task, markdown: undefined },
    {
      request: "g1",
      kind: "outline",
      section: "b1",
      heading: "# Cutting cloud cost",
      note: "for the finance team; see the Q3 bill",
      section_markdown: "",
      markdown: undefined,
      level: 2,
    },
  );
  assert.equal(hoop.builds.read(id).steps.at(-2)!.what, "asked Claude to suggest an outline");
});

test("each Suggest action queues its own request where it belongs, and is refused elsewhere", () => {
  const { hoop, id } = started(NESTED);
  hoop.buildChange(id, { op: "suggest", block: "b2", kind: "subsections" });
  hoop.buildChange(id, { op: "suggest", block: "b5", kind: "next" });
  hoop.buildChange(id, { op: "suggest", block: "b4", kind: "next" });
  hoop.buildChange(id, { op: "generate", block: "b2" });
  assert.deepEqual(
    hoop.takeRequests(id).map((t) => [t.request, t.kind, t.section, t.level]),
    [
      ["g1", "subsections", "b2", 3],
      ["g2", "next", "b5", 2],
      ["g3", "next", "b4", 3],
      ["g4", "write", "b2", undefined],
    ],
  );
  assert.throws(() => hoop.buildChange(id, { op: "suggest", block: "b2", kind: "next" }), /only after the last heading of its size/);
  assert.throws(() => hoop.buildChange(id, { op: "suggest", block: "b2", kind: "outline" }), /under the title: ask on the title/);
  assert.throws(() => hoop.buildChange(id, { op: "suggest", block: "b1", kind: "subsections" }), /subheadings under a heading/);
  assert.throws(() => hoop.buildChange(id, { op: "suggest", block: "b3", kind: "next" }), /next heading after a heading/);
  assert.throws(() => hoop.buildChange(id, { op: "suggest", block: "b2", kind: "poem" } as never), /"outline", "next" or "subsections"/);
});

test("request IDs are never reused after a queued request is cancelled", () => {
  const { hoop, id } = started(NESTED);
  hoop.buildChange(id, { op: "generate", block: "b2" });
  hoop.buildChange(id, { op: "cancel", request: "g1" });
  hoop.buildChange(id, { op: "generate", block: "b2", note: "again" });
  hoop.buildChange(id, { op: "generate", block: "b5" });
  const ids = hoop.builds.read(id).requests!.map((r) => r.id);
  assert.deepEqual(ids, ["g1", "g2", "g3"]);
});

test("suggestions keep to the levels the request allows, and suggest only for suggestion requests", () => {
  const { hoop, id } = started(NESTED);
  hoop.buildChange(id, { op: "suggest", block: "b1", kind: "outline" });
  hoop.buildChange(id, { op: "generate", block: "b2" });
  assert.throws(() => hoop.buildSuggest(id, "g1", [{ heading: "# Another title" }]), /start at level 2/);
  assert.throws(() => hoop.buildSuggest(id, "g1", [{ heading: "### Too deep first" }]), /skips a level/);
  assert.throws(() => hoop.buildSuggest(id, "g1", [{ heading: "## A" }, { heading: "#### Skips" }]), /skips a level/);
  assert.throws(() => hoop.buildSuggest(id, "g1", [{ heading: "Not a heading" }]), /one markdown heading/);
  assert.throws(() => hoop.buildSuggest(id, "g1", []), /at least one/);
  assert.throws(() => hoop.buildSuggest(id, "g2", [{ heading: "## X" }]), /hoop_build_write/);
  assert.throws(() => hoop.buildWrite(id, "b1", "Text"), /not a section heading/);
  const other = new Hoop(hoop.store, "other-session-1111");
  assert.throws(() => other.buildSuggest(id, "g1", [{ heading: "## X" }]), /Only the session that submitted/);
  hoop.buildChange(id, { op: "suggest", block: "b5", kind: "next" });
  assert.throws(() => hoop.buildSuggest(id, "g3", [{ heading: "# Up a level" }]), /start at level 2/);
  hoop.buildSuggest(id, "g3", [{ heading: "## C" }, { heading: "### C1" }]);
});

test("suggestions change nothing until accepted; accept, edit, dismiss and accept all place headings where they were asked for", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "suggest", block: "b1", kind: "outline" });
  const out = run(hoop, "build_suggest", {
    review_id: id,
    request: "g1",
    headings: [
      { heading: "## Where the money goes", note: "  Compute,\nstorage and egress. " },
      { heading: "### Compute" },
      { heading: "## Options" },
      { heading: "## Risks" },
    ],
  }) as { suggested: number };
  assert.equal(out.suggested, 4);
  let build = hoop.builds.read(id);
  assert.equal(joinBlocks(build), "# Cutting cloud cost\n", "suggestions don't touch the document");
  assert.deepEqual(
    build.proposals!.map((p) => [p.id, p.level, p.title, p.note, p.status]),
    [
      ["p1", 2, "Where the money goes", "Compute, storage and egress.", "proposed"],
      ["p2", 3, "Compute", undefined, "proposed"],
      ["p3", 2, "Options", undefined, "proposed"],
      ["p4", 2, "Risks", undefined, "proposed"],
    ],
  );
  assert.equal(build.requests![0]!.status, "written");
  assert.equal(build.steps.at(-1)!.what, "suggested 4 headings");
  assert.equal(joinBlocks(hoop.builds.at(id, build.version)), "# Cutting cloud cost\n");

  // Accepted out of order, each still lands in the suggested order.
  hoop.buildChange(id, { op: "accept", proposal: "p3" });
  hoop.buildChange(id, { op: "retitle", proposal: "p1", title: "  Where   it goes " });
  hoop.buildChange(id, { op: "accept", proposal: "p1" });
  build = hoop.buildChange(id, { op: "dismiss", proposal: "p4" });
  assert.equal(joinBlocks(build), "# Cutting cloud cost\n\n## Where it goes\n\n## Options\n");
  build = hoop.buildChange(id, { op: "accept_all", request: "g1" });
  assert.equal(joinBlocks(build), "# Cutting cloud cost\n\n## Where it goes\n\n### Compute\n\n## Options\n");
  assert.deepEqual(
    build.steps.slice(-5).map((s) => s.what),
    [
      'accepted the suggested heading "Options"',
      'edited the suggested heading "Where it goes"',
      'accepted the suggested heading "Where it goes"',
      'dismissed the suggested heading "Risks"',
      "accepted 1 suggested heading",
    ],
  );
  assert.ok(build.blocks.slice(1).every((b) => b.by === "claude" && !b.generated));
  assert.throws(() => hoop.buildChange(id, { op: "accept", proposal: "p4" }), /no suggestion p4 waiting/);
  assert.throws(() => hoop.buildChange(id, { op: "retitle", proposal: "p9", title: "x" }), /no suggestion p9/);
  assert.throws(() => hoop.buildChange(id, { op: "accept_all", request: "g1" }), /no suggestions waiting/);
});

test("the next section goes after the section it was asked on, and subsections at the end of theirs", () => {
  const { hoop, id } = started(NESTED);
  hoop.buildChange(id, { op: "suggest", block: "b4", kind: "next" });
  hoop.buildChange(id, { op: "suggest", block: "b2", kind: "subsections" });
  hoop.buildChange(id, { op: "suggest", block: "b5", kind: "next" });
  hoop.buildSuggest(id, "g1", [{ heading: "### A2" }]);
  hoop.buildSuggest(id, "g2", [{ heading: "### A3" }]);
  hoop.buildSuggest(id, "g3", [{ heading: "## C" }]);
  for (const r of ["g1", "g2", "g3"]) hoop.buildChange(id, { op: "accept_all", request: r });
  assert.equal(hoop.markdownOf(id), "# T\n\n## A\n\nA text.\n\n### A1\n\n### A2\n\n### A3\n\n## B\n\nB text.\n\n## C\n");
  // Suggesting again replaces suggestions still waiting.
  hoop.buildChange(id, { op: "suggest", block: "b1", kind: "outline" });
  hoop.buildSuggest(id, "g4", [{ heading: "## X" }]);
  hoop.buildSuggest(id, "g4", [{ heading: "## Y" }]);
  assert.deepEqual(
    hoop.builds
      .read(id)
      .proposals!.filter((p) => p.status === "proposed")
      .map((p) => p.title),
    ["Y"],
  );
});

test("on the page, Suggest an outline takes notes, and the suggestions wait as placeholders to accept, edit or dismiss", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild("# Cutting cloud cost\n");
    await page.addInitScript(() => Object.assign(window, { HOOP_BUILD_MS: 200 }));
    await page.goto(`${base}/r/${id}`);
    await page.getByRole("button", { name: "Suggest an outline for Title “Cutting cloud cost”" }).click();
    const notes = page.getByLabel("Notes for Claude (optional)");
    assert.equal(await notes.evaluate((el) => el === document.activeElement), true, "the notes box has focus");
    await notes.fill("For finance. Key points: compute, storage.");
    await page.locator(".bgen").getByRole("button", { name: "Suggest an outline" }).click();
    await page.locator(".bstatus", { hasText: "Queued: Claude suggests an outline" }).waitFor();
    assert.equal(hoop.builds.read(id).requests![0]!.note, "For finance. Key points: compute, storage.");

    hoop.takeRequests(id);
    await page.locator(".bstatus", { hasText: "Claude is suggesting an outline" }).waitFor();
    hoop.buildSuggest(id, "g1", [
      { heading: "## Where the money goes", note: "Compute and storage." },
      { heading: "### Compute" },
      { heading: "## Options" },
      { heading: "## Risks" },
    ]);
    await page.locator(".bprop").first().waitFor();
    assert.equal(await page.locator(".bprop").count(), 4);
    assert.equal(
      await page
        .locator(".bprop")
        .first()
        .evaluate((el) => getComputedStyle(el).borderTopStyle),
      "dashed",
    );
    assert.equal(hoop.markdownOf(id), "# Cutting cloud cost\n", "placeholders aren't in the document");
    assert.equal(await page.locator(".bblock").count(), 1);

    // Edit one from the keyboard: Enter saves the new title.
    await page.getByRole("button", { name: "Edit suggested heading “Options”" }).click();
    const title = page.getByLabel("Title of the suggested heading “Options”");
    assert.equal(await title.evaluate((el) => el === document.activeElement), true);
    await title.fill("Ways to cut");
    await page.keyboard.press("Enter");
    await page.locator(".bprop-h", { hasText: "Ways to cut" }).waitFor();
    await page.getByRole("button", { name: "Dismiss suggested heading “Risks”" }).click();
    await page.locator(".bprop-h", { hasText: "Risks" }).waitFor({ state: "detached" });
    const accept = page.getByRole("button", { name: "Accept suggested heading “Where the money goes”" });
    await accept.focus();
    await page.keyboard.press("Enter");
    await page.locator('.bblock [class*="bh-h2"]', { hasText: "Where the money goes" }).waitFor();
    assert.equal(
      await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute("aria-label")),
      "Accept suggested heading “Compute”",
      "focus moves to the next suggestion",
    );
    await page.getByRole("button", { name: /^Accept all 2 suggested headings/ }).click();
    await page.locator(".bprop").first().waitFor({ state: "detached" });
    assert.equal(hoop.markdownOf(id), "# Cutting cloud cost\n\n## Where the money goes\n\n### Compute\n\n## Ways to cut\n");

    // The last section offers the next one; any section offers subsections.
    assert.equal(await page.getByRole("button", { name: "Suggest the next heading for Heading 1 “Ways to cut”" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Suggest the next heading for Heading 1 “Where the money goes”" }).count(), 0);
    await page.getByRole("button", { name: "Suggest subheadings for Heading 1 “Where the money goes”" }).click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".bgen").count(), 0);
    await page.getByRole("button", { name: "Suggest the next heading for Heading 1 “Ways to cut”" }).click();
    await page.keyboard.press("Enter");
    await page.locator(".bstatus", { hasText: "Queued: Claude suggests the next heading" }).waitFor();
    assert.deepEqual(
      hoop.builds.read(id).requests!.map((r) => [r.kind, r.block, r.status]),
      [
        ["outline", "b1", "written"],
        ["next", hoop.builds.read(id).blocks.at(-1)!.id, "queued"],
      ],
    );
  }),
);
