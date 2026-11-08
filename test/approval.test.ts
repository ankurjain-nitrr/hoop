import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { Hoop, HoopError, type FeedbackResult, type SubmitResult } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { approvalHolds, exportedAnswers, reviewStatus, unansweredQuestions } from "../src/rules.js";
import { waitForReview } from "../src/wait.js";
import { parseMarkdown } from "../src/markdown.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exampleWithQuestion, TEST_SESSION, tempHome, op } from "./helpers.js";

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

test("#381: on a review a person opened from a file, answering its question lets them approve, and the answer stays with the review", () => {
  const store = new Store(tempHome());
  const terminal = new Hoop(store, null);
  const file = join(tempHome(), "design.md");
  writeFileSync(file, design());
  const { review_id } = terminal.open(file);
  const question = store.revision(review_id).items.find((i) => i.choices?.length)!;
  assert.match(
    refusal(() => person(terminal, review_id, { verdict: "approved" })),
    /hoop didn't approve .*: 1 question is unanswered: answer it to approve$/,
  );
  person(terminal, review_id, { verdict: "approved", answers: [{ item: question.id, choice: "b" }] });
  assert.equal(store.meta(review_id).status, "approved");
  const read = feedback(terminal, review_id);
  assert.ok(read.status === "reviewed");
  assert.deepEqual(read.feedback.at(-1)!.answers, [{ item: question.id, choice: "b" }]);
  const exported = op("export").run(terminal, { review_id }, { actor: "claude" }) as { answers?: unknown; markdown: string };
  assert.deepEqual(exported.answers, [{ section: question.id, question: question.title, choice: "b", answer: "Yes: drop the production sizing" }]);
  assert.equal(readFileSync(file, "utf8"), design(), "hoop writes nothing into the file");
});

test("#381: on a file review, an answer given in a request for changes counts toward a later approval", () => {
  const store = new Store(tempHome());
  const terminal = new Hoop(store, null);
  const file = join(tempHome(), "design.md");
  writeFileSync(file, design());
  const { review_id } = terminal.open(file);
  const question = store.revision(review_id).items.find((i) => i.choices?.length)!.id;
  person(terminal, review_id, { verdict: "changes_requested", answers: [{ item: question, choice: "a" }] });
  person(terminal, review_id, { verdict: "approved" });
  assert.equal(store.meta(review_id).status, "approved");
  const exported = op("export").run(terminal, { review_id }, { actor: "claude" }) as { answers?: { choice: string }[] };
  assert.equal(exported.answers?.[0]?.choice, "a");
});

test("#381: a review Claude submitted still can't be approved with an answer that isn't written into the text", () => {
  const { hoop, review_id } = setup();
  const question = hoop.store.revision(review_id).items.find((i) => i.choices?.length)!.id;
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved", answers: [{ item: question, choice: "a" }] })),
    /1 question is still in the text: answer it and request changes so Claude writes the decision in/,
  );
  person(hoop, review_id, { verdict: "changes_requested", answers: [{ item: question, choice: "a" }] });
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved" })),
    /1 question is still in the text/,
  );
  assert.equal(hoop.store.meta(review_id).status, "open");
});

const THREE = `# Rollout\n\nHow we ship.\n\n## Question: Which region first?\n\n- A. EU (recommended)\n- B. US\n\n## Question: Feature flag?\n\n- A. Yes (recommended)\n- B. No\n\n## Question: Who is on call?\n\n- A. Platform (recommended)\n- B. Payments\n`;

test("#287: a person requests changes with 2 of 3 questions answered, the feedback lists the third, and approval waits for it", () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  const { review_id } = submit(hoop, { markdown: THREE });
  const [region, flag, call] = hoop.store.revision(review_id).items.filter((i) => i.choices?.length);
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved" })),
    /3 questions are still in the text/,
  );
  person(hoop, review_id, {
    verdict: "changes_requested",
    answers: [
      { item: region!.id, choice: "a" },
      { item: flag!.id, choice: "b" },
    ],
  });
  const read = feedback(hoop, review_id);
  assert.ok(read.status === "reviewed");
  assert.deepEqual(read.unanswered_questions, [{ item: call!.id, title: call!.title }], "Claude learns which question is still open");
  assert.match(
    refusal(() => person(hoop, review_id, { verdict: "approved" })),
    /hoop didn't approve .*: 3 questions are still in the text/,
  );
  assert.equal(hoop.store.meta(review_id).status, "open", "nothing was approved");
  // Answering the last one leaves none unanswered.
  person(hoop, review_id, { verdict: "changes_requested", answers: [{ item: call!.id, choice: "b" }] });
  const after = feedback(hoop, review_id);
  assert.ok(after.status === "reviewed");
  assert.equal(after.unanswered_questions, undefined);
});

test("regression: after an approval, Claude's reply in a thread doesn't let an empty request for changes reopen it", () => {
  const { hoop, review_id, storage } = setup(false);
  person(hoop, review_id, { verdict: "changes_requested", comments: [{ item: storage, line: 1, body: "Why Cassandra?" }] });
  feedback(hoop, review_id);
  const thread = hoop.threads(review_id).threads![0]!.thread;
  person(hoop, review_id, { verdict: "approved", resolved_threads: [thread] });
  assert.equal(hoop.store.meta(review_id).status, "approved");
  hoop.reply(thread, "Scale.");
  assert.deepEqual(approvalHolds(hoop.store, review_id).threads, [thread], "the reply puts the thread back");
  for (const empty of [{}, { summary: "  " }])
    assert.match(
      refusal(() => person(hoop, review_id, { verdict: "changes_requested", ...empty })),
      /Request changes needs something to change: comment on a line or section, or write an overall comment/,
    );
  assert.equal(hoop.store.meta(review_id).status, "approved", "it stays approved");
  person(hoop, review_id, { verdict: "changes_requested", summary: "Use Postgres." });
  assert.equal(hoop.store.meta(review_id).status, "open", "a written request reopens it");
});

// Regression #431: a thread reopens by the order hoop recorded its entries, not by their clock times.
// With the clock stopped, the approval and Claude's reply share one timestamp; the reply still
// comes after the approval that resolved the thread, so it puts the thread back.
test("regression #431: Claude's reply in the same millisecond as the approval still reopens the thread", () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-05T10:00:00.000Z") });
  try {
    const { hoop, review_id, storage } = setup(false);
    person(hoop, review_id, { verdict: "changes_requested", comments: [{ item: storage, line: 1, body: "Why Cassandra?" }] });
    feedback(hoop, review_id);
    const thread = hoop.threads(review_id).threads![0]!.thread;
    person(hoop, review_id, { verdict: "approved", resolved_threads: [thread] });
    hoop.reply(thread, "Scale.");
    const at = hoop.store.allFeedback(review_id).at(-1)!.at;
    assert.equal(hoop.store.replies(review_id).at(-1)!.at, at, "the reply and the approval share one timestamp");
    assert.deepEqual(approvalHolds(hoop.store, review_id).threads, [thread], "the reply puts the thread back");
    assert.match(
      refusal(() => person(hoop, review_id, { verdict: "changes_requested" })),
      /Request changes needs something to change/,
    );
    assert.equal(hoop.store.meta(review_id).status, "approved");
  } finally {
    mock.timers.reset();
  }
});

test("#431: a review's own comment on a thread it resolves keeps the thread resolved, though they share its time", () => {
  const { hoop, review_id, storage } = setup(false);
  person(hoop, review_id, { verdict: "changes_requested", comments: [{ item: storage, line: 1, body: "Why Cassandra?" }] });
  feedback(hoop, review_id);
  const thread = hoop.threads(review_id).threads![0]!.thread;
  hoop.reply(thread, "Scale.");
  // One review resolves the thread and says a last word in it: both carry the review's time.
  person(hoop, review_id, {
    verdict: "changes_requested",
    summary: "Fine by me; one more thing elsewhere.",
    resolved_threads: [thread],
    comments: [{ thread, body: "Thanks, that settles it." }],
  });
  const t = hoop.threads(review_id);
  assert.deepEqual(
    t.resolved?.map((r) => r.thread),
    [thread],
    "the thread stays resolved",
  );
  assert.equal(t.threads, undefined);
});

test("#431: a reply stored before hoop kept the order is placed by its time", () => {
  const { hoop, review_id, storage } = setup(false);
  person(hoop, review_id, { verdict: "changes_requested", comments: [{ item: storage, line: 1, body: "Why Cassandra?" }] });
  feedback(hoop, review_id);
  const thread = hoop.threads(review_id).threads![0]!.thread;
  person(hoop, review_id, { verdict: "approved", resolved_threads: [thread] });
  const at = hoop.store.allFeedback(review_id).at(-1)!.at;
  const file = join(hoop.store.dirOf(review_id), "replies.json");
  const old = (when: string) => writeFileSync(file, JSON.stringify([{ thread, author: "Claude", body: "Scale.", at: when }]));
  old(new Date(Date.parse(at) + 1).toISOString());
  assert.deepEqual(approvalHolds(hoop.store, review_id).threads, [thread], "a later reply reopens it");
  old(at);
  assert.deepEqual(approvalHolds(hoop.store, review_id).threads, [], "one at the same time can't be told apart, and doesn't");
});

test("#381: on a file review, an empty request for changes is refused, since it asks no one for anything", () => {
  const store = new Store(tempHome());
  const terminal = new Hoop(store, null);
  const file = join(tempHome(), "design.md");
  writeFileSync(file, design());
  const { review_id } = terminal.open(file);
  assert.match(
    refusal(() => person(terminal, review_id, { verdict: "changes_requested" })),
    /Request changes needs something to change: comment on a line or section/,
  );
  assert.equal(store.feedback(review_id).length, 0);
  person(terminal, review_id, { verdict: "changes_requested", summary: "Size it for 1M users." });
  assert.equal(reviewStatus(store, store.meta(review_id)).status_key, "changes_requested");
});

test("#381: on a file review, the recommended option taken without a pick doesn't answer a question, as on the page", () => {
  const store = new Store(tempHome());
  const terminal = new Hoop(store, null);
  const file = join(tempHome(), "design.md");
  writeFileSync(file, design());
  const { review_id } = terminal.open(file);
  const question = store.revision(review_id).items.find((i) => i.choices?.length)!.id;
  assert.match(
    refusal(() => person(terminal, review_id, { verdict: "approved", answers: [{ item: question, choice: "a", recommended: true }] })),
    /1 question is unanswered: answer it to approve/,
  );
  assert.equal(store.meta(review_id).status, "open");
});

/** Stores an approval as an older hoop did, taking the recommended option for `item`. */
function oldApproval(store: Store, review_id: string, item: string) {
  store.addFeedback(review_id, {
    schema: "hoop/feedback@0",
    review_id,
    revision: 1,
    verdict: "approved",
    comments: [],
    answers: [{ item, choice: "a", recommended: true }],
    resolved_threads: [],
    viewed: [],
    reviewer: "ankur",
    at: new Date().toISOString(),
  });
}

test("#381: a recommended option stored on a file review's latest revision counts as its answer, for approval, feedback and export", () => {
  const store = new Store(tempHome());
  const terminal = new Hoop(store, null);
  const file = join(tempHome(), "design.md");
  writeFileSync(file, design());
  const { review_id } = terminal.open(file);
  const question = store.revision(review_id).items.find((i) => i.choices?.length)!;
  oldApproval(store, review_id, question.id);
  assert.deepEqual(unansweredQuestions(store, review_id), []);
  assert.deepEqual(exportedAnswers(store, review_id), [
    { section: question.id, question: question.title, choice: "a", answer: "No: keep the production design" },
  ]);
  person(terminal, review_id, { verdict: "approved" });
  assert.equal(store.meta(review_id).status, "approved", "the stored answer counts, as it does everywhere else");
});

test("#381: an old approval of a review Claude submitted keeps its recommended answer in the export", () => {
  const { hoop, review_id } = setup();
  const question = hoop.store.revision(review_id).items.find((i) => i.choices?.length)!;
  oldApproval(hoop.store, review_id, question.id);
  hoop.store.update(review_id, { status: "approved", approved_revision: 1 });
  const exported = op("export").run(hoop, { review_id }, { actor: "claude" }) as { answers?: unknown };
  assert.deepEqual(exported.answers, [{ section: question.id, question: question.title, choice: "a", answer: "No: keep the production design" }]);
  assert.equal(unansweredQuestions(hoop.store, review_id).length, 0);
});
