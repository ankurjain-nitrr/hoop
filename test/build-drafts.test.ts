import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { OPS } from "../src/ops.js";
import { Store } from "../src/store.js";
import { BROWSER_SKIP, hasFocus, tempHome, withBrowser } from "./helpers.js";

// Claude's text for a section arrives as a draft the person saves or discards; Generate again offers
// one-press refinements; Continue writing adds after a section's text; Generate all writes every
// empty heading (#349).

// b1 # title, b2 paragraph, b3 ## Where the money goes, b4 paragraph, b5 ## Options, b6 ## Risks
const OUTLINE = "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\nOld guess.\n\n## Options\n\n## Risks\n";
const run = (hoop: Hoop, name: string, input: Record<string, unknown>) => OPS.find((o) => o.name === name)!.run(hoop, input, { actor: "claude" });

function started(markdown = OUTLINE) {
  const hoop = new Hoop(new Store(tempHome()));
  return { hoop, id: hoop.startBuild(markdown).review_id };
}

test("a section write waits as a draft: the blocks stay as they were until Save, and Discard leaves them exactly", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "context_add", ref: "https://docs.google.com/document/d/costs/edit" });
  hoop.buildChange(id, { op: "generate", block: "b3" });
  hoop.takeRequests(id);
  const before = hoop.builds.read(id).blocks;
  const drafted = hoop.buildWrite(id, "b3", "Compute is most of it.\n\n- Servers", ["d1"]);
  assert.deepEqual(drafted.blocks, before, "nothing in the document changes");
  assert.equal(hoop.markdownOf(id), OUTLINE);
  assert.deepEqual(
    drafted.drafts!.map((d) => [d.section, d.kind, d.request, d.blocks.map((b) => [b.text, b.generated, b.sources])]),
    [
      [
        "b3",
        "write",
        "g1",
        [
          ["Compute is most of it.", true, ["https://docs.google.com/document/d/costs/edit"]],
          ["- Servers", true, ["https://docs.google.com/document/d/costs/edit"]],
        ],
      ],
    ],
  );
  assert.equal(drafted.requests![0]!.status, "written", "the draft answers the request");
  assert.equal(drafted.steps.at(-1)!.what, "drafted the text under a heading");

  // Discard throws it away: the build's blocks and markdown are exactly as before.
  const discarded = hoop.buildChange(id, { op: "discard_draft", block: "b3" });
  assert.deepEqual(discarded.blocks, before);
  assert.equal(hoop.markdownOf(id), OUTLINE);
  assert.equal(discarded.drafts, undefined);
  assert.equal(discarded.steps.at(-1)!.what, "discarded Claude's draft under a heading");
  assert.throws(() => hoop.buildChange(id, { op: "discard_draft", block: "b3" }), /no draft of Claude's waiting under block b3/);

  // A newer draft replaces one still waiting; Save puts it in place of the section, with its sources.
  hoop.buildWrite(id, "b3", "First try.");
  hoop.buildWrite(id, "b3", "Second try.", ["d1"]);
  assert.equal(hoop.builds.read(id).drafts!.length, 1);
  const saved = hoop.buildChange(id, { op: "save_draft", block: "b3" });
  assert.equal(
    hoop.markdownOf(id),
    "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\nSecond try.\n\n## Options\n\n## Risks\n",
  );
  const kept = saved.blocks.find((b) => b.text === "Second try.")!;
  assert.deepEqual([kept.by, kept.generated, kept.sources], ["claude", true, ["https://docs.google.com/document/d/costs/edit"]]);
  assert.equal(saved.drafts, undefined);
  // Undo on the heading puts back what was there before the person saved it.
  hoop.buildChange(id, { op: "undo", block: "b3" });
  assert.equal(hoop.markdownOf(id), OUTLINE);
});

test("a draft goes when its heading does, and Save on a draft whose heading is gone is refused", () => {
  const { hoop, id } = started();
  hoop.buildWrite(id, "b5", "Rightsize the servers.");
  hoop.buildChange(id, { op: "remove", block: "b5" });
  assert.equal(hoop.builds.read(id).drafts, undefined);
  assert.throws(() => hoop.buildChange(id, { op: "save_draft", block: "b5" }), /has no block b5/);
});

/** The drafts as the page shows them, which Finish without them sends. */
const shown = (hoop: Hoop, id: string) => (hoop.builds.read(id).drafts ?? []).map((d) => ({ section: d.section, block: d.blocks[0]!.id }));

test("Finish with a draft waiting is refused unless the person chose to finish without the drafts they saw", () => {
  const { hoop, id } = started();
  hoop.buildWrite(id, "b5", "Rightsize the servers.");
  assert.throws(() => hoop.finishBuild(id), /Claude's 1 draft isn't saved: save or discard it, or finish without it/);
  assert.equal(hoop.store.meta(id).build, "open");
  // Claude sends a draft (a new one, or a newer one for the same heading) while the person decides.
  const seen = shown(hoop, id);
  hoop.buildWrite(id, "b6", "Vendor lock-in.");
  assert.throws(() => hoop.finishBuild(id, seen), /Claude sent a draft while you were deciding\. Look at it, then finish again\./);
  const both = shown(hoop, id);
  hoop.buildWrite(id, "b6", "Vendor lock-in, and egress.");
  assert.throws(() => hoop.finishBuild(id, both), /while you were deciding/);
  assert.equal(hoop.store.meta(id).build, "open");
  const done = hoop.finishBuild(id, shown(hoop, id));
  assert.equal(done.outcome, "revised");
  assert.equal(hoop.markdownOf(id), OUTLINE, "the review has the document without the draft");
  assert.equal(hoop.builds.read(id).steps.at(-1)!.what, "finished the build without Claude's 2 drafts");
});

test("Continue writing adds blocks after a section's text, which stays byte-identical; a write that changes one is refused", () => {
  const { hoop, id } = started("# Plan\n\n## Goals\n\nShip it.  \n\n- One\n- Two\n\n### Detail\n\nSub text.\n\n## Empty\n");
  // b1 # Plan, b2 ## Goals, b3 paragraph, b4 list, b5 ### Detail, b6 paragraph, b7 ## Empty
  assert.throws(() => hoop.buildChange(id, { op: "continue", block: "b7" }), /nothing under this heading to continue yet: press Generate/);
  assert.throws(() => hoop.buildChange(id, { op: "continue", block: "b1" }), /press Generate on the heading/);
  hoop.buildChange(id, { op: "continue", block: "b2", note: "add the risks" });
  assert.throws(() => hoop.buildChange(id, { op: "continue", block: "b2" }), /already has this request on the heading; withdraw it to ask again/);
  const [task] = hoop.takeRequests(id);
  assert.deepEqual([task!.kind, task!.section, task!.note], ["continue", "b2", "add the risks"]);
  const original = hoop.builds.read(id).blocks;
  const markdown = hoop.markdownOf(id);

  // Repeating the section's text with a change to one of its blocks is refused.
  assert.throws(
    () => hoop.buildWrite(id, "b2", "Ship it.  \n\n- One\n- Three\n\nNew text."),
    /Continue writing keeps the blocks already under the heading byte-identical, but your text changes block b4/,
  );
  assert.equal(hoop.builds.read(id).drafts, undefined);
  assert.equal(hoop.builds.read(id).requests![0]!.status, "taken", "a refused write leaves the request open");

  // Repeating them unchanged is the same as sending only the new blocks.
  const drafted = hoop.buildWrite(id, "b2", "## Goals\n\nShip it.  \n\n- One\n- Two\n\nThen the risks.");
  assert.deepEqual(drafted.blocks, original);
  assert.deepEqual(
    drafted.drafts!.map((d) => [d.kind, d.blocks.map((b) => b.text)]),
    [["continue", ["Then the risks."]]],
  );
  assert.equal(drafted.requests![0]!.status, "written");
  const saved = hoop.buildChange(id, { op: "save_draft", block: "b2" });
  // The new block goes after the heading's own text, before its subheading; every old block is untouched.
  assert.equal(hoop.markdownOf(id), markdown.replace("- Two\n\n### Detail", "- Two\n\nThen the risks.\n\n### Detail"));
  for (const b of original)
    assert.deepEqual(
      saved.blocks.find((x) => x.id === b.id),
      b,
    );
  assert.equal(saved.steps.at(-1)!.what, "saved Claude's added text under a heading");
});

test("Withdraw and the late-answer refusal apply to Continue writing as to Generate", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "continue", block: "b3" });
  hoop.takeRequests(id);
  const withdrawn = hoop.buildChange(id, { op: "withdraw", request: "g1" });
  assert.equal(withdrawn.steps.at(-1)!.what, "withdrew a request to continue writing under a heading");
  assert.throws(() => hoop.buildWrite(id, "b3", "Late."), /the person withdrew request g1 after you took it/);
  assert.throws(() => hoop.buildWrite(id, "b3", "Late.", undefined, "g1"), /the person withdrew request g1, so it is closed/);
  assert.equal(hoop.builds.read(id).drafts, undefined);
  // With a Generate and a Continue writing both taken on a heading, a write names the one it answers.
  hoop.buildChange(id, { op: "continue", block: "b3" });
  hoop.buildChange(id, { op: "generate", block: "b3" });
  hoop.takeRequests(id);
  assert.throws(() => hoop.buildWrite(id, "b3", "Which?"), /requests g2 and g3 are both taken on block b3: pass request/);
  assert.throws(() => hoop.buildWrite(id, "b3", "Which?", undefined, "g9"), /request g9 isn't a Generate or Continue writing on block b3/);
  const out = run(hoop, "build_write", { review_id: id, section: "b3", request: "g2", markdown: "More." }) as { draft: boolean };
  assert.equal(out.draft, true);
  const build = hoop.builds.read(id);
  assert.deepEqual(
    build.requests!.map((r) => [r.id, r.status]),
    [
      ["g1", "written"],
      ["g2", "written"],
      ["g3", "taken"],
    ],
  );
  assert.equal(build.drafts![0]!.kind, "continue");
});

test("Generate all queues a Generate on exactly the empty headings with no request open and no draft waiting", () => {
  const { hoop, id } = started("# Plan\n\n## Goals\n\nShip it.\n\n## Costs\n\n## Risks\n\n## Team\n\n### Hiring\n\n## Dates\n");
  // b1 # Plan, b2 ## Goals, b3 its text, b4 ## Costs, b5 ## Risks, b6 ## Team (a subheading), b7 ### Hiring, b8 ## Dates
  hoop.buildChange(id, { op: "suggest", block: "b4", kind: "subsections" });
  hoop.buildWrite(id, "b7", "June.");
  const build = hoop.buildChange(id, { op: "generate_all" });
  assert.deepEqual(
    build.requests!.filter((r) => !r.kind).map((r) => [r.id, r.block, r.status]),
    [
      ["g2", "b5", "queued"],
      ["g3", "b8", "queued"],
    ],
  );
  assert.equal(build.steps.at(-1)!.what, "asked Claude to write under 2 headings");
  assert.throws(() => hoop.buildChange(id, { op: "generate_all" }), /Every heading already has text, a draft or a request waiting/);
  // Each is a Generate like any other: Claude takes them all, and one withdrawn frees its heading.
  hoop.buildChange(id, { op: "withdraw", request: "g3" });
  assert.throws(() => hoop.buildChange(id, { op: "generate", block: "b5" }), /already has this request/);
  const tasks = hoop.takeRequests(id);
  assert.deepEqual(
    tasks.map((t) => [t.kind, t.section]),
    [
      ["subsections", "b4"],
      ["write", "b5"],
    ],
  );
  assert.deepEqual(
    hoop
      .buildChange(id, { op: "generate_all" })
      .requests!.filter((r) => r.status === "queued")
      .map((r) => r.block),
    ["b8"],
  );
});

test("each refinement sends one request with its instruction, and a waiting draft rides with a section's request", () => {
  const { hoop, id } = started();
  hoop.buildWrite(id, "b3", "Compute is most of it.");
  hoop.buildChange(id, { op: "save_draft", block: "b3" });
  const block = hoop.builds.read(id).blocks.find((b) => b.text === "Compute is most of it.")!.id;
  for (const refine of ["shorter", "longer", "simpler", "more_detail"] as const) {
    const before = hoop.builds.read(id).requests?.length ?? 0;
    const build = hoop.buildChange(id, { op: "rewrite", block, refine });
    // A newer Generate again replaces the one Claude hasn't taken, so one is queued at a time.
    const queued = build.requests!.filter((r) => r.status === "queued");
    assert.deepEqual(
      queued.map((r) => [r.kind, r.block, r.refine]),
      [["rewrite", block, refine]],
    );
    assert.ok(build.requests!.length <= before + 1);
  }
  const [task] = hoop.takeRequests(id);
  assert.deepEqual([task!.kind, task!.refine, task!.block], ["rewrite", "more_detail", block]);
  assert.throws(
    () => hoop.buildChange(id, { op: "rewrite", block, refine: "funnier" }),
    /a refinement is one of "shorter", "longer", "simpler", "more_detail"/,
  );

  // On a heading, a refinement is a Generate with it; Claude's draft waiting there comes with the request.
  hoop.buildWrite(id, "b5", "Rightsize the servers.\n\n- Spot");
  hoop.buildChange(id, { op: "generate", block: "b5", refine: "shorter", note: "one line" });
  const [write] = hoop.takeRequests(id);
  assert.deepEqual(
    [write!.kind, write!.refine, write!.note, write!.draft_kind, write!.draft_markdown],
    ["write", "shorter", "one line", "write", "Rightsize the servers.\n\n- Spot"],
  );
  assert.throws(() => hoop.buildChange(id, { op: "generate", block: "b6", refine: "louder" }), /a refinement is one of/);
});

test("a refinement of a Continue writing draft refines the added blocks and stays a Continue writing", () => {
  const { hoop, id } = started();
  // b3 ## Where the money goes holds "Old guess."; Claude's Continue writing draft adds to it.
  hoop.buildChange(id, { op: "continue", block: "b3" });
  hoop.takeRequests(id);
  hoop.buildWrite(id, "b3", "It grows every month, and faster in the spring than in the autumn.");
  hoop.buildChange(id, { op: "generate", block: "b3", refine: "shorter" });
  const [task] = hoop.takeRequests(id);
  assert.deepEqual(
    [task!.kind, task!.refine, task!.section_markdown, task!.draft_kind, task!.draft_markdown],
    ["continue", "shorter", "Old guess.", "continue", "It grows every month, and faster in the spring than in the autumn."],
  );
  hoop.buildWrite(id, "b3", "It grows every month.");
  assert.deepEqual(
    hoop.builds.read(id).drafts!.map((d) => [d.kind, d.blocks.map((b) => b.text)]),
    [["continue", ["It grows every month."]]],
  );
  hoop.buildChange(id, { op: "save_draft", block: "b3" });
  assert.match(hoop.markdownOf(id), /## Where the money goes\n\nOld guess\.\n\nIt grows every month\.\n\n## Options/, "the section's text stays");
  // Without a refinement, Generate again is a Generate: it replaces the section.
  hoop.buildChange(id, { op: "continue", block: "b3" });
  hoop.takeRequests(id);
  hoop.buildWrite(id, "b3", "More.");
  assert.equal(hoop.buildChange(id, { op: "generate", block: "b3" }).requests!.at(-1)!.kind, undefined);
});

test("Continue writing is refused while Claude's draft that replaces the section waits", () => {
  const { hoop, id } = started();
  hoop.buildWrite(id, "b3", "A new take on the costs.");
  assert.throws(
    () => hoop.buildChange(id, { op: "continue", block: "b3" }),
    /Claude's draft under this heading replaces everything under it: save or discard it before asking Claude to continue writing/,
  );
  // A refinement of that draft is a Generate, and Continue writing is offered again once it is saved.
  assert.equal(hoop.buildChange(id, { op: "generate", block: "b3", refine: "longer" }).requests!.at(-1)!.kind, undefined);
  hoop.takeRequests(id);
  hoop.buildWrite(id, "b3", "A longer new take on the costs.");
  hoop.buildChange(id, { op: "save_draft", block: "b3" });
  assert.equal(hoop.buildChange(id, { op: "continue", block: "b3" }).requests!.at(-1)!.kind, "continue");
});

test("Continue writing on a heading with subheadings works from its own text, and adds before them", () => {
  const { hoop, id } = started("# Plan\n\n## Goals\n\nShip it.\n\n### Detail\n\nSub text.\n\n## Only\n\n### Child\n\nChild text.\n");
  // b1 # Plan, b2 ## Goals, b3 its text, b4 ### Detail, b5 its text, b6 ## Only, b7 ### Child, b8 its text
  hoop.buildChange(id, { op: "continue", block: "b2" });
  hoop.buildChange(id, { op: "continue", block: "b6" });
  const tasks = hoop.takeRequests(id);
  assert.deepEqual(
    tasks.map((t) => [t.section, t.section_markdown]),
    [
      ["b2", "Ship it."],
      ["b6", ""],
    ],
  );
  // An echo of the whole section repeats its subheading, which is refused rather than duplicated.
  assert.throws(
    () => hoop.buildWrite(id, "b2", "Ship it.\n\nMore to do.\n\n### Detail\n\nSub text."),
    /before its subheadings, but your text repeats the subheading "### Detail"; send only the new blocks/,
  );
  assert.throws(() => hoop.buildWrite(id, "b6", "### Child\n\nChild text.\n\nIntro."), /repeats the subheading "### Child"/);
  hoop.buildWrite(id, "b2", "Ship it.\n\nMore to do.");
  hoop.buildWrite(id, "b6", "Intro.");
  hoop.buildChange(id, { op: "save_draft", block: "b2" });
  hoop.buildChange(id, { op: "save_draft", block: "b6" });
  assert.equal(
    hoop.markdownOf(id),
    "# Plan\n\n## Goals\n\nShip it.\n\nMore to do.\n\n### Detail\n\nSub text.\n\n## Only\n\nIntro.\n\n### Child\n\nChild text.\n",
  );
});

test("on the page, Claude's draft is marked as one; Discard leaves the section and Save puts it in", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    await page.addInitScript(() => Object.assign(window, { HOOP_BUILD_MS: 200 }));
    await page.goto(`${base}/r/${id}`);
    hoop.buildWrite(id, "b3", "Compute is most of it.");
    const draft = page.getByRole("group", { name: "Claude's draft for Heading 1 “Where the money goes”" });
    await draft.waitFor();
    assert.match(
      await draft.innerText(),
      /Draft from Claude\s+Saving it replaces everything under this heading\. Nothing in the document changes until you save it\.\s+Compute is most of it\./,
    );
    assert.equal(await page.locator(".bpara", { hasText: "Old guess." }).count(), 1, "the section's text is still there");
    await page.getByRole("button", { name: "Discard Claude's draft for Heading 1 “Where the money goes”" }).click();
    await draft.waitFor({ state: "detached" });
    assert.equal(hoop.markdownOf(id), OUTLINE);
    assert.ok(await hasFocus(page.getByRole("button", { name: "Generate Heading 1 “Where the money goes”" })));

    hoop.buildWrite(id, "b3", "Compute is most of it.");
    await page.getByRole("button", { name: "Save Claude's draft for Heading 1 “Where the money goes”" }).click();
    await page.locator(".bdraft").waitFor({ state: "detached" });
    await page.locator(".bblock .bpara", { hasText: "Compute is most of it." }).waitFor();
    assert.equal(await page.locator(".bpara", { hasText: "Old guess." }).count(), 0);
    assert.ok(await hasFocus(page.getByRole("button", { name: "Generate again Heading 1 “Where the money goes”" })));
  }),
);

test("on the page, Generate again offers Shorter, Longer, Simpler and More detail, each one press", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    hoop.buildWrite(id, "b3", "Compute is most of it.");
    hoop.buildChange(id, { op: "save_draft", block: "b3" });
    const block = hoop.builds.read(id).blocks.find((b) => b.text === "Compute is most of it.")!.id;
    await page.goto(`${base}/r/${id}`);
    const name = `Paragraph 4`;
    await page.getByRole("button", { name: `Generate again ${name}` }).click();
    await page.getByRole("button", { name: `Generate again ${name}, shorter` }).click();
    await page.locator(".bstatus", { hasText: "Claude writes this again" }).waitFor();
    assert.deepEqual(
      hoop.builds.read(id).requests!.map((r) => [r.kind, r.block, r.refine]),
      [["rewrite", block, "shorter"]],
    );
    // On the heading, Generate again's form offers them too, and sends a Generate with one.
    await page.getByRole("button", { name: "Generate again Heading 1 “Where the money goes”" }).click();
    for (const label of ["shorter", "longer", "simpler", "more detail"])
      await page.getByRole("button", { name: `Generate again Heading 1 “Where the money goes”, ${label}` }).waitFor();
    await page.getByRole("button", { name: "Generate again Heading 1 “Where the money goes”, more detail" }).click();
    await page.getByRole("button", { name: "Generate again Heading 1 “Where the money goes”: pending" }).waitFor();
    assert.deepEqual(
      hoop.builds.read(id).requests!.map((r) => [r.kind ?? "write", r.refine]),
      [
        ["rewrite", "shorter"],
        ["write", "more_detail"],
      ],
    );
  }),
);

test("on the page, Generate all and Continue writing ask Claude, and Finish asks first while a draft waits", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    await page.addInitScript(() => Object.assign(window, { HOOP_BUILD_MS: 200 }));
    await page.goto(`${base}/r/${id}`);
    // Generate all, on the title, writes the two empty headings.
    await page.getByRole("button", { name: "Generate all: write 2 empty headings" }).click();
    await page.getByRole("button", { name: "Generate Heading 1 “Risks”: pending" }).waitFor();
    assert.deepEqual(
      hoop.builds.read(id).requests!.map((r) => r.block),
      ["b5", "b6"],
    );
    assert.equal(await page.locator("[data-b-gen-all]").count(), 0, "none is left to write");
    assert.ok(await hasFocus(page.getByRole("button", { name: "Suggest an outline for Title “Cutting cloud cost”" })));

    // Continue writing on a heading with text asks for more after it.
    await page.getByRole("button", { name: "Continue writing for Heading 1 “Where the money goes”" }).click();
    await page.getByLabel("Notes for Claude (optional)").fill("add the trend");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Continue writing for Heading 1 “Where the money goes”: pending" }).waitFor();
    assert.ok(await hasFocus(page.getByRole("button", { name: "Withdraw Continue writing on Heading 1 “Where the money goes”" })));
    const tasks = hoop.takeRequests(id);
    assert.deepEqual(
      tasks.map((t) => [t.kind, t.section, t.note]),
      [
        ["write", "b5", undefined],
        ["write", "b6", undefined],
        ["continue", "b3", "add the trend"],
      ],
    );
    hoop.buildWrite(id, "b3", "It grows 5% a month.");
    const draft = page.getByRole("group", { name: "Claude's draft for Heading 1 “Where the money goes”" });
    await draft.waitFor();
    assert.match(await draft.innerText(), /Saving it adds this after the text under this heading\./);

    // Finish asks first; Cancel and Escape put focus back on Finish, and the build stays.
    await page.getByRole("button", { name: "Finish and review", exact: true }).click();
    const ask = page.locator(".bconfirm");
    assert.equal(await ask.locator("#finishAsk").innerText(), "Claude has a draft you haven't saved. Finish without it?");
    assert.ok(await hasFocus(page.getByRole("button", { name: "Finish without drafts" })));
    await page.keyboard.press("Escape");
    await ask.waitFor({ state: "detached" });
    assert.ok(await hasFocus(page.locator("#finishBuild")));
    await page.locator("#finishBuild").click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await ask.waitFor({ state: "detached" });
    assert.equal(hoop.store.meta(id).build, "open");
    await page.locator("#finishBuild").click();
    await page.getByRole("button", { name: "Finish without drafts" }).click();
    await page.locator("#finishBtn").waitFor();
    assert.equal(hoop.markdownOf(id), OUTLINE);
  }),
);

test("on the page, a Continue writing draft sits where saving puts it, and the refinements say they send at once with the note", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild("# Plan\n\n## Goals\n\nShip it.\n\n### Detail\n\nSub text.\n");
    hoop.buildChange(id, { op: "continue", block: "b2" });
    hoop.takeRequests(id);
    hoop.buildWrite(id, "b2", "More to do.");
    await page.goto(`${base}/r/${id}`);
    // After the heading's own text, before its subheading.
    const order = await page
      .locator(".bdraft")
      .evaluate((el) => [
        el.compareDocumentPosition(document.querySelector('[data-block="b3"]')!),
        el.compareDocumentPosition(document.querySelector('[data-section="b4"]')!),
      ]);
    assert.deepEqual(order, [2, 4], "the heading's text precedes it, and its subheading follows");
    // Folded, it shows under the heading instead, so it isn't hidden.
    await page.getByRole("button", { name: "Collapse Heading 1 “Goals”" }).click();
    await page.locator(".bsec-head .bdraft").waitFor();
    await page.getByRole("button", { name: "Expand Heading 1 “Goals”" }).click();

    await page.getByRole("button", { name: "Generate again Heading 1 “Goals”" }).click();
    const refine = page.getByRole("group", { name: "Or ask for one of these now; your note goes with it:" });
    await refine.waitFor();
    assert.equal(await refine.getByRole("button").count(), 4);
    await page.getByLabel("Note for Claude on Heading 1 “Goals” (optional)").fill("keep the numbers");
    await page.getByRole("button", { name: "Generate again Heading 1 “Goals”, shorter" }).click();
    // It refines the added blocks, so it is a Continue writing.
    await page.getByRole("button", { name: "Continue writing for Heading 1 “Goals”: pending" }).waitFor();
    assert.deepEqual(
      hoop.builds.read(id).requests!.map((r) => [r.kind, r.refine, r.note]),
      [
        ["continue", undefined, undefined],
        ["continue", "shorter", "keep the numbers"],
      ],
    );
  }),
);

test("on the page, a draft Claude sends while Finish asks is shown, and Finish asks again before leaving it out", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    hoop.buildWrite(id, "b5", "Rightsize the servers.");
    await page.goto(`${base}/r/${id}`);
    await page.locator("#finishBuild").click();
    await page.locator(".bconfirm").waitFor();
    hoop.buildWrite(id, "b6", "Vendor lock-in.");
    await page.getByRole("button", { name: "Finish without drafts" }).click();
    await page.locator("#finishErr", { hasText: "Claude sent a draft while you were deciding. Look at it, then finish again." }).waitFor();
    assert.equal(await page.locator("#finishAsk").innerText(), "Claude has 2 drafts you haven't saved. Finish without them?");
    await page.getByRole("group", { name: "Claude's draft for Heading 1 “Risks”" }).waitFor();
    assert.ok(await hasFocus(page.getByRole("button", { name: "Finish without drafts" })));
    assert.equal(hoop.store.meta(id).build, "open");
    await page.getByRole("button", { name: "Finish without drafts" }).click();
    await page.locator("#finishBtn").waitFor();
    assert.equal(hoop.markdownOf(id), OUTLINE);
  }),
);
