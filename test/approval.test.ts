import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop, HoopError, type FeedbackResult, type SubmitResult } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { reviewStatus } from "../src/rules.js";
import { waitForReview } from "../src/wait.js";
import { parseMarkdown } from "../src/markdown.js";
import { TEST_SESSION, tempHome } from "./helpers.js";

const op = (name: string) => OPS.find((o) => o.name === name)!;
const DESIGN =
  "# Design\n\nHow we deploy the service.\n\n## Question: Is Docker Compose only for local development?\n\n- A. No: keep the production design (recommended)\n- B. Yes: drop the production sizing\n\n## Storage\n\nCassandra, sized for 10M daily users.\n";
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

function setup() {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  const { review_id } = submit(hoop, { markdown: DESIGN });
  const storage = hoop.store.revision(review_id).items.find((i) => i.title === "Storage")!.id;
  return { hoop, review_id, storage };
}

test("regression #165: an approval is refused while the reviewer's own answer isn't the recommended option", () => {
  const { hoop, review_id } = setup();
  // As in the incident: the reviewer picked B and approved in the same review.
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved", answers: [{ item: "S-1", choice: "b" }] })),
    /hoop didn't approve .*: you answered "Question: Is Docker Compose only for local development\?" with an option the text doesn't say yet: request changes so Claude revises it/,
  );
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved", answers: [{ item: "S-1", choice: "other", text: "Both" }] })),
    /you answered/,
    "Other asks for changes too",
  );
  assert.equal(hoop.store.meta(review_id).status, "open", "nothing was approved");
  // An answer sent earlier on the same revision is still in force.
  person(hoop, review_id, { verdict: "changes_requested", answers: [{ item: "S-1", choice: "b" }] });
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved" })),
    /you answered/,
  );
  // Picking the recommended option, or leaving the question to take it, approves.
  person(hoop, review_id, { verdict: "approved", answers: [{ item: "S-1", choice: "a" }] });
  assert.equal(hoop.store.meta(review_id).status, "approved");
});

test("regression #165: an approval is refused while a thread from any revision is open, and accepted once it's resolved", async () => {
  const { hoop, review_id, storage } = setup();
  const t = person(hoop, review_id, { verdict: "changes_requested", comments: [{ item: storage, line: 1, body: "Too big for local." }] }).comments[0]!.thread!;
  feedback(hoop, review_id);
  await tick();
  hoop.reply(t, "Revision 2 sizes it for one machine.");
  submit(hoop, { markdown: DESIGN.replace("sized for 10M daily users", "on one machine"), review_id, base_revision: 1 });
  // Claude answered the thread, but only the reviewer resolves it.
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved" })),
    new RegExp(`1 thread is still open \\(${t}\\): resolve them or request changes`),
  );
  person(hoop, review_id, { verdict: "approved", resolved_threads: [t] });
  assert.equal(hoop.store.meta(review_id).status, "approved", "resolving in the approval itself approves");
});

test("a thread whose suggestion the reviewer applied doesn't hold an approval, and a document that asks to choose approves with the choice", () => {
  const { hoop, review_id, storage } = setup();
  const t = person(hoop, review_id, { verdict: "changes_requested", comments: [{ item: storage, line: 1, suggestion: "Postgres, on one machine." }] })
    .comments[0]!.thread!;
  hoop.applySuggestion(review_id, t, "ankur");
  hoop.receive(review_id);
  person(hoop, review_id, { verdict: "approved" });
  assert.equal(hoop.store.meta(review_id).status, "approved");

  const decision = parseMarkdown("# Pick a store\n\nWhich store we use.\n\n## Question: Which store?\n\n- A. Files (recommended)\n- B. SQLite\n");
  const { review_id: pick } = hoop.submit({ ...decision, asks: "choose" });
  person(hoop, pick, { verdict: "approved", answers: [{ item: "S-1", choice: "b" }] });
  assert.equal(hoop.store.meta(pick).status, "approved");
});

test("regression #224: a request for changes after approval reopens the review, keeps the approval on record, and the next revision needs approving again", async () => {
  const { hoop, review_id, storage } = setup();
  const approval = person(hoop, review_id, { verdict: "approved", summary: "Go." });
  const approved = feedback(hoop, review_id);
  assert.equal(approved.status === "reviewed" && approved.approved, true);
  const cursor = approved.cursor;
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
  const waited = await waitForReview(hoop, review_id, { after: cursor, timeoutMs: 1000, intervalMs: 10 });
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
  const revised = submit(hoop, { markdown: DESIGN.replace("Cassandra", "Postgres"), review_id, base_revision: 1 });
  assert.equal(revised.outcome, "revised");
  assert.equal(revised.review_id, review_id);
  assert.equal(reviewStatus(hoop.store, hoop.store.meta(review_id)).status_key, "awaiting_review");
  const after = feedback(hoop, review_id);
  assert.equal(after.status, "pending");
  assert.equal(hoop.store.feedback(review_id, 1)[0]!.at, approval.at, "revision 1's approval is still there");
  person(hoop, review_id, { verdict: "approved", resolved_threads: [late.comments[0]!.thread!] });
  assert.equal(hoop.store.meta(review_id).approved_revision, 2);
});
