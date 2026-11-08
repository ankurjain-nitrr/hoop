import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { CONTEXT_MAX } from "../src/build-context.js";
import { Hoop } from "../src/hoop.js";
import { checkInput, OPS } from "../src/ops.js";
import type { HoopError } from "../src/util.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { BROWSER_SKIP, tempHome, withBrowser, writeSaved, runOp } from "./helpers.js";

// What Claude writes a build from (#349): the context documents the person lists and their brief
// ride on every request Claude takes; Claude marks a document it can't open and names the ones it
// drew from; hoop keeps only the list.

// b1 # Cutting cloud cost, b2 paragraph, b3 ## Where the money goes, b4 paragraph, b5 ## Options
const OUTLINE = "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\nOld guess.\n\n## Options\n";
const DOC = "https://docs.google.com/document/d/abc123/edit";
const FILE = "/Users/ana/notes/costs.md";
function started() {
  const hoop = new Hoop(new Store(tempHome()));
  return { hoop, id: hoop.startBuild(OUTLINE).review_id };
}

const docs = (hoop: Hoop, id: string) => (hoop.builds.read(id).context ?? []).map((d) => [d.id, d.ref]);

test("every kind of request carries the context documents in the person's order, and the brief", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "context_add", ref: DOC });
  hoop.buildChange(id, { op: "context_add", ref: `  ${FILE}  ` });
  hoop.buildChange(id, { op: "context_add", ref: "~/plan.txt" });
  hoop.buildChange(id, { op: "brief", audience: "Executives", tone: "plain", length: "one page", notes: "Cite numbers." });
  writeSaved(hoop, id, "b3", "Compute is most of it.");
  hoop.buildChange(id, { op: "generate", block: "b5" });
  hoop.buildChange(id, { op: "suggest", block: "b1", kind: "outline" });
  hoop.buildChange(id, { op: "rewrite", block: "b6" });
  hoop.buildChange(id, { op: "comment", block: "b6", comment: "Shorter." });
  const tasks = hoop.takeRequests(id);
  assert.deepEqual(
    tasks.map((t) => t.kind),
    ["write", "outline", "rewrite", "revise"],
  );
  const context = [
    { id: "d1", ref: DOC, kind: "link" },
    { id: "d2", ref: FILE, kind: "file" },
    { id: "d3", ref: "~/plan.txt", kind: "file" },
  ];
  for (const t of tasks) {
    assert.deepEqual(t.context, context);
    assert.deepEqual(t.brief, { audience: "Executives", tone: "plain", length: "one page", notes: "Cite numbers." });
  }
  // hoop keeps only the list: the build holds the links and paths, nothing read from them.
  assert.deepEqual(docs(hoop, id), [
    ["d1", DOC],
    ["d2", FILE],
    ["d3", "~/plan.txt"],
  ]);
});

test("a build with no documents and no brief sends requests without them", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "generate", block: "b3" });
  const [task] = hoop.takeRequests(id);
  assert.equal(task!.context, undefined);
  assert.equal(task!.brief, undefined);
});

test("removing a document keeps the others in order, and a new one goes last with a new ID", () => {
  const { hoop, id } = started();
  for (const ref of [DOC, FILE, "https://example.com/a"]) hoop.buildChange(id, { op: "context_add", ref });
  hoop.buildChange(id, { op: "context_remove", doc: "d2" });
  hoop.buildChange(id, { op: "context_add", ref: "/tmp/b.md" });
  assert.deepEqual(docs(hoop, id), [
    ["d1", DOC],
    ["d3", "https://example.com/a"],
    ["d4", "/tmp/b.md"],
  ]);
  // Removing the last one never gives its ID to the next.
  hoop.buildChange(id, { op: "context_remove", doc: "d4" });
  hoop.buildChange(id, { op: "context_add", ref: "/tmp/c.md" });
  assert.deepEqual(docs(hoop, id).at(-1), ["d5", "/tmp/c.md"]);
  assert.throws(() => hoop.buildChange(id, { op: "context_remove", doc: "d9" }), /"d9" isn't one of the build's context documents/);
  const steps = hoop.builds.read(id).steps.map((s) => s.what);
  assert.ok(steps.includes("added a context document") && steps.includes("removed a context document"));
});

test("editing the list or the brief changes only the requests Claude takes later", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "context_add", ref: DOC });
  hoop.buildChange(id, { op: "brief", audience: "Engineers" });
  hoop.buildChange(id, { op: "generate", block: "b3" });
  const [first] = hoop.takeRequests(id);
  const sent = structuredClone(first);
  hoop.buildChange(id, { op: "context_remove", doc: "d1" });
  hoop.buildChange(id, { op: "context_add", ref: FILE });
  hoop.buildChange(id, { op: "brief", audience: "Executives" });
  // What Claude already took stays as it was; nothing is sent again for it.
  assert.deepEqual(first, sent);
  assert.deepEqual(hoop.takeRequests(id), []);
  hoop.buildChange(id, { op: "generate", block: "b5" });
  const [later] = hoop.takeRequests(id);
  assert.deepEqual(later!.context, [{ id: "d2", ref: FILE, kind: "file" }]);
  assert.deepEqual(later!.brief, { audience: "Executives" });
  assert.deepEqual(first!.context, [{ id: "d1", ref: DOC, kind: "link" }]);
});

test("a document is an http(s) link or a full file path, one line, not too long, listed once, and at most twenty", () => {
  const { hoop, id } = started();
  const add = (ref: string) => hoop.buildChange(id, { op: "context_add", ref });
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>", "ftp://x/y", "https://"])
    assert.throws(
      () => add(bad),
      { message: `“${bad}” isn't a link or a full file path. Use a link that starts with https://, or a path such as ~/notes.md.` },
      bad,
    );
  // The error says what went wrong and what to do, in a sentence, quoting the input cut short.
  assert.throws(() => add("notes.md"), {
    message: "“notes.md” isn't a link or a full file path. Use a link that starts with https://, or a path such as ~/notes.md.",
  });
  assert.throws(() => add(`notes-${"x".repeat(100)}`), {
    message: `“notes-${"x".repeat(53)}…” isn't a link or a full file path. Use a link that starts with https://, or a path such as ~/notes.md.`,
  });
  assert.throws(() => add("   "), { message: "Type a link or a full file path first." });
  assert.throws(() => add("/a\nb"), { message: "A link or path is one line. Paste it without line breaks." });
  assert.throws(() => add(`https://example.com/${"x".repeat(2000)}`), { message: "That link or path is over 2000 characters. Use a shorter link." });
  add(DOC);
  assert.throws(() => add(DOC), { message: `“${DOC}” is already in the list.` });
  for (let n = 1; n < CONTEXT_MAX; n++) add(`/tmp/doc-${n}.md`);
  assert.throws(() => add("/tmp/one-more.md"), { message: "The list holds at most 20 documents. Remove one first." });
  assert.equal(hoop.builds.read(id).context!.length, CONTEXT_MAX);
});

test("the brief: fields are trimmed and capped, an emptied field is cleared, and saving it unchanged is no step", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "brief", audience: "  Executives ", tone: "" });
  assert.deepEqual(hoop.builds.read(id).brief, { audience: "Executives" });
  const version = hoop.builds.read(id).version;
  hoop.buildChange(id, { op: "brief", audience: "Executives" });
  assert.equal(hoop.builds.read(id).version, version);
  assert.throws(() => hoop.buildChange(id, { op: "brief", tone: "x".repeat(201) }), { message: "Tone is over 200 characters. Shorten it." });
  assert.throws(() => hoop.buildChange(id, { op: "brief", notes: "x".repeat(2001) }), { message: "Anything else is over 2000 characters. Shorten it." });
  assert.throws(() => hoop.buildChange(id, { op: "brief", audience: 3 } as never), /expected audience/);
  hoop.buildChange(id, { op: "brief", audience: "" });
  assert.equal(hoop.builds.read(id).brief, undefined);
  assert.equal(hoop.builds.read(id).steps.at(-1)!.what, "cleared the brief");
});

test("Claude marks a document it can't open: later requests and the page carry the reason, and only the build's session may", async () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "context_add", ref: DOC });
  hoop.buildChange(id, { op: "context_add", ref: FILE });
  const out = runOp(hoop, "build_unreadable", { review_id: id, document: "d1", reason: "  No access:\n the doc isn't shared  " }) as {
    context: { id: string; unreadable?: string }[];
  };
  assert.deepEqual(
    out.context.map((d) => [d.id, d.unreadable]),
    [
      ["d1", "No access: the doc isn't shared"],
      ["d2", undefined],
    ],
  );
  assert.equal(hoop.builds.read(id).steps.at(-1)!.by, "claude");
  assert.throws(() => runOp(hoop, "build_unreadable", { review_id: id, document: "d7", reason: "gone" }), /"d7" isn't one of/);
  assert.throws(() => runOp(hoop, "build_unreadable", { review_id: id, document: "d2", reason: "   " }), /say why/);
  assert.throws(() => runOp(hoop, "build_unreadable", { review_id: id, document: "d2", reason: "x".repeat(501) }), /at most 500/);
  const other = new Hoop(hoop.store, "other-session-1111");
  assert.throws(() => other.buildUnreadable(id, "d2", "no"), /Only the session that submitted/);
  hoop.buildChange(id, { op: "generate", block: "b3" });
  const [task] = hoop.takeRequests(id);
  assert.equal(task!.context![0]!.unreadable, "No access: the doc isn't shared");
  // Generate still completes from the rest.
  writeSaved(hoop, id, "b3", "From the notes.", ["d2"]);
  assert.equal(hoop.builds.read(id).requests![0]!.status, "written");
  assert.ok(hoop.builds.read(id).context![0]!.unreadable, "a write that didn't use it leaves the mark");
});

test("an unreadable document stays listed with its reason on every later request until a write uses it", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "context_add", ref: DOC });
  hoop.buildUnreadable(id, DOC, "No access");
  // Adding it again is a duplicate like any other; the person fixes access, and Claude tries again.
  assert.throws(() => hoop.buildChange(id, { op: "context_add", ref: DOC }), /is already in the list/);
  for (const block of ["b3", "b5"]) {
    hoop.buildChange(id, { op: "generate", block });
    const [task] = hoop.takeRequests(id);
    assert.deepEqual(task!.context, [{ id: "d1", ref: DOC, kind: "link", unreadable: "No access" }]);
    if (block === "b3") writeSaved(hoop, id, block, "Without it.");
  }
  writeSaved(hoop, id, "b5", "Shared now.", ["d1"]);
  assert.deepEqual(hoop.builds.read(id).context, [{ id: "d1", ref: DOC }]);
});

test("a write names the documents it drew from; one not in the list is refused, and one that used none carries nothing", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "context_add", ref: DOC });
  hoop.buildChange(id, { op: "context_add", ref: FILE });
  hoop.buildChange(id, { op: "generate", block: "b3" });
  hoop.takeRequests(id);
  const before = hoop.markdownOf(id);
  assert.throws(
    () => runOp(hoop, "build_write", { review_id: id, section: "b3", markdown: "Text.", used: ["d1", "d9"] }),
    /"d9" isn't in the build's context list \(d1, d2\); name only documents from the request's context/,
  );
  assert.equal(hoop.markdownOf(id), before, "a refused write changes nothing");
  runOp(hoop, "build_write", { review_id: id, section: "b3", markdown: "Compute.\n\n- Servers", used: ["d2", "d1", "d2"] });
  // The sources ride on Claude's draft, and go with it into the document when the person saves it.
  assert.deepEqual(
    hoop.builds.read(id).drafts![0]!.blocks.map((b) => b.sources),
    [
      [FILE, DOC],
      [FILE, DOC],
    ],
  );
  hoop.buildChange(id, { op: "save_draft", block: "b3" });
  const written = hoop.builds.read(id).blocks.filter((b) => b.generated);
  assert.deepEqual(
    written.map((b) => b.sources),
    [
      [FILE, DOC],
      [FILE, DOC],
    ],
  );
  // A block written again draws from its own documents.
  hoop.buildChange(id, { op: "rewrite", block: written[0]!.id });
  hoop.takeRequests(id);
  runOp(hoop, "build_write", { review_id: id, block: written[0]!.id, markdown: "Mostly compute.", used: [DOC] });
  hoop.buildChange(id, { op: "generate", block: "b5" });
  hoop.takeRequests(id);
  runOp(hoop, "build_write", { review_id: id, section: "b5", markdown: "Cut idle servers." });
  hoop.buildChange(id, { op: "save_draft", block: "b5" });
  const blocks = hoop.builds.read(id).blocks;
  assert.deepEqual(blocks.find((b) => b.text === "Mostly compute.")!.sources, [DOC]);
  assert.equal(blocks.find((b) => b.text === "Cut idle servers.")!.sources, undefined);
  // The person's edit makes the block theirs, and it no longer claims Claude's sources.
  const mine = blocks.find((b) => b.text === "- Servers")!;
  hoop.buildChange(id, { op: "edit", block: mine.id, text: "- Servers, mostly" });
  assert.equal(hoop.builds.read(id).blocks.find((b) => b.id === mine.id)!.sources, undefined);
  // Removing a document from the list keeps what Claude already wrote from it.
  hoop.buildChange(id, { op: "context_remove", doc: "d1" });
  assert.deepEqual(hoop.builds.read(id).blocks.find((b) => b.text === "Mostly compute.")!.sources, [DOC]);
  // A document the person removed after Claude took the request is named as removed, so Claude writes without it.
  hoop.buildChange(id, { op: "generate", block: "b5" });
  hoop.takeRequests(id);
  assert.throws(() => runOp(hoop, "build_write", { review_id: id, section: "b5", markdown: "Again.", used: ["d1"] }), {
    message: "document d1 is no longer in the build's context list: the person removed it, so write without it and leave it out of used",
  });
  const write = OPS.find((o) => o.name === "build_write")!;
  assert.throws(
    () => checkInput(write, { review_id: id, section: "b5", markdown: "X.", used: Array.from({ length: CONTEXT_MAX + 1 }, () => "d2") }),
    (e: HoopError) => e.errors?.[0]?.path === "used",
  );
});

test("the terminal commands take --used and mark a document unreadable", () => {
  const op = (name: string) => OPS.find((o) => o.name === name)!.cli!;
  const file = join(tempHome(), "s.md");
  writeFileSync(file, "Text.");
  assert.deepEqual(op("build_write").parse({ pos: ["rv_x", "b3", file], flags: { used: "d2" }, lists: { used: ["d1", "d2"] } }), {
    review_id: "rv_x",
    section: "b3",
    used: ["d1", "d2"],
    markdown: "Text.",
  });
  assert.deepEqual(op("build_unreadable").parse({ pos: ["rv_x", "d1", "No", "access"], flags: {} }), {
    review_id: "rv_x",
    document: "d1",
    reason: "No access",
  });
});

test("the page's API takes the list and the brief, refuses a bad one, and the view shows them", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop, [], { sessions: () => [] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (id: string, body: unknown) =>
    fetch(`${base}/api/reviews/${id}/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
      async (r) => ({
        status: r.status,
        body: await r.json(),
      }),
    );
  try {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    assert.equal((await post(id, { op: "context_add", ref: DOC })).status, 201);
    const bad = await post(id, { op: "context_add", ref: "javascript:alert(1)" });
    assert.equal(bad.status, 400);
    assert.equal((await post(id, { op: "context_add" })).status, 400);
    const view = await post(id, { op: "brief", audience: "Executives" });
    assert.deepEqual(view.body.context, [{ id: "d1", ref: DOC }]);
    assert.deepEqual(view.body.brief, { audience: "Executives" });
    // Changing the list asks Claude for nothing, so it wakes no session.
    assert.deepEqual(hoop.builds.read(id).requests ?? [], []);
  } finally {
    server.close();
  }
});

test(
  "on the page, the person adds and removes documents and edits the brief; Claude's reason and sources show, and only http(s) links are links",
  { skip: BROWSER_SKIP },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const { review_id: id } = hoop.startBuild(OUTLINE);
      hoop.buildChange(id, { op: "context_add", ref: FILE });
      hoop.buildChange(id, { op: "generate", block: "b3" });
      hoop.takeRequests(id);
      writeSaved(hoop, id, "b3", "Compute is most of it.", ["d1"]);
      await page.addInitScript(() => Object.assign(window, { HOOP_BUILD_MS: 200 }));
      await page.goto(`${base}/r/${id}`);
      const panel = page.locator(".bctx");
      await panel.waitFor();
      // A path is text, never a link.
      assert.equal(await panel.locator(".bpath").innerText(), FILE);
      assert.equal(await panel.locator("a").count(), 0);
      const sources = page.locator('[data-block="b3"] .bsources');
      assert.equal(await sources.innerText(), `Claude wrote this from ${FILE}`);
      assert.equal(await sources.locator("a").count(), 0);

      // Add a link from the keyboard.
      await page.getByLabel("Link or file path").fill(DOC);
      await page.keyboard.press("Enter");
      const link = panel.locator(`a[href="${DOC}"]`);
      await link.waitFor();
      assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
      assert.equal(await link.getAttribute("target"), "_blank");
      assert.equal(await page.getByLabel("Link or file path").inputValue(), "");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "bctx-in");
      // A refused one keeps its text, with the reason under the field.
      await page.getByLabel("Link or file path").fill("javascript:alert(1)");
      await page.keyboard.press("Enter");
      await page
        .locator("#bctx-err", {
          hasText: "“javascript:alert(1)” isn't a link or a full file path. Use a link that starts with https://, or a path such as ~/notes.md.",
        })
        .waitFor();
      assert.equal(await page.getByLabel("Link or file path").inputValue(), "javascript:alert(1)");
      assert.equal(await panel.locator("a").count(), 1);
      await page.keyboard.press("Escape");
      assert.equal(await page.getByLabel("Link or file path").inputValue(), "");

      // Claude can't open the link: its reason shows beside it, without a reload, with Remove and no other button.
      hoop.buildUnreadable(id, "d2", "No access: the doc isn't shared with me");
      const bad = panel.locator(".bctx-doc.unreadable .bctx-bad");
      await bad.waitFor();
      assert.match(await bad.innerText(), /^Claude \S.* couldn't open it: No access: the doc isn't shared with me\. Claude tries again with each request\.$/);
      assert.deepEqual(await panel.locator(".bctx-doc.unreadable button").allInnerTexts(), ["Remove"]);
      // Once a write uses it, the reason goes.
      hoop.buildChange(id, { op: "generate", block: "b5" });
      hoop.takeRequests(id);
      writeSaved(hoop, id, "b5", "Shared now.", ["d2"]);
      await panel.locator(".bctx-doc.unreadable").waitFor({ state: "detached" });

      // Remove from the keyboard: focus goes to the next document's Remove, then to the field.
      await page.getByRole("button", { name: `Remove ${FILE}` }).focus();
      await page.keyboard.press("Enter");
      await page.locator(".bctx-doc").first().locator(".bref", { hasText: DOC }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), `Remove ${DOC}`);
      await page.keyboard.press("Enter");
      await panel.locator(".bctx-list").waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => document.activeElement?.id), "bctx-in");
      assert.deepEqual(hoop.builds.read(id).context, []);
      // What Claude already wrote still names its source.
      assert.equal(await sources.innerText(), `Claude wrote this from ${FILE}`);

      // The brief: open, fill, save with Mod+Enter in its free text.
      await page.getByRole("button", { name: "Add a brief" }).click();
      assert.equal(await page.evaluate(() => document.activeElement?.id), "bb-audience");
      await page.keyboard.type("Executives");
      await page.getByLabel("Anything else").fill("Cite numbers.");
      await page.keyboard.press("Control+Enter");
      await page.locator(".bbrief").waitFor();
      assert.deepEqual(hoop.builds.read(id).brief, { audience: "Executives", notes: "Cite numbers." });
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Edit brief");
      // Escape closes it without saving.
      await page.keyboard.press("Enter");
      await page.getByLabel("Audience").fill("Engineers");
      await page.keyboard.press("Escape");
      await page.locator(".bbrief-form").waitFor({ state: "detached" });
      assert.deepEqual(hoop.builds.read(id).brief, { audience: "Executives", notes: "Cite numbers." });
    }),
);

test(
  "a refused Remove of a document shows under it, and goes once Remove works, though a block is open in Edit (DESIGN-LANGUAGE.md, Errors)",
  { skip: BROWSER_SKIP },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const { review_id: id } = hoop.startBuild(OUTLINE);
      hoop.buildChange(id, { op: "context_add", ref: FILE });
      await page.goto(`${base}/r/${id}`);
      await page.locator('[data-b-edit="b2"]').click();
      await page.locator("#bt-b2").waitFor();
      await page.route("**/api/reviews/*/build", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "The pages are busy." }) })
          : route.fallback(),
      );
      const remove = page.getByRole("button", { name: `Remove ${FILE}` });
      await remove.click();
      const error = page.locator(".berr[role=alert]", { hasText: "The pages are busy." });
      await page.locator(".bctx-doc .berr", { hasText: "The pages are busy." }).waitFor();
      await page.unroute("**/api/reviews/*/build");
      await remove.click();
      await page.locator(".bctx-list").waitFor({ state: "detached" });
      assert.equal(await error.count(), 0, "the earlier refusal goes with the Remove that worked");
    }),
);
