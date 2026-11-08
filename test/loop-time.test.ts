// The person's loop time: from Claude's requests to their responses, read from what hoop keeps.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import type { ActionItem } from "../src/actions.js";
import { Hoop } from "../src/hoop.js";
import { loopTimes, loopTimeText, type Wait, waits } from "../src/loop-time.js";
import { median } from "../src/util.js";
import { parseMarkdown } from "../src/markdown.js";
import { Store } from "../src/store.js";
import { hoopArgs, TEST_SESSION, tempHome } from "./helpers.js";

const T0 = Date.parse("2026-11-08T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const DOC = parseMarkdown("# Ship the export\n\nThe plan for the export.\n\n## Steps\n\nWrite it.\n");

test("the median is the middle value, or the mean of the two middle ones", () => {
  assert.equal(median([]), undefined);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("loop time is the median from request to the person's first response, per kind, with what still waits", () => {
  const w = (kind: Wait["kind"], asked: number, answered?: number): Wait => ({
    kind,
    id: "x",
    asked: at(asked),
    ...(answered === undefined ? {} : { answered: at(answered) }),
  });
  const rows = loopTimes([w("review", 0, 10), w("review", 0, 30), w("review", 0, 20), w("review", 5), w("question", 0, 2), w("action", 0)]);
  assert.deepEqual(rows, [
    { kind: "review", label: "Reviews", answered: 3, waiting: 1, median_ms: 20 * 60_000 },
    { kind: "question", label: "Quick questions", answered: 1, waiting: 0, median_ms: 2 * 60_000 },
    { kind: "action", label: "Action items", answered: 0, waiting: 1 },
  ]);
  assert.equal(
    loopTimeText(rows),
    [
      "How long you take to answer Claude, from its request to your first response, on this machine:",
      "  Reviews          20 m median, of 3; 1 waiting",
      "  Quick questions  2 m median, of 1",
      "  Action items     none answered yet; 1 waiting",
      "These numbers stay on this machine.",
      "",
    ].join("\n"),
  );
});

test("each review revision, quick question and action item is a request; only the person's response answers it", () => {
  const home = tempHome();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  try {
    const hoop = new Hoop(new Store(home), TEST_SESSION);
    // A review: the person asks for changes 12 minutes after revision 1, and approves revision 2 after 3.
    const { review_id } = hoop.submit(DOC);
    mock.timers.setTime(T0 + 12 * 60_000);
    const asked = hoop.review(
      review_id,
      { verdict: "changes_requested", reviewer: "ankur", comments: [{ item: "DOC", line: 1, body: "Say when." }], answers: [] },
      true,
    );
    mock.timers.setTime(T0 + 20 * 60_000);
    hoop.store.addRevision(review_id, DOC);
    utimesSync(join(hoop.store.dirOf(review_id), "rev-2.json"), new Date(at(20)), new Date(at(20)));
    mock.timers.setTime(T0 + 23 * 60_000);
    hoop.review(review_id, { verdict: "approved", reviewer: "ankur", comments: [], answers: [], resolved_threads: [asked.comments[0]!.thread!] }, true);

    // A quick question, answered after 1 minute; another, withdrawn unanswered, isn't counted.
    mock.timers.setTime(T0);
    const ask = hoop.ask({ questions: [{ question: "Keep the alias?", options: [{ label: "Keep", recommended: true }, { label: "Remove" }] }] });
    const gone = hoop.ask({ questions: [{ question: "Rename it?", options: [{ label: "Yes", recommended: true }, { label: "No" }] }] });
    mock.timers.setTime(T0 + 60_000);
    hoop.answer(ask.review_id, { recommended: true });
    hoop.withdraw(gone.review_id, "found it");

    // A review still waiting on the person, and one the person opened from a file, which Claude never asked for.
    hoop.submit(parseMarkdown("# Pick a queue\n\nWhich queue.\n\n## Options\n\nTwo.\n"));
    hoop.store.create(DOC, { opened_by: "ankur" });

    const item = (state: ActionItem["state"], closed_by?: string, closed?: number): ActionItem =>
      ({ id: `ac_${state}${closed_by ?? ""}`, created: at(0), state, ...(closed_by ? { closed_by, closed_at: at(closed!) } : {}) }) as ActionItem;
    const actions = [item("done", "ankur", 90), item("wont_do", "ankur", 30), item("done", "hoop", 5), item("withdrawn", "session 0e7a1c52", 1), item("open")];

    const rows = loopTimes(waits(hoop.store, actions));
    assert.deepEqual(
      rows.map((r) => [r.kind, r.answered, r.waiting, r.median_ms === undefined ? undefined : r.median_ms / 60_000]),
      [
        // Revision 1 took 12 minutes, revision 2 took 3: the median is 7.5. The other review waits.
        ["review", 2, 1, 7.5],
        ["question", 1, 0, 1],
        // Ticked done after 90 minutes and Won't do after 30; hoop's own check and a withdrawal aren't answers.
        ["action", 2, 1, 60],
      ],
    );
  } finally {
    mock.timers.reset();
  }
});

const reviewRow = (store: Store) => loopTimes(waits(store, [])).find((r) => r.kind === "review")!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a finished build's revisions up to its Finish aren't Claude's requests; a later revision Claude submits is", async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home), TEST_SESSION);
  const { review_id } = hoop.startBuild("# Draft the export plan\n\nNotes.\n\n## Steps\n\nWrite it.\n");
  hoop.finishBuild(review_id);
  await sleep(20);
  // Regression: the Finish revision counted as Claude's request, timed from the person's own click.
  const first = hoop.review(
    review_id,
    { verdict: "changes_requested", reviewer: "ankur", comments: [{ item: "DOC", line: 1, body: "Say when." }], answers: [] },
    true,
  );
  assert.deepEqual(reviewRow(hoop.store), { kind: "review", label: "Reviews", answered: 0, waiting: 0 });
  await sleep(20);
  hoop.store.addRevision(review_id, DOC);
  assert.deepEqual(reviewRow(hoop.store), { kind: "review", label: "Reviews", answered: 0, waiting: 1 });
  await sleep(20);
  hoop.review(review_id, { verdict: "approved", reviewer: "ankur", comments: [], answers: [], resolved_threads: [first.comments[0]!.thread!] }, true);
  const row = reviewRow(hoop.store);
  assert.deepEqual([row.answered, row.waiting], [1, 0]);
  assert.ok(row.median_ms! >= 0 && row.median_ms! < 60_000, String(row.median_ms));
});

test("a revision whose file time is after the first feedback on it (a copied folder) is left out, not timed", () => {
  const home = tempHome();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  try {
    const hoop = new Hoop(new Store(home), TEST_SESSION);
    const { review_id } = hoop.submit(DOC);
    mock.timers.setTime(T0 + 5 * 60_000);
    const asked = hoop.review(
      review_id,
      { verdict: "changes_requested", reviewer: "ankur", comments: [{ item: "DOC", line: 1, body: "Say when." }], answers: [] },
      true,
    );
    mock.timers.setTime(T0 + 10 * 60_000);
    hoop.store.addRevision(review_id, DOC);
    mock.timers.setTime(T0 + 15 * 60_000);
    hoop.review(review_id, { verdict: "approved", reviewer: "ankur", comments: [], answers: [], resolved_threads: [asked.comments[0]!.thread!] }, true);
    // As a copy leaves it: revision 2's file a day after the approval of it.
    utimesSync(join(hoop.store.dirOf(review_id), "rev-2.json"), new Date(at(24 * 60)), new Date(at(24 * 60)));
    const row = reviewRow(hoop.store);
    // Revision 1 took 5 minutes. Regression: revision 2 was timed from its own approval, a 0 ms answer
    // that pulled the median down; its time can't be trusted, so it counts neither answered nor waiting.
    assert.deepEqual(row, { kind: "review", label: "Reviews", answered: 1, waiting: 0, median_ms: 5 * 60_000 });
    // Its file time alone, before any feedback on it, is trusted as before.
    utimesSync(join(hoop.store.dirOf(review_id), "rev-2.json"), new Date(at(12)), new Date(at(12)));
    assert.deepEqual(reviewRow(hoop.store), { kind: "review", label: "Reviews", answered: 2, waiting: 0, median_ms: 4 * 60_000 });
  } finally {
    mock.timers.reset();
  }
});

test("a session's own comment on a review isn't the person's response", () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home), TEST_SESSION);
  const { review_id } = hoop.submit(DOC);
  const other = new Hoop(hoop.store, "other-session-0001");
  other.comment(review_id, { item: "DOC", line: 1, body: "Looks fine to me." });
  assert.deepEqual(
    loopTimes(waits(hoop.store, [])).find((r) => r.kind === "review"),
    { kind: "review", label: "Reviews", answered: 0, waiting: 1 },
  );
});

test("hoop loop-time prints the loop times, or JSON, and refuses other flags", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [...hoopArgs, "loop-time", ...args], { encoding: "utf8" });
  const text = run();
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^How long you take to answer Claude, from its request to your first response, on this machine:\n {2}Reviews {10}/);
  assert.match(text.stdout, /These numbers stay on this machine\.\n$/);
  const json = run("--json");
  assert.deepEqual(
    JSON.parse(json.stdout).map((r: { kind: string }) => r.kind),
    ["review", "question", "action"],
  );
  assert.equal(run("--send").status, 2);
});
