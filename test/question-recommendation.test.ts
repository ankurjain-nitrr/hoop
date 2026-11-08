// A document Claude submits marks exactly one option recommended in each question, as hoop_ask's do (rv_mw7pt2ccf618dc).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hoop } from "../src/hoop.js";
import { parseMarkdown } from "../src/markdown.js";
import { Store } from "../src/store.js";
import { HoopError } from "../src/util.js";
import { TEST_SESSION, tempHome, op } from "./helpers.js";

const plan = (options: string) =>
  `# Ship the export\n\nThe plan for the export.\n\n## Question: How should it reach people?\n\n${options}\n\n## Steps\n\nWrite it.\n`;
/** The error details a refused call gives, or undefined when it went through. */
function refusal(run: () => unknown) {
  try {
    run();
    return undefined;
  } catch (err) {
    assert.ok(err instanceof HoopError, String(err));
    return { message: err.message, detail: err.errors };
  }
}
// The introduction is item 0, so the question is item 1.
const NAMED = [
  { path: "items.1.choices", message: 'mark exactly one option recommended in "Question: How should it reach people?" (end its item with "(recommended)")' },
];

test("hoop_submit refuses a question with no recommended option, or two, naming the question", () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  // Regression: a question left with every option unmarked ("that call is yours") was accepted.
  for (const options of ["- A. Stream it\n- B. Email a link", "- A. Stream it (recommended)\n- B. Email a link (recommended)"])
    assert.deepEqual(
      refusal(() => op("submit").run(hoop, { markdown: plan(options) }, { actor: "claude" })),
      { message: "invalid review document", detail: NAMED },
      options,
    );
  assert.equal(hoop.store.list().length, 0, "nothing was stored");
  const ok = op("submit").run(hoop, { markdown: plan("- A. Stream it (recommended)\n- B. Email a link") }, { actor: "claude" }) as { review_id: string };
  assert.match(ok.review_id, /^rv_/);
  // A document with no question needs nothing.
  assert.equal(
    refusal(() => op("submit").run(hoop, { markdown: "# Notes\n\nJust notes.\n\n## Steps\n\nWrite it.\n" }, { actor: "claude" })),
    undefined,
  );
});

test("hoop_submit_decision and a revision by sections are refused the same way", () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  // The example decision document, with its question's recommendation taken off.
  const example = JSON.parse(readFileSync(new URL("../examples/order-export.json", import.meta.url), "utf8"));
  const at = example.items.findIndex((i: { choices?: unknown[] }) => i.choices);
  const question = example.items[at];
  for (const c of question.choices) delete c.recommended;
  const decision = refusal(() => op("submit_decision").run(hoop, { document: example }, { actor: "claude" }));
  assert.deepEqual(decision?.detail, [
    { path: `items.${at}.choices`, message: `mark exactly one option recommended in "${question.title}" (end its item with "(recommended)")` },
  ]);

  // A revision by sections that takes the recommendation off the question is refused too.
  const { review_id } = hoop.submit(parseMarkdown(plan("- A. Stream it (recommended)\n- B. Email a link")));
  const section = hoop.store.revision(review_id).items.find((i) => i.title.startsWith("Question:"))!.id;
  const revised = refusal(() => hoop.reviseSections(review_id, 1, [{ op: "replace_section", section, markdown: "- A. Stream it\n- B. Email a link" }]));
  assert.equal(revised?.message, "invalid review document");
  assert.equal(hoop.store.meta(review_id).revisions, 1, "no revision was stored");
});

test("a revision is refused only for a question it adds or changes, not for one left as it was", () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  // The person's own build, finished with a question they left unmarked.
  const { review_id } = hoop.startBuild(plan("- A. Stream it\n- B. Email a link"));
  hoop.finishBuild(review_id);
  const revision = () => hoop.store.meta(review_id).revisions;
  const items = hoop.store.revision(review_id).items;
  const steps = items.find((i) => i.title === "Steps")!.id;
  const question = items.find((i) => i.title.startsWith("Question:"))!.id;
  // Regression: Claude's revision of another section was refused over the person's question.
  const before = revision();
  hoop.reviseSections(review_id, before, [{ op: "replace_section", section: steps, markdown: "Write it, then test it." }]);
  assert.equal(revision(), before + 1, "a revision that leaves the question alone goes through");
  // The whole document resubmitted with the question as it was goes through too.
  const doc = hoop.store.revision(review_id);
  hoop.submit({ ...doc, review_id }, revision());
  // Changing the question's options without a recommendation is refused.
  const changed = refusal(() =>
    hoop.reviseSections(review_id, revision(), [{ op: "replace_section", section: question, markdown: "- A. Stream it\n- B. Email a link\n- C. Both" }]),
  );
  assert.equal(changed?.message, "invalid review document");
  assert.match(changed!.detail[0]!.message, /^mark exactly one option recommended in "Question: How should it reach people\?"/);
});

test("a plan from plan mode isn't refused for an unmarked question, so it still goes to review", () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  const { review_id } = hoop.submit(parseMarkdown(plan("- A. Stream it\n- B. Email a link")), undefined, undefined, { plan: true });
  assert.equal(hoop.store.meta(review_id).revisions, 1);
});
