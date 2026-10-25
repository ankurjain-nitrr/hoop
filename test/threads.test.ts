import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop, type FeedbackResult, type SubmitResult } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { cli, pagesFor, TEST_SESSION, tempHome, tsx } from "./helpers.js";

const op = (name: string) => OPS.find((o) => o.name === name)!;
const doc = (step: string) => `# Build plan\n\nHow we build the service.\n\n## Steps\n\n${step}\n\n## Rollout\n\nShip it on Friday.\n`;
const submit = (hoop: Hoop, input: Record<string, unknown>) => op("submit").run(hoop, input, { actor: "claude" }) as SubmitResult;
const feedback = (hoop: Hoop, review_id: string) => op("feedback").run(hoop, { review_id }, { actor: "claude" }) as FeedbackResult;
// Entries are ordered by time, so steps that a person and Claude take one after another are a few milliseconds apart.
const tick = () => new Promise((r) => setTimeout(r, 5));

/** A review on revision 1 with a reviewer's comment on the Steps line. */
function commented() {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  const { review_id } = submit(hoop, {
    markdown: doc("Build it on the CI runner."),
  });
  const steps = hoop.store.revision(review_id).items.find((i) => i.title === "Steps")!.id;
  const fb = hoop.review(review_id, {
    verdict: "comment",
    reviewer: "ankur",
    comments: [
      {
        item: steps,
        line: 1,
        body: "all of this needs to be built via docker compose running locally",
      },
    ],
  });
  return { hoop, review_id, steps, thread: fb.comments[0]!.thread! };
}

test("regression #157: a comment on an earlier revision stays in hoop_feedback once a newer revision exists", async () => {
  const { hoop, review_id, steps, thread } = commented();
  feedback(hoop, review_id);
  await tick();
  submit(hoop, {
    markdown: doc("Build it with docker compose."),
    review_id,
    base_revision: 1,
  });
  const result = feedback(hoop, review_id);
  // Revision 2 has no feedback of its own, but the thread from revision 1 is still open.
  assert.equal(result.status, "pending");
  assert.equal(result.revision, 2);
  assert.deepEqual(result.threads, [
    {
      thread,
      status: "unanswered",
      revision: 1,
      item: steps,
      line: 1,
      section: "Steps",
      original_text: "Build it on the CI runner.",
      current_text: "Build it with docker compose.",
      outdated: true,
      entries: [
        {
          by: "ankur",
          role: "reviewer",
          at: result.threads![0]!.entries[0]!.at,
          revision: 1,
          body: "all of this needs to be built via docker compose running locally",
        },
      ],
    },
  ]);
  assert.equal(result.resolved, undefined);
});

test("a thread is answered by Claude's reply or proposed edit, unanswered again when the reviewer adds to it, and resolved by the reviewer", async () => {
  const { hoop, review_id, steps, thread } = commented();
  const status = () => feedback(hoop, review_id).threads?.find((t) => t.thread === thread)?.status ?? "resolved";
  assert.equal(status(), "unanswered");
  await tick();
  hoop.reply(thread, "Switching to docker compose in the next revision.");
  assert.equal(status(), "answered");
  const entries = feedback(hoop, review_id).threads![0]!.entries;
  assert.deepEqual(
    entries.map((e) => [e.role, e.body]),
    [
      ["reviewer", "all of this needs to be built via docker compose running locally"],
      ["owner", "Switching to docker compose in the next revision."],
    ],
  );
  await tick();
  hoop.review(review_id, {
    verdict: "comment",
    reviewer: "ankur",
    comments: [{ thread, body: "And the database too." }],
  });
  assert.equal(status(), "unanswered", "a reviewer adding to an answered thread makes it unanswered");
  await tick();
  const { proposals } = hoop.proposeEdits(review_id, thread, [
    {
      item: steps,
      line: 1,
      find: "on the CI runner",
      replace: "with docker compose",
    },
  ]);
  assert.equal(status(), "answered", "a proposed edit answers the thread");
  await tick();
  hoop.decideEdit(review_id, proposals[0]!.id, "reject", "ankur");
  assert.equal(status(), "unanswered", "rejecting the edit asks again");
  await tick();
  hoop.review(review_id, {
    verdict: "comment",
    reviewer: "ankur",
    resolved_threads: [thread],
  });
  const result = feedback(hoop, review_id);
  assert.equal(result.threads, undefined, "a resolved thread leaves threads");
  assert.deepEqual(result.resolved, [
    {
      thread,
      revision: 1,
      item: steps,
      line: 1,
      section: "Steps",
      outdated: false,
      comment: "all of this needs to be built via docker compose running locally",
    },
  ]);
});

test("a revision's submit result names the threads still unanswered, from any revision", async () => {
  const { hoop, review_id, thread } = commented();
  feedback(hoop, review_id);
  await tick();
  const first = submit(hoop, {
    markdown: doc("Build it with docker compose."),
    review_id,
    base_revision: 1,
  });
  assert.deepEqual(
    first.unanswered_threads?.map((t) => [t.thread, t.revision, t.section, t.outdated]),
    [[thread, 1, "Steps", true]],
  );
  assert.match(first.reminder!, new RegExp(`^1 thread is still unanswered: ${thread} \\(revision 1\\)\\. Answer each with hoop_reply`));
  await tick();
  hoop.reply(thread, "Revision 2 uses docker compose.");
  const second = submit(hoop, {
    markdown: doc("Build it with docker compose, locally."),
    review_id,
    base_revision: 2,
  });
  assert.equal(second.unanswered_threads, undefined);
  assert.equal(second.reminder, undefined);
});

test("another session's comment counts as a reviewer's, and the title's thread is on the document", async () => {
  const { hoop, review_id } = commented();
  const other = new Hoop(hoop.store, "other-session-1111");
  other.comment(review_id, {
    item: "DOC",
    line: 1,
    body: "Name the service in the title.",
  });
  const t = feedback(hoop, review_id).threads!.find((x) => x.item === "DOC")!;
  assert.equal(t.status, "unanswered");
  assert.equal(t.section, "the document");
  assert.equal(t.original_text, "Build plan");
  assert.equal(t.entries[0]!.role, "session");
});

test("a line removed in a later revision has no current text and is outdated", async () => {
  const { hoop, review_id } = commented();
  feedback(hoop, review_id);
  await tick();
  const rollout = hoop.store.revision(review_id).items.find((i) => i.title === "Rollout")!.id;
  hoop.review(review_id, {
    verdict: "comment",
    reviewer: "ankur",
    comments: [{ item: rollout, line: 1, body: "Not on a Friday." }],
  });
  feedback(hoop, review_id);
  await tick();
  submit(hoop, {
    markdown: "# Build plan\n\nHow we build the service.\n\n## Steps\n\nBuild it on the CI runner.\n",
    review_id,
    base_revision: 1,
  });
  const t = feedback(hoop, review_id).threads!.find((x) => x.item === rollout)!;
  assert.deepEqual([t.section, t.original_text, t.current_text, t.outdated], ["Rollout", "Ship it on Friday.", null, true]);
});

test("hoop feedback in the terminal prints the open threads", async () => {
  const { hoop, review_id, thread } = commented();
  const pages = await pagesFor(hoop.store.home);
  const run = spawnSync(process.execPath, [tsx, cli, "feedback", review_id, "--json"], { encoding: "utf8", env: { ...process.env, ...pages } });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout) as FeedbackResult;
  assert.deepEqual(
    out.threads?.map((t) => [t.thread, t.status]),
    [[thread, "unanswered"]],
  );
});

test("a resolved thread reopens: a reviewer's comment makes it unanswered, the owner's reply answered", async () => {
  const { hoop, review_id, thread } = commented();
  const status = () => feedback(hoop, review_id).threads?.find((t) => t.thread === thread)?.status ?? "resolved";
  await tick();
  hoop.review(review_id, { verdict: "comment", reviewer: "ankur", resolved_threads: [thread] });
  assert.equal(status(), "resolved");
  await tick();
  hoop.review(review_id, { verdict: "comment", reviewer: "ankur", comments: [{ thread, body: "One more thing." }] });
  assert.equal(status(), "unanswered", "a reviewer's comment after resolving reopens it");
  await tick();
  hoop.review(review_id, { verdict: "comment", reviewer: "ankur", resolved_threads: [thread] });
  assert.equal(status(), "resolved");
  await tick();
  hoop.reply(thread, "Done in revision 2.");
  assert.equal(status(), "answered", "the owner's reply after resolving reopens it as answered");
});

test("several unanswered threads are named in order in the submit result's reminder", async () => {
  const { hoop, review_id, steps, thread } = commented();
  await tick();
  const second = hoop.review(review_id, { verdict: "comment", reviewer: "ankur", comments: [{ item: steps, line: 0, body: "Rename the section." }] })
    .comments[0]!.thread!;
  feedback(hoop, review_id);
  const result = submit(hoop, { markdown: doc("Build it with docker compose."), review_id, base_revision: 1 });
  assert.deepEqual(
    result.unanswered_threads?.map((t) => t.thread),
    [thread, second],
  );
  assert.match(result.reminder!, new RegExp(`^2 threads are still unanswered: ${thread} \\(revision 1\\), ${second} \\(revision 1\\)\\. `));
});

test("a thread on a review a person opened with hoop open has a status, and reopening the file at a terminal adds no reminder", () => {
  const store = new Store(tempHome());
  const terminal = new Hoop(store, null);
  const file = join(tempHome(), "plan.md");
  writeFileSync(file, doc("Build it on the CI runner."));
  const { review_id } = terminal.open(file);
  const steps = store.revision(review_id).items.find((i) => i.title === "Steps")!.id;
  const t = terminal.review(review_id, { verdict: "comment", reviewer: "ankur", comments: [{ item: steps, line: 1, body: "Which runner?" }] }).comments[0]!
    .thread!;
  assert.deepEqual(
    terminal.feedback(review_id).threads?.map((x) => [x.thread, x.status]),
    [[t, "unanswered"]],
  );
  writeFileSync(file, doc("Build it on the self-hosted runner."));
  const reopened = terminal.open(file);
  assert.equal(reopened.outcome, "revised");
  assert.equal(reopened.unanswered_threads, undefined);
  assert.equal(reopened.reminder, undefined);
});

/** This test process as a running Claude Code session, as `sessions/<pid>.json` in the temp HOOP_CLAUDE_DIR; `/clear` rewrites it with a new ID. */
function claudeProcess() {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.json`);
  const d = new Date(Date.now() - process.uptime() * 1000);
  const procStart = `${d.toUTCString().slice(0, 3)} ${d.toUTCString().slice(8, 11)} ${String(d.getUTCDate()).padStart(2, " ")} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`;
  const write = (sessionId: string) =>
    writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId, cwd: "/tmp/proj", startedAt: 1792839161891, procStart, kind: "interactive" }));
  return { write, remove: () => rmSync(file, { force: true }) };
}

test("the owner's own hoop_comment counts as the owner's, before and after /clear gives it a new ID", async () => {
  const claude = claudeProcess();
  try {
    claude.write(TEST_SESSION);
    const { hoop, review_id, thread } = commented();
    await tick();
    const own = hoop.comment(review_id, { thread, body: "Answered by the owner's comment." });
    assert.equal(own.session?.id, TEST_SESSION);
    const view = () => feedback(hoop, review_id).threads!.find((t) => t.thread === thread)!;
    assert.deepEqual([view().status, view().entries.at(-1)!.role], ["answered", "owner"]);
    // /clear: the same process now runs a new session ID, which acts as the owner.
    const cleared = "a344f2e4-455b-4293-bb0f-0203b0b08a1d";
    claude.write(cleared);
    const after = new Hoop(hoop.store, cleared);
    await tick();
    hoop.review(review_id, { verdict: "comment", reviewer: "ankur", comments: [{ thread, body: "And the cache?" }] });
    await tick();
    after.comment(review_id, { thread, body: "The cache too." });
    assert.equal(view().status, "answered", "the new ID's comment is the owner's");
    // Once the new ID revises, it is the owner, and the old ID's comments stay the owner's.
    op("feedback").run(after, { review_id }, { actor: "claude" });
    submit(after, { markdown: doc("Build it with docker compose."), review_id, base_revision: 1 });
    assert.equal(hoop.store.meta(review_id).owner?.session, cleared);
    assert.deepEqual(
      view().entries.map((e) => e.role),
      ["reviewer", "owner", "reviewer", "owner"],
    );
  } finally {
    claude.remove();
  }
});
