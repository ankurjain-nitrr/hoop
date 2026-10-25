import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop, HoopError, type FeedbackResult, type SubmitResult } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { approvalHolds, reviewStatus } from "../src/rules.js";
import { waitForReview } from "../src/wait.js";
import { parseMarkdown } from "../src/markdown.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exampleWithQuestion, TEST_SESSION, tempHome } from "./helpers.js";

const op = (name: string) => OPS.find((o) => o.name === name)!;
const QUESTION =
  "## Question: Is Docker Compose only for local development?\n\n- A. No: keep the production design (recommended)\n- B. Yes: drop the production sizing\n\n";
const design = (question = true, storage = "Cassandra, sized for 10M daily users.") =>
  `# Design\n\nHow we deploy the service.\n\n${question ? QUESTION : ""}## Storage\n\n${storage}\n`;
const submit = (hoop: Hoop, input: Record<string, unknown>) => op("submit").run(hoop, input, { actor: "claude" }) as SubmitResult;
const feedback = (hoop: Hoop, review_id: string) => op("feedback").run(hoop, { review_id }, { actor: "claude" }) as FeedbackResult;
const tick = () => new Promise((r) => setTimeout(r, 5));
/** A person's review from the page. */
const person = (hoop: Hoop, id: string, input: Record<string, unknown>) => hoop.review(id, { reviewer: "ankur", ...input }, true);

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof HoopError, String(err));
    return err.message;
  }
  assert.fail("expected a refusal");
}

function setup(question = true) {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  const { review_id } = submit(hoop, { markdown: design(question) });
  const storage = hoop.store.revision(review_id).items.find((i) => i.title === "Storage")!.id;
  return { hoop, review_id, storage };
}

test("regression #165: a document is approved only once no questions remain in its text", async () => {
  const { hoop, review_id } = setup();
  // As in the incident: the reviewer picked B and approved in the same review. Even the recommended
  // option, or none, leaves the question in the text.
  for (const answers of [[{ item: "S-1", choice: "b" }], [{ item: "S-1", choice: "a" }], []])
    assert.match(
      refusal(() => person(hoop, review_id, { verdict: "approved", answers })),
      /hoop didn't approve .*: 1 question is still in the text: answer it and request changes so Claude writes the decision in/,
    );
  assert.equal(hoop.store.meta(review_id).status, "open", "nothing was approved");
  // The answer goes with a request for changes; Claude writes the decision in and removes the question.
  person(hoop, review_id, { verdict: "changes_requested", answers: [{ item: "S-1", choice: "b" }] });
  feedback(hoop, review_id);
  await tick();
  submit(hoop, { markdown: design(false, "Postgres on one machine, run with Docker Compose."), review_id, base_revision: 1 });
  assert.deepEqual(approvalHolds(hoop.store, review_id), { threads: [], questions_in_text: [] });
  person(hoop, review_id, { verdict: "approved" });
  assert.equal(hoop.store.meta(review_id).status, "approved");
});

test("regression #165: an approval is refused while a thread from any revision isn't resolved, applied or not", async () => {
  const { hoop, review_id, storage } = setup(false);
  const t = person(hoop, review_id, { verdict: "changes_requested", comments: [{ item: storage, line: 1, body: "Too big for local." }] }).comments[0]!.thread!;
  const s = person(hoop, review_id, { verdict: "changes_requested", comments: [{ item: storage, line: 0, suggestion: "Storage on one machine" }] }).comments[0]!
    .thread!;
  feedback(hoop, review_id);
  hoop.applySuggestion(review_id, s, "ankur");
  await tick();
  hoop.reply(t, "Revision 3 sizes it for one machine.");
  submit(hoop, { markdown: design(false, "Postgres on one machine."), review_id, base_revision: 2 });
  // Claude answered one thread and the reviewer applied the other, but only the reviewer resolves.
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved" })),
    /: 2 conversations are still open: resolve them or request changes$/,
  );
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved", resolved_threads: [t] })),
    /: 1 conversation is still open: resolve it or request changes$/,
  );
  person(hoop, review_id, { verdict: "approved", resolved_threads: [t, s] });
  assert.equal(hoop.store.meta(review_id).status, "approved", "resolving in the approval itself approves");
});

test("regression: a thread on a section Claude removed still holds an approval until the reviewer resolves it", async () => {
  const { hoop, review_id, storage } = setup(false);
  const t = person(hoop, review_id, { verdict: "changes_requested", comments: [{ item: storage, line: 1, body: "Drop this section." }] }).comments[0]!.thread!;
  feedback(hoop, review_id);
  await tick();
  submit(hoop, { markdown: "# Design\n\nHow we deploy the service.\n", review_id, base_revision: 1 });
  const held = feedback(hoop, review_id).threads!.find((x) => x.thread === t)!;
  assert.deepEqual([held.current_text, held.outdated], [null, true]);
  assert.deepEqual(approvalHolds(hoop.store, review_id).threads, [t]);
  person(hoop, review_id, { verdict: "approved", resolved_threads: [t] });
  assert.equal(hoop.store.meta(review_id).status, "approved");
});

test("a decision document follows the same rule: its answers go with a request for changes, and Claude revises it into a document without questions", async () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  const decision = {
    ...parseMarkdown("# Pick a store\n\nWhich store we use.\n\n## Question: Which store?\n\n- A. Files (recommended)\n- B. SQLite\n"),
    kind: "decision",
  };
  const { review_id } = op("submit_decision").run(hoop, { document: decision }, { actor: "claude" }) as SubmitResult;
  // No approval takes the recommended option any more, nor approves with a pick, even when the document asks to choose.
  for (const answers of [[], [{ item: "S-1", choice: "a", recommended: true }], [{ item: "S-1", choice: "b" }]])
    assert.match(
      refusal(() => person(hoop, review_id, { verdict: "approved", answers })),
      /1 question is still in the text/,
    );
  const { review_id: choose } = hoop.submit({ ...decision, asks: "choose" });
  assert.match(
    refusal(() => person(hoop, choose, { verdict: "approved", answers: [{ item: "S-1", choice: "b" }] })),
    /1 question is still in the text/,
  );
  person(hoop, review_id, { verdict: "changes_requested", answers: [{ item: "S-1", choice: "b" }] });
  feedback(hoop, review_id);
  await tick();
  const revised = submit(hoop, { markdown: "# Pick a store\n\nWe store orders in SQLite.\n", review_id, base_revision: 1 });
  assert.equal(revised.outcome, "revised");
  assert.equal(hoop.store.revision(review_id).kind, "doc");
  person(hoop, review_id, { verdict: "approved" });
  assert.equal(hoop.store.meta(review_id).status, "approved");
});

test("regression #224: a request for changes after approval reopens the review, keeps the approval on record, and the next revision needs approving again", async () => {
  const { hoop, review_id, storage } = setup(false);
  const approval = person(hoop, review_id, { verdict: "approved", summary: "Go." });
  const approved = feedback(hoop, review_id);
  assert.equal(approved.status === "reviewed" && approved.approved, true);
  // Only a person reopens it, and an approved review isn't approved twice.
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved" })),
    /is already approved/,
  );
  assert.match(
    refusal(() => new Hoop(hoop.store, "other-session-1111").comment(review_id, { item: storage, line: 1, body: "Hm." })),
    /is approved; only a person reopens it, by requesting changes on its page/,
  );
  await tick();
  const late = person(hoop, review_id, { verdict: "changes_requested", comments: [{ item: storage, line: 1, body: "Use Postgres after all." }] });
  const meta = hoop.store.meta(review_id);
  assert.equal(meta.status, "open");
  assert.equal(reviewStatus(hoop.store, meta).status_key, "reopened");
  // A wait from the approval's cursor returns the comment.
  const waited = await waitForReview(hoop, review_id, { after: approved.cursor, timeoutMs: 1000, intervalMs: 10 });
  assert.ok(waited?.status === "reviewed");
  assert.equal(waited.approved, false);
  assert.equal(waited.reopened, true);
  assert.equal(waited.approved_revision, 1);
  assert.deepEqual(
    waited.feedback.map((f) => f.verdict),
    ["approved", "changes_requested"],
    "the approval stays on record beside the comment",
  );
  assert.equal(waited.threads?.[0]?.thread, late.comments[0]!.thread);
  // Claude revises the same review; the new revision needs approving again.
  const revised = submit(hoop, { markdown: design(false, "Postgres."), review_id, base_revision: 1 });
  assert.equal(revised.outcome, "revised");
  assert.equal(revised.review_id, review_id);
  assert.equal(reviewStatus(hoop.store, hoop.store.meta(review_id)).status_key, "awaiting_review");
  assert.equal(feedback(hoop, review_id).status, "pending");
  assert.equal(hoop.store.feedback(review_id, 1)[0]!.at, approval.at, "revision 1's approval is still there");
  person(hoop, review_id, { verdict: "approved", resolved_threads: [late.comments[0]!.thread!] });
  assert.equal(hoop.store.meta(review_id).approved_revision, 2);
});

test("regression: a reviewer's Apply on a reopened review keeps it reopened until Claude revises", async () => {
  const { hoop, review_id, storage } = setup(false);
  person(hoop, review_id, { verdict: "approved" });
  await tick();
  const t = person(hoop, review_id, { verdict: "changes_requested", comments: [{ item: storage, line: 1, suggestion: "Postgres on one machine." }] })
    .comments[0]!.thread!;
  feedback(hoop, review_id);
  hoop.applySuggestion(review_id, t, "ankur");
  const meta = hoop.store.meta(review_id);
  assert.equal(meta.revisions, 2);
  assert.equal(reviewStatus(hoop.store, meta).status_key, "reopened", "the Apply made a revision but didn't answer the reopening");
  assert.equal(feedback(hoop, review_id).reopened, true);
  submit(hoop, { markdown: design(false, "Postgres on one machine, sized for one user."), review_id, base_revision: 2 });
  assert.equal(reviewStatus(hoop.store, hoop.store.meta(review_id)).status_key, "awaiting_review");
});

test("a session's comment that lands after the reviewer loaded the page holds the approval", () => {
  const { hoop, review_id, storage } = setup(false);
  // The page showed nothing open; then another session comments, and the approval comes in.
  assert.deepEqual(approvalHolds(hoop.store, review_id).threads, []);
  const t = new Hoop(hoop.store, "other-session-1111").comment(review_id, { item: storage, line: 1, body: "Which region?" }).comments[0]!.thread!;
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved" })),
    /1 conversation is still open: resolve it or request changes/,
  );
  assert.deepEqual(approvalHolds(hoop.store, review_id).threads, [t]);
  assert.equal(hoop.store.meta(review_id).status, "open");
});

test("the order-export decision document: answers go with a request for changes, and threads on its requirements move to removed sections when Claude revises it into markdown", async () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  const { review_id } = op("submit_decision").run(hoop, { document: exampleWithQuestion() }, { actor: "claude" }) as SubmitResult;
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved" })),
    /1 question is still in the text/,
  );
  const fb = person(hoop, review_id, {
    verdict: "changes_requested",
    comments: [
      { item: "FR-1", line: 1, body: "Stream it, don't buffer." },
      { item: "FR-3", line: 0, body: "Both bounds inclusive?" },
    ],
    answers: [{ item: "Q-1", choice: "a" }],
  });
  const [t1, t3] = fb.comments.map((c) => c.thread!);
  feedback(hoop, review_id);
  await tick();
  const md =
    "# Order export\n\nAdmins export orders as CSV.\n\n## Export\n\nStream every order from the in-memory list, one row each.\n\n## Filter\n\nBoth bounds are inclusive.\n";
  assert.equal(submit(hoop, { markdown: md, review_id, base_revision: 1 }).outcome, "revised");
  const doc = hoop.store.revision(review_id);
  assert.equal(doc.kind, "doc");
  assert.deepEqual(
    doc.items.map((i) => i.id),
    ["S-0", "S-1", "S-2"],
    "no section takes a requirement's ID by place",
  );
  // The requirements are gone, so their threads have no line now and wait under On removed sections.
  const threads = feedback(hoop, review_id).threads!;
  assert.deepEqual(
    threads.map((t) => [t.thread, t.item, t.current_text, t.outdated]),
    [
      [t1, "FR-1", null, true],
      [t3, "FR-3", null, true],
    ],
  );
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved" })),
    /2 conversations are still open/,
  );
  person(hoop, review_id, { verdict: "approved", resolved_threads: [t1, t3] });
  assert.equal(hoop.store.meta(review_id).status, "approved");
});

test("a review reopened before hoop kept the reopened flag still reads as reopened until Claude revises", async () => {
  const { hoop, review_id, storage } = setup(false);
  person(hoop, review_id, { verdict: "approved" });
  await tick();
  person(hoop, review_id, { verdict: "changes_requested", comments: [{ item: storage, line: 1, body: "Postgres after all." }] });
  // As the earlier release stored it: open again, with reopened_at and the approved revision, but no flag.
  const { reopened: _flag, ...older } = hoop.store.meta(review_id);
  hoop.store.update(review_id, { ...older, reopened: undefined });
  assert.equal(hoop.store.meta(review_id).reopened, undefined);
  assert.equal(reviewStatus(hoop.store, hoop.store.meta(review_id)).status_key, "reopened");
  assert.equal(feedback(hoop, review_id).reopened, true);
  submit(hoop, { markdown: design(false, "Postgres."), review_id, base_revision: 1 });
  assert.equal(reviewStatus(hoop.store, hoop.store.meta(review_id)).status_key, "awaiting_review");
  assert.equal(feedback(hoop, review_id).reopened, undefined);
});

test("on a review a person opened from a file, a question left in the text says to write the decision into the file", () => {
  const store = new Store(tempHome());
  const terminal = new Hoop(store, null);
  const file = join(tempHome(), "design.md");
  writeFileSync(file, design());
  const { review_id } = terminal.open(file);
  assert.match(
    refusal(() => person(terminal, review_id, { verdict: "approved" })),
    /1 question is still in the text: write the decision into the file and open it again$/,
  );
});
