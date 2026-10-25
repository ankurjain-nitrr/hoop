import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { readdirSync, readFileSync } from "node:fs";
import { removalProblem, sectionItems } from "../src/contract.js";
import { exportMarkdown, highestSection, JOIN, parseMarkdown } from "../src/markdown.js";
import { OPS } from "../src/ops.js";
import { applySectionEdits, type SectionEdit } from "../src/section-edits.js";
import { tempHome } from "./helpers.js";

const MD = [
  "# Billing migration",
  "",
  "*Q4 plan*",
  "",
  "We move billing to the new ledger.",
  "",
  "## Plan",
  "",
  "Move accounts in batches,",
  "smallest first.",
  "",
  "### Batches",
  "",
  "- Small accounts first",
  "- Large accounts last",
  "",
  "## Risks",
  "",
  "Double charges.",
  "",
  "## Notes",
  "",
  "First note.",
  "",
  "## Notes",
  "",
  "Second note.",
  "",
  "## Rollout",
  "",
  "One region at a time.",
  "",
].join("\n");

const setup = () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(parseMarkdown(MD));
  const doc = hoop.store.revision(review_id);
  const id = (title: string, n = 0) => doc.items.filter((i) => i.title === title)[n]!.id;
  const md = () => exportMarkdown(hoop.store.revision(review_id));
  const revise = (edits: SectionEdit[], base = 1) => hoop.reviseSections(review_id, base, edits);
  return { hoop, review_id, id, md, revise };
};

test("section edits make one revision; every other section keeps its exact text and its ID", () => {
  const { hoop, review_id, id, md, revise } = setup();
  const ids = hoop.store.revision(review_id).items.map((i) => i.id);
  const res = revise([
    { op: "replace_section", section: id("Risks"), markdown: "Double charges.\n\n- Refund within a day" },
    { op: "replace_text", section: id("Plan"), find: "batches,\nsmallest", replace: "batches of 500,\nsmallest" },
    { op: "insert_section", section: id("Plan"), title: "Owners", markdown: "Billing team." },
    { op: "delete_section", section: id("Notes", 0) },
  ]);
  assert.equal(res.outcome, "revised");
  assert.equal(res.revision, 2);
  const expected = MD.replace("Double charges.\n", "Double charges.\n\n- Refund within a day\n")
    .replace("batches,", "batches of 500,")
    .replace("## Risks", "## Owners\n\nBilling team.\n\n## Risks")
    .replace("## Notes\n\nFirst note.\n\n", "");
  assert.equal(md(), expected);
  const after = hoop.store.revision(review_id).items;
  // The second "Notes" keeps its own ID, though the first one with that heading is gone.
  assert.equal(after.find((i) => i.title === "Notes")!.id, id("Notes", 1));
  assert.deepEqual(
    after.filter((i) => i.title !== "Owners").map((i) => i.id),
    ids.filter((i) => i !== id("Notes", 0)),
  );
  assert.ok(!ids.includes(after.find((i) => i.title === "Owners")!.id), "a new section gets a new ID");
  assert.equal(hoop.store.revision(review_id).subtitle, "Q4 plan");
  const c = res.changes!;
  assert.deepEqual(c.modified.map((m) => m.title).sort(), ["Plan", "Risks"]);
  assert.deepEqual(
    c.added.map((m) => m.title),
    ["Owners"],
  );
  assert.deepEqual(
    c.removed.map((m) => m.section),
    [id("Notes", 0)],
  );
});

test("any edit that fails applies none of them", () => {
  const { hoop, review_id, id, md, revise } = setup();
  const failing: [SectionEdit, RegExp][] = [
    [{ op: "replace_section", section: "S-99", markdown: "x" }, /edit 2 \(replace_section S-99\).*no section S-99/],
    [{ op: "replace_text", section: id("Rollout"), find: "nowhere", replace: "x" }, /doesn't occur/],
    [{ op: "replace_text", section: id("Batches"), find: "accounts", replace: "x" }, /occurs 2 times/],
    [{ op: "replace_section", section: id("Rollout"), markdown: "Text.\n\n## Sneaky heading\n\nMore." }, /heading/],
    [{ op: "replace_section", section: id("Rollout"), markdown: "Text\n---" }, /heading/],
    [{ op: "replace_section", section: id("Risks"), markdown: "```js\nopen fence" }, /code block with no closing ``` line/],
    // In the last section an open fence swallows nothing, so only the fence check catches it.
    [{ op: "replace_section", section: id("Rollout"), markdown: "~~~\nopen fence" }, /code block with no closing ~~~ line/],
    [{ op: "delete_section", section: id("Introduction") }, /only a document's section with a heading/],
    [{ op: "replace_section", section: id("Introduction"), markdown: "" }, /the introduction can't be empty/],
    [{ op: "replace_text", section: id("Introduction"), find: "We move billing to the new ledger.", replace: "" }, /the introduction can't be empty/],
    [{ op: "replace_section", section: id("Introduction"), title: "Intro" }, /no heading to rename/],
    [{ op: "insert_section", section: id("Plan"), title: "Two\nlines" }, /one line/],
    [{ op: "insert_section", section: id("Plan"), title: " ## " }, /one line/],
    [{ op: "replace_section", section: id("Plan") }, /needs markdown, title or both/],
    [{ op: "replace_section", section: id("Plan"), markdown: "x", level: 3 }, /replace_section doesn't take level/],
    [{ op: "replace_text", section: id("Plan"), find: "Move", replace: "Shift", title: "New" }, /replace_text doesn't take title/],
    [{ op: "delete_section", section: id("Risks"), markdown: "x" }, /delete_section doesn't take markdown/],
  ];
  for (const [bad, why] of failing) {
    assert.throws(() => revise([{ op: "replace_section", section: id("Plan"), markdown: "Changed." }, bad]), why);
    assert.equal(hoop.store.meta(review_id).revisions, 1);
    assert.equal(md(), MD);
  }
});

test("section edits on a stale base_revision, or over unread feedback, are refused", () => {
  const { hoop, review_id, id, revise } = setup();
  revise([{ op: "replace_text", section: id("Rollout"), find: "One", replace: "Each" }]);
  assert.throws(() => revise([{ op: "replace_text", section: id("Risks"), find: "Double", replace: "Duplicate" }], 1), /builds on revision 1, but revision 2/);
  hoop.review(review_id, { verdict: "comment", comments: [{ item: id("Risks"), line: 1, body: "Which ones?" }] });
  assert.throws(
    () => revise([{ op: "replace_text", section: id("Risks"), find: "Double", replace: "Duplicate" }], 2),
    (err: Error & { detail?: { unread: unknown[] } }) => /hadn't read/.test(err.message) && err.detail!.unread.length === 1,
  );
  // The refusal handed the feedback over, so the same edits go through now.
  assert.equal(revise([{ op: "replace_text", section: id("Risks"), find: "Double", replace: "Duplicate" }], 2).revision, 3);
});

test("insert_section goes after the section's subsections; renaming keeps the ID; deleting the end ends on text", () => {
  const { hoop, review_id, id, md, revise } = setup();
  revise([
    { op: "insert_section", section: id("Plan"), title: "Budget", markdown: "Small." },
    { op: "insert_section", section: id("Rollout"), title: "After", level: 3 },
    { op: "replace_section", section: id("Risks"), title: "Dangers", markdown: "Double charges." },
  ]);
  const titles = () => hoop.store.revision(review_id).items.map((i) => `${i.level}:${i.title}`);
  assert.deepEqual(titles(), ["0:Introduction", "2:Plan", "3:Batches", "2:Budget", "2:Dangers", "2:Notes", "2:Notes", "2:Rollout", "3:After"]);
  assert.ok(md().endsWith("One region at a time.\n\n### After\n"));
  assert.equal(hoop.store.revision(review_id).items.find((i) => i.title === "Dangers")!.id, id("Risks"));
  assert.deepEqual(hoop.store.renamed(review_id), { [id("Risks")]: "Risks" });
  const after = hoop.store.revision(review_id).items.find((i) => i.title === "After")!.id;
  revise([{ op: "delete_section", section: id("Rollout") }], 2);
  assert.ok(md().endsWith("Second note.\n"), JSON.stringify(md().slice(-30)));
  assert.ok(!hoop.store.revision(review_id).items.some((i) => i.id === after), "the nested section went with it");
});

test("regression: inserts after one section keep their order, and a deeper one goes after the section's subsections", () => {
  const { hoop, review_id, id, revise } = setup();
  revise([
    { op: "insert_section", section: id("Plan"), title: "N1", markdown: "One." },
    { op: "insert_section", section: id("Plan"), title: "N2", markdown: "Two." },
    { op: "insert_section", section: id("Plan"), title: "Deep", level: 3, markdown: "Three." },
    { op: "insert_section", section: id("Introduction"), title: "Lead", markdown: "First." },
    { op: "insert_section", section: id("Introduction"), title: "Lead 2", markdown: "Second." },
  ]);
  const titles = hoop.store.revision(review_id).items.map((i) => `${i.level}:${i.title}`);
  assert.deepEqual(titles.slice(0, 8), ["0:Introduction", "2:Lead", "2:Lead 2", "2:Plan", "3:Batches", "2:N1", "2:N2", "3:Deep"]);
});

test("regression: a new section never takes the ID of one a revision deleted, so old comments stay off it", () => {
  const { hoop, review_id, id, revise } = setup();
  const rollout = id("Rollout");
  hoop.review(review_id, { verdict: "comment", comments: [{ item: rollout, line: 1, body: "Which region first?" }] });
  hoop.receive(review_id);
  revise([{ op: "delete_section", section: rollout }]);
  const res = revise([{ op: "insert_section", section: id("Risks"), title: "Later", markdown: "Something new." }], 2);
  const later = hoop.store.revision(review_id).items.find((i) => i.title === "Later")!.id;
  assert.notEqual(later, rollout);
  assert.ok(res.sections!.some((s) => s.section === later && s.title === "Later"));
  const thread = hoop.threads(review_id).threads!.find((t) => t.item === rollout)!;
  assert.equal(thread.outdated, true);
  assert.equal(thread.current_text, null);
  // A full markdown revision numbers new sections above every revision's too.
  const md = exportMarkdown(hoop.store.revision(review_id)).replace("## Later\n\nSomething new.\n\n", "") + "\n## Tail\n\nEnd.\n";
  hoop.submit(parseMarkdown(md, { review_id }), 3);
  const tail = hoop.store.revision(review_id).items.find((i) => i.title === "Tail")!.id;
  assert.ok(![rollout, later].includes(tail), tail);
});

test("comments on lines an edit didn't touch stay current; a comment on an edited line is outdated", () => {
  const { hoop, review_id, id, revise } = setup();
  const fb = hoop.review(review_id, {
    verdict: "comment",
    comments: [
      { item: id("Risks"), line: 1, body: "Which ones?" },
      { item: id("Rollout"), line: 1, body: "Good." },
    ],
  });
  hoop.receive(review_id);
  revise([{ op: "replace_text", section: id("Risks"), find: "Double", replace: "Duplicate" }]);
  const byThread = new Map(hoop.threads(review_id).threads!.map((t) => [t.thread, t]));
  const [risks, rollout] = fb.comments.map((c) => byThread.get(c.thread!)!);
  assert.deepEqual([risks!.outdated, risks!.current_text], [true, "Duplicate charges."]);
  assert.deepEqual([rollout!.outdated, rollout!.current_text], [false, "One region at a time."]);
});

test("replace_text works inside a code block or a Mermaid diagram, and the fence stays", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const src = "# Flow\n\nHow it runs.\n\n## Diagram\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n## Code\n\n```ts\nconst x = 1;\n```\n";
  const { review_id } = hoop.submit(parseMarkdown(src));
  const doc = hoop.store.revision(review_id);
  const [diagram, code] = ["Diagram", "Code"].map((t) => doc.items.find((i) => i.title === t)!.id);
  hoop.reviseSections(review_id, 1, [
    { op: "replace_text", section: diagram!, find: "A --> B", replace: "A --> C" },
    { op: "replace_text", section: code!, find: "= 1", replace: "= 2" },
  ]);
  assert.equal(exportMarkdown(hoop.store.revision(review_id)), src.replace("A --> B", "A --> C").replace("= 1", "= 2"));
});

test("section edits on an approved review make a new review that supersedes it", () => {
  const { hoop, review_id, id } = setup();
  hoop.review(review_id, { verdict: "approved", reviewer: "owner" });
  hoop.receive(review_id);
  const res = hoop.reviseSections(review_id, 1, [{ op: "replace_text", section: id("Rollout"), find: "One", replace: "Each" }]);
  assert.equal(res.outcome, "superseded");
  assert.notEqual(res.review_id, review_id);
  assert.equal(hoop.store.meta(review_id).superseded_by, res.review_id);
  assert.equal(exportMarkdown(hoop.store.revision(res.review_id)), MD.replace("One region", "Each region"));
  assert.equal(hoop.store.revision(res.review_id).items.find((i) => i.title === "Rollout")!.id, id("Rollout"));
});

test("a rename alone keeps the text; closing #s leave a title; a document without a # title is refused", () => {
  const { hoop, id, md, revise } = setup();
  revise([
    { op: "replace_section", section: id("Risks"), title: "Dangers ##" },
    { op: "replace_section", section: id("Introduction"), markdown: "We move billing\nto the new ledger." },
  ]);
  assert.equal(md(), MD.replace("## Risks", "## Dangers").replace("billing to the new", "billing\nto the new"));
  const plain = hoop.submit(parseMarkdown("Intro.\n\n## A\n\nText.\n", { title: "Untitled" }));
  assert.throws(() => hoop.reviseSections(plain.review_id, 1, [{ op: "delete_section", section: "S-1" }]), /no # title/);
});

test("hoop_revise_sections runs from OPS; submit and export list the section IDs", async () => {
  const { hoop, review_id, id } = setup();
  const exp = OPS.find((o) => o.name === "export")!;
  const out = (await exp.run(hoop, { review_id }, { actor: "claude" })) as { sections: { section: string; title: string; level: number }[] };
  assert.deepEqual(out.sections[1], { section: id("Plan"), title: "Plan", level: 2 });
  const op = OPS.find((o) => o.name === "revise_sections")!;
  assert.equal(op.writes, true);
  const res = (await op.run(
    hoop,
    { review_id, base_revision: 1, edits: [{ op: "replace_text", section: id("Rollout"), find: "One", replace: "Each" }] },
    { actor: "claude" },
  )) as { revision: number; changes: { modified: unknown[] }; sections: unknown[] };
  assert.equal(res.revision, 2);
  assert.equal(res.changes.modified.length, 1);
  assert.deepEqual(res.sections, out.sections);
});

test("on the sample documents, any section replaced with its own text, deleted, or inserted after and deleted again leaves every other byte", () => {
  const dir = new URL("./fixtures/docs/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
    const doc = parseMarkdown(readFileSync(new URL(f, dir), "utf8"));
    const md = exportMarkdown(doc);
    const fresh = `S-${highestSection([doc]) + 1}`;
    for (const it of doc.items) {
      const text = (it.body ?? "")
        .split("\n")
        .map((l) => l.split(JOIN).join("\n"))
        .join("\n");
      const same = applySectionEdits(doc, [{ op: "replace_section", section: it.id, markdown: text }]);
      assert.equal(exportMarkdown(same.doc), md, `${f} ${it.id}`);
      assert.deepEqual(
        same.doc.items.map((i) => i.id),
        doc.items.map((i) => i.id),
      );
      // Inserted after the section and everything nested in it; deleting it again gives the document back.
      const ins = applySectionEdits(doc, [{ op: "insert_section", section: it.id, title: "Inserted", markdown: "New." }]).doc;
      const nested = sectionItems(doc, it.id);
      assert.equal(ins.items[doc.items.findIndex((i) => i.id === nested.at(-1)) + 1]!.id, fresh, `${f} ${it.id}`);
      const back = applySectionEdits(doc, [
        { op: "insert_section", section: it.id, title: "Inserted", markdown: "New." },
        { op: "delete_section", section: fresh },
      ]);
      assert.equal(exportMarkdown(back.doc), md, `${f} insert after ${it.id}`);
      if (removalProblem(doc, it.id)) continue;
      const del = applySectionEdits(doc, [{ op: "delete_section", section: it.id }]).doc;
      const kept = doc.items.filter((i) => !nested.includes(i.id));
      assert.deepEqual(
        del.items.map((i) => i.id),
        kept.map((i) => i.id),
      );
      // Every kept section reads as before; the one left last loses only its trailing blank lines.
      del.items.forEach((i, k) => assert.equal(i.body ?? "", (kept[k]!.body ?? "").replace(k === kept.length - 1 ? /\n+$/ : /$^/, ""), `${f} delete ${it.id}`));
    }
  }
});
