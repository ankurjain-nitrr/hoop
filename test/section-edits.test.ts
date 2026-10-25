import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { readdirSync, readFileSync } from "node:fs";
import { exportMarkdown, JOIN, parseMarkdown } from "../src/markdown.js";
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
    [{ op: "replace_section", section: id("Risks"), markdown: "```js\nopen fence" }, /structure at section/],
    [{ op: "delete_section", section: id("Introduction") }, /only a document's section with a heading/],
    [{ op: "insert_section", section: id("Plan"), title: "Two\nlines" }, /one line/],
    [{ op: "replace_section", section: id("Plan") }, /markdown is required/],
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

test("hoop_revise_sections runs from OPS, and export lists the section IDs", async () => {
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
  )) as { revision: number; changes: { modified: unknown[] } };
  assert.equal(res.revision, 2);
  assert.equal(res.changes.modified.length, 1);
});

test("replacing any section of the sample documents with its own text changes no byte", () => {
  const dir = new URL("./fixtures/docs/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
    const doc = parseMarkdown(readFileSync(new URL(f, dir), "utf8"));
    for (const it of doc.items) {
      const text = (it.body ?? "")
        .split("\n")
        .map((l) => l.split(JOIN).join("\n"))
        .join("\n");
      const out = applySectionEdits(doc, [{ op: "replace_section", section: it.id, markdown: text }]);
      assert.equal(exportMarkdown(out.doc), exportMarkdown(doc), `${f} ${it.id}`);
      assert.deepEqual(
        out.doc.items.map((i) => i.id),
        doc.items.map((i) => i.id),
      );
    }
  }
});
