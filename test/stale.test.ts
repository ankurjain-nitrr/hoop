import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop, HoopError } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { clientHoop, Remote, runOp } from "../src/remote.js";
import { example, pagesFor, TEST_SESSION, tempHome } from "./helpers.js";

const op = (name: string) => OPS.find((o) => o.name === name)!;
const doc = (n: number) => `# Build plan\n\nHow we build the service, revision ${n}.\n\n## Steps\n\nBuild it on the CI runner, step ${n}.\n`;
const submit = (hoop: Hoop, input: Record<string, unknown>) => op("submit").run(hoop, input, { actor: "claude" }) as { review_id: string; revision: number };

/** The refusal `fn` throws, which must be a HoopError. */
function refusal(fn: () => unknown): HoopError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof HoopError, String(err));
    return err;
  }
  assert.fail("expected a refusal");
}

test("regression #157: a revision over an unread comment is refused with the comment, and accepted once it was read", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = submit(hoop, { markdown: doc(1) });
  for (let n = 2; n <= 4; n++) assert.equal(submit(hoop, { markdown: doc(n), review_id, base_revision: n - 1 }).revision, n);
  const steps = hoop.store.revision(review_id).items[0]!.id;
  hoop.review(review_id, {
    verdict: "comment",
    reviewer: "ankur",
    comments: [{ item: steps, line: 1, body: "all of this needs to be built via docker compose running locally" }],
  });
  // The agent never read the comment and submits revision 5.
  const err = refusal(() => submit(hoop, { markdown: doc(5), review_id, base_revision: 4 }));
  assert.match(err.message, /hoop didn't revise .*1 review you hadn't read, in detail\.unread.*base_revision 4/);
  assert.equal(err.detail?.latest_revision, 4);
  const unread = err.detail?.unread as { revision: number; comments: { body: string }[] }[];
  assert.deepEqual(
    unread.map((f) => [f.revision, f.comments[0]!.body]),
    [[4, "all of this needs to be built via docker compose running locally"]],
  );
  assert.equal(hoop.store.meta(review_id).revisions, 4, "nothing was revised");
  // The refusal handed the comment over, so reading it and submitting again goes through.
  op("feedback").run(hoop, { review_id }, { actor: "claude" });
  assert.equal(submit(hoop, { markdown: doc(5), review_id, base_revision: 4 }).revision, 5);
});

test("a submit without base_revision is still refused over unread feedback, and the refusal counts as reading it", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  hoop.review(review_id, { verdict: "changes_requested", reviewer: "ana", summary: "Split it." });
  const err = refusal(() => hoop.submit({ ...example(), review_id }));
  assert.equal((err.detail!.unread as { summary: string }[])[0]!.summary, "Split it.");
  assert.deepEqual(Object.keys(hoop.store.receipts(review_id)), ["1.0"]);
  assert.equal(hoop.submit({ ...example(), review_id }).revision, 2);
});

test("a base_revision behind a revision a reviewer's Apply made is refused, naming the latest", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const fb = hoop.review(review_id, {
    verdict: "comment",
    comments: [{ item: "FR-1", line: 2, suggestion: "Rows shall stream to the client as they are read." }],
  });
  hoop.receive(review_id);
  assert.equal(hoop.applySuggestion(review_id, fb.comments[0]!.thread!, "ankur").revision, 2);
  const err = refusal(() => hoop.submit({ ...example(), review_id }, 1));
  assert.match(err.message, /builds on revision 1, but revision 2 is the latest; read it with hoop_export/);
  assert.deepEqual(err.detail, { latest_revision: 2, unread: [] });
  assert.throws(() => hoop.submit({ ...example(), review_id }, 3), /builds on revision 3, but revision 2 is the latest/);
  assert.equal(hoop.store.meta(review_id).revisions, 2);
  assert.equal(hoop.submit({ ...example(), review_id }, 2).revision, 3);
});

test("a review left on an earlier revision that the agent never read is refused too, after an Apply moved past it", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const fb = hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-1", line: 2, suggestion: "Rows shall stream." }] });
  hoop.applySuggestion(review_id, fb.comments[0]!.thread!);
  // hoop_feedback shows only revision 2, which has no review; the refusal still hands over revision 1's.
  const err = refusal(() => hoop.submit({ ...example(), review_id }, 2));
  assert.deepEqual(
    (err.detail!.unread as { revision: number }[]).map((f) => f.revision),
    [1],
  );
  assert.equal(hoop.submit({ ...example(), review_id }, 2).revision, 3);
});

test("the refusal reaches a session through the pages process with its detail, and --base reaches the CLI's submit", async () => {
  const home = tempHome();
  const env = await pagesFor(home);
  const hoop = clientHoop({ session: TEST_SESSION, claude: false }, home);
  hoop.remote = new Remote(home, Number(env.HOOP_PORT), { start: false });
  const { review_id } = (await runOp(hoop, op("submit"), { markdown: doc(1) }, { actor: "claude" })) as { review_id: string };
  // Another session comments, as a reviewer does with hoop_comment.
  const reviewer = clientHoop({ session: "reviewer-session", claude: false }, home);
  reviewer.remote = hoop.remote;
  await runOp(reviewer, op("comment"), { review_id, item: "DOC", line: 1, body: "Name the runner." }, { actor: "claude" });
  const err = await runOp(hoop, op("submit"), { markdown: doc(2), review_id, base_revision: 1 }, { actor: "claude" }).then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof HoopError);
  assert.equal(err.detail?.latest_revision, 1);
  assert.equal((err.detail!.unread as { comments: { body: string }[] }[])[0]!.comments[0]!.body, "Name the runner.");
  const again = (await runOp(hoop, op("submit"), { markdown: doc(2), review_id, base_revision: 1 }, { actor: "claude" })) as { revision: number };
  assert.equal(again.revision, 2);
  assert.equal(op("submit").cli!.parse({ pos: ["/dev/null"], flags: { review: review_id, base: "2" } }).base_revision, 2);
});
