import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { exportMarkdown, parseMarkdown } from "../src/markdown.js";
import { commentScope } from "../src/contract.js";
import { tempHome } from "./helpers.js";

const MD = [
  "# Billing migration",
  "",
  "We move billing to the new ledger.",
  "",
  "## Plan",
  "",
  "Move accounts in batches.",
  "",
  "### Batches",
  "",
  "- Small accounts first",
  "- Large accounts last",
  "",
  "#### Batch size",
  "",
  "Five hundred accounts.",
  "",
  "## Risks",
  "",
  "Double charges.",
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
  const id = (title: string) => doc.items.find((i) => i.title === title)!.id;
  return { hoop, review_id, id };
};

test("a removal suggested on a heading reaches Claude with the section's scope", () => {
  const { hoop, review_id, id } = setup();
  const fb = hoop.review(review_id, { verdict: "changes_requested", comments: [{ item: id("Plan"), line: 0, remove: true }] });
  assert.equal(fb.comments[0]!.remove, true);
  const res = hoop.receive(review_id) as {
    feedback: { comments: { remove?: boolean; item: string; line: number }[] }[];
    threads: { entries: { remove?: true }[] }[];
  };
  const c = res.feedback.at(-1)!.comments[0]!;
  assert.deepEqual([c.item, c.line, c.remove], [id("Plan"), 0, true]);
  assert.equal(res.threads[0]!.entries[0]!.remove, true);
  assert.deepEqual(commentScope(hoop.store.revision(review_id), c), { kind: "section", items: [id("Plan"), id("Batches"), id("Batch size")] });
});

test("Apply removes exactly the section and its subsections, and the rest exports byte for byte", () => {
  const { hoop, review_id, id } = setup();
  const t = hoop.review(review_id, { verdict: "comment", comments: [{ item: id("Plan"), line: 0, body: "Not needed.", remove: true }] }).comments[0]!.thread!;
  const res = hoop.applySuggestion(review_id, t, "ankur");
  assert.equal(res.revision, 2);
  assert.equal(res.applied.kind, "remove");
  assert.equal(res.words.added, 0);
  const expected = MD.replace(/## Plan\n[\s\S]*?(?=## Risks)/, "");
  assert.equal(exportMarkdown(hoop.store.revision(review_id)), expected);
  assert.deepEqual(
    hoop.store.revision(review_id).items.map((i) => i.title),
    ["Introduction", "Risks", "Rollout"],
  );
  assert.throws(() => hoop.applySuggestion(review_id, t), /already applied/);
});

test("removing the last section leaves the rest byte for byte, ending on text with no blank line", () => {
  const { hoop, review_id, id } = setup();
  const t = hoop.review(review_id, { verdict: "comment", comments: [{ item: id("Rollout"), line: 0, remove: true }] }).comments[0]!.thread!;
  hoop.applySuggestion(review_id, t);
  assert.equal(exportMarkdown(hoop.store.revision(review_id)), MD.slice(0, MD.indexOf("\n\n## Rollout") + 1));
});

test("Apply still works after a revision adds a section after the one suggested for removal", () => {
  // The parser drops the document's trailing newlines, so the old last section gains a blank line.
  const { hoop, review_id, id } = setup();
  const t = hoop.review(review_id, { verdict: "comment", comments: [{ item: id("Rollout"), line: 0, remove: true }] }).comments[0]!.thread!;
  hoop.receive(review_id);
  hoop.submit({ ...parseMarkdown(`${MD}\n## Owners\n\nThe billing team.\n`), review_id });
  hoop.applySuggestion(review_id, t);
  assert.deepEqual(
    hoop.store.revision(review_id).items.map((i) => i.title),
    ["Introduction", "Plan", "Batches", "Batch size", "Risks", "Owners"],
  );
});

test("a section already removed with an enclosing one says so, and the enclosing one applies after a subsection went", () => {
  const { hoop, review_id, id } = setup();
  const [inner, outer] = ["Batches", "Plan"].map(
    (title) => hoop.review(review_id, { verdict: "comment", comments: [{ item: id(title), line: 0, remove: true }] }).comments[0]!.thread!,
  );
  hoop.applySuggestion(review_id, inner!);
  hoop.applySuggestion(review_id, outer!);
  assert.deepEqual(
    hoop.store.revision(review_id).items.map((i) => i.title),
    ["Introduction", "Risks", "Rollout"],
  );
  // The other way round: the subsection's removal has nothing left to remove.
  const again = setup();
  const [inner2, outer2] = ["Batch size", "Plan"].map(
    (title) => again.hoop.review(again.review_id, { verdict: "comment", comments: [{ item: again.id(title), line: 0, remove: true }] }).comments[0]!.thread!,
  );
  again.hoop.applySuggestion(again.review_id, outer2!);
  assert.throws(() => again.hoop.applySuggestion(again.review_id, inner2!), /already removed with an enclosing section/);
});

test("one review can't both answer a question and suggest removing it", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const md = "# Pick\n\n## Options\n\n### Question: Which store?\n\n- A. Files (recommended)\n- B. SQLite\n\n## Next\n\nShip.\n";
  const { review_id } = hoop.submit(parseMarkdown(md));
  assert.throws(
    () =>
      hoop.review(review_id, {
        verdict: "changes_requested",
        comments: [{ item: "S-1", line: 0, remove: true }],
        answers: [{ item: "S-2", choice: "a" }],
      }),
    (err: Error & { errors?: { message: string }[] }) => /answer it or remove it, not both/.test(err.errors!.map((e) => e.message).join("; ")),
  );
});

test("Apply is refused once the section changed since the removal was suggested", () => {
  const { hoop, review_id, id } = setup();
  const t = hoop.review(review_id, { verdict: "comment", comments: [{ item: id("Plan"), line: 0, remove: true }] }).comments[0]!.thread!;
  hoop.receive(review_id);
  hoop.submit({ ...parseMarkdown(MD.replace("Five hundred accounts.", "A thousand accounts.")), review_id });
  assert.throws(() => hoop.applySuggestion(review_id, t), /line_unchanged: the section this removal was suggested on has changed/);
  assert.equal(hoop.store.meta(review_id).revisions, 2);
});

test("a removal of the title, the TL;DR, a line or the only thing left is refused", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(parseMarkdown("# One\n\nIntro.\n\n## Only\n\nText.\n"));
  const bare = hoop.submit(parseMarkdown("# One\n\n## Only\n\nText.\n")).review_id;
  const refused = (c: Record<string, unknown>, re: RegExp) =>
    assert.throws(
      () => hoop.review(review_id, { verdict: "comment", comments: [{ remove: true, ...c }] }),
      (err: Error & { errors?: { message: string }[] }) => {
        assert.match(err.errors!.map((e) => e.message).join("; "), re);
        return true;
      },
    );
  refused({ item: "DOC", line: 1 }, /heading \(line 0\)/);
  refused({ item: "DOC", line: 2 }, /heading \(line 0\)/);
  refused({ item: "S-1", line: 1 }, /heading \(line 0\)/);
  refused({ item: "S-0", line: 0 }, /only a document's section with a heading/);
  refused({ item: "S-1", line: 0, suggestion: "Other" }, /without a suggestion/);
  // With text before the first heading, the only heading can go; without it, it can't.
  const t = hoop.review(review_id, { verdict: "comment", comments: [{ item: "S-1", line: 0, remove: true }] }).comments[0]!.thread!;
  hoop.applySuggestion(review_id, t);
  assert.equal(exportMarkdown(hoop.store.revision(review_id)), "# One\n\nIntro.\n");
  assert.throws(
    () => hoop.review(bare, { verdict: "comment", comments: [{ item: "S-1", line: 0, remove: true }] }),
    (err: Error & { errors?: { message: string }[] }) => /last section/.test(err.errors!.map((e) => e.message).join("; ")),
  );
});
