import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { sessionLabel, sessionName } from "../src/owner.js";
import { Store } from "../src/store.js";
import { reviewView } from "../src/web.js";
import { cli, example, TEST_SESSION, tempHome, tsx } from "./helpers.js";

/** Writes a session's transcript into the test's Claude Code folder, under a project folder of its own. */
function transcript(session: string, lines: unknown[], project = "-tmp-project") {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "projects", project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session}.jsonl`), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

const OTHER = "other-session-1111";
const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  assert.fail("expected a refusal");
};

/** A review with one comment from a person, submitted by the test's session. */
function reviewed(home = tempHome()) {
  const owner = new Hoop(new Store(home));
  const { review_id } = owner.submit(example());
  const fb = owner.review(review_id, { verdict: "comment", reviewer: "ana", comments: [{ item: "FR-3", line: 1, body: "Inclusive?" }] });
  return { owner, review_id, thread: fb.comments[0]!.thread!, home };
}

test("a session's name is its last custom title, else its last generated title, read from the transcript's end", () => {
  transcript("named-1", [
    { type: "user", message: "hi" },
    { type: "ai-title", aiTitle: "Generated one" },
    { type: "custom-title", customTitle: "First name" },
    { type: "ai-title", aiTitle: "Generated two" },
    { type: "custom-title", customTitle: "Export plan" },
    "{ not json",
  ]);
  assert.equal(sessionName("named-1"), "Export plan");
  transcript(
    "named-2",
    [
      { type: "ai-title", aiTitle: "Old" },
      { type: "ai-title", aiTitle: "Fix the login bug" },
    ],
    "-other-project",
  );
  assert.equal(sessionName("named-2"), "Fix the login bug");
  transcript("named-3", [{ type: "user", message: "no title" }]);
  assert.equal(sessionName("named-3"), undefined);
  assert.equal(sessionName("missing-session"), undefined);
  assert.equal(sessionName("../escape"), undefined);
  // Only the end of a large transcript is read: a title far before it isn't seen.
  transcript("named-4", [{ type: "custom-title", customTitle: "Too early" }, "x".repeat(2 * 1024 * 1024), { type: "ai-title", aiTitle: "Near the end" }]);
  assert.equal(sessionName("named-4"), "Near the end");
  assert.equal(sessionLabel({ session: "abcdef1234567890", name: "Export plan" }), "Export plan (abcdef12)");
  assert.equal(sessionLabel({ session: "abcdef1234567890" }), "session abcdef12");
});

test("submit records the session that owns the review, with its name, and feedback and the page show it", () => {
  transcript("owner-session-2222", [{ type: "custom-title", customTitle: "Order export" }]);
  const hoop = new Hoop(new Store(tempHome()), "owner-session-2222");
  const sub = hoop.submit(example());
  assert.deepEqual(hoop.store.meta(sub.review_id).owner, { session: "owner-session-2222", name: "Order export" });
  assert.equal(sub.owner, "Order export (owner-se)");
  assert.equal(hoop.feedback(sub.review_id).owner, "Order export (owner-se)");
  assert.equal(reviewView(hoop, sub.review_id).meta.owner, "Order export (owner-se)");
  // A revision reads the name again, so a renamed session shows its new title.
  transcript("owner-session-2222", [
    { type: "custom-title", customTitle: "Order export" },
    { type: "custom-title", customTitle: "CSV export" },
  ]);
  hoop.submit({ ...example(), review_id: sub.review_id });
  assert.equal(hoop.feedback(sub.review_id).owner, "CSV export (owner-se)");
});

test("only the owner session revises, replies or proposes edits; any session reads and exports", () => {
  transcript(TEST_SESSION, [{ type: "ai-title", aiTitle: "Owner work" }]);
  const { owner, review_id, thread, home } = reviewed();
  const other = new Hoop(new Store(home), OTHER);
  const who = "Owner work (test-ses)";
  assert.equal(
    errorOf(() => other.submit({ ...example(), review_id })),
    `Only the session that submitted this review can revise it: ${who}. Comment on it with hoop_comment instead.`,
  );
  assert.match(
    errorOf(() => other.reply(thread, "Yes.")),
    new RegExp(`can reply in its threads: ${who.replace(/[()]/g, "\\$&")}`),
  );
  assert.match(
    errorOf(() => other.proposeEdits(review_id, thread, [{ item: "FR-3", line: 1, find: "orders", replace: "all orders" }])),
    /can propose edits to it: Owner work/,
  );
  assert.equal(owner.store.meta(review_id).revisions, 1);
  assert.equal(owner.store.replies(review_id).length, 0);
  assert.equal(other.feedback(review_id).status, "reviewed");
  // The owner may do each.
  assert.equal(owner.reply(thread, "Yes, both bounds.").author, who);
  assert.equal(owner.proposeEdits(review_id, thread, [{ item: "FR-3", line: 1, find: "created", replace: "placed" }]).proposals.length, 1);
  assert.equal(owner.submit({ ...example(), review_id }).outcome, "revised");
  // Superseding an approved review is a revision too.
  owner.review(review_id, { verdict: "approved" });
  assert.match(
    errorOf(() => other.submit({ ...example(), review_id })),
    /can revise it/,
  );
  assert.equal(owner.submit({ ...example(), review_id }).outcome, "superseded");
});

test("another session comments with hoop_comment, named after its session; a page can't claim a session", () => {
  transcript(OTHER, [{ type: "custom-title", customTitle: "Security pass" }]);
  const { review_id, thread, home } = reviewed();
  const other = new Hoop(new Store(home), OTHER);
  const fb = other.comment(review_id, { item: "FR-3", line: 1, body: "Name the time zone." });
  assert.deepEqual([fb.verdict, fb.reviewer, fb.session], ["comment", "Security pass (other-se)", { id: OTHER, name: "Security pass" }]);
  assert.equal(other.comment(review_id, { words: "created", item: "FR-3", body: "Which clock?" }).comments[0]!.line, 1);
  assert.equal(other.comment(review_id, { thread, body: "Agreed." }).comments[0]!.thread, thread);
  assert.match(
    errorOf(() => other.comment(review_id, { body: "Where?" })),
    /needs an item and a line/,
  );
  assert.match(
    errorOf(() => other.comment(review_id, { item: "FR-3", line: 1, body: " " })),
    /needs text/,
  );
  const forged = other.review(
    review_id,
    { verdict: "comment", reviewer: "page", session: { id: "forged" }, comments: [{ item: "FR-3", line: 1, body: "x" }] },
    { signin: { enabled: false } },
  );
  assert.equal(forged.session, undefined);
  other.review(review_id, { verdict: "approved" });
  assert.match(
    errorOf(() => other.comment(review_id, { item: "FR-3", line: 1, body: "late" })),
    /approved and frozen/,
  );
});

test("a process outside any Claude Code session only reads", () => {
  const { review_id, thread, home } = reviewed();
  const terminal = new Hoop(new Store(home), null);
  for (const fn of [
    () => terminal.submit(example()),
    () => terminal.submit({ ...example(), review_id }),
    () => terminal.reply(thread, "Yes."),
    () => terminal.proposeEdits(review_id, thread, [{ item: "FR-3", line: 1, find: "created", replace: "placed" }]),
    () => terminal.comment(review_id, { item: "FR-3", line: 1, body: "Hm." }),
  ])
    assert.match(errorOf(fn), /isn't in a Claude Code session \(CLAUDE_CODE_SESSION_ID is not set\), so it can only read reviews/);
  assert.equal(terminal.feedback(review_id).status, "reviewed");
});

test("a review from before owners belongs to the first session that revises, replies or proposes on it", () => {
  const { owner, review_id, thread, home } = reviewed();
  const { owner: _drop, ...legacy } = owner.store.meta(review_id);
  writeFileSync(join(owner.store.dirOf(review_id), "review.json"), JSON.stringify(legacy));
  assert.equal(owner.feedback(review_id).owner, undefined);
  const other = new Hoop(new Store(home), OTHER);
  other.reply(thread, "Taking this one.");
  assert.equal(owner.store.meta(review_id).owner?.session, OTHER);
  assert.match(
    errorOf(() => owner.submit({ ...example(), review_id })),
    /can revise it: .*\(other-se\)/,
  );
  // The same for the first revision.
  const second = reviewed(home);
  const { owner: _o, ...plain } = second.owner.store.meta(second.review_id);
  writeFileSync(join(second.owner.store.dirOf(second.review_id), "review.json"), JSON.stringify(plain));
  assert.equal(other.submit({ ...example(), review_id: second.review_id }).outcome, "revised");
  assert.equal(other.store.meta(second.review_id).owner?.session, OTHER);
});

test("hoop comment and the owner rules from the terminal, by each process's session", () => {
  const home = tempHome(),
    repo = tempHome();
  const env = (session?: string) => {
    const e: Record<string, string> = { ...(process.env as Record<string, string>), HOOP_HOME: home, HOOP_REPO_DIR: repo };
    if (session) e.CLAUDE_CODE_SESSION_ID = session;
    else delete e.CLAUDE_CODE_SESSION_ID;
    return e;
  };
  const run = (args: string[], session?: string, input?: string) => {
    const r = spawnSync(process.execPath, [tsx, cli, ...args], { encoding: "utf8", env: env(session), input });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const file = join(repo, "plan.md");
  writeFileSync(file, "# Plan\n\nShip it.\n\n## Steps\n\n- One.\n");
  const sub = run(["submit", file, "--json"], "cli-owner-3333");
  assert.equal(sub.code, 0, sub.err);
  const id = JSON.parse(sub.out).review_id;
  const commented = run(["comment", id, "DOC", "1", "A", "better", "title?", "--json"], "cli-other-4444");
  assert.equal(commented.code, 0, commented.err);
  const fb = JSON.parse(commented.out);
  assert.deepEqual([fb.reviewer, fb.comments[0].body, fb.session.id], ["session cli-othe", "A better title?", "cli-other-4444"]);
  const denied = run(["reply", fb.comments[0].thread, "No."], "cli-other-4444");
  assert.equal(denied.code, 1);
  assert.match(denied.err, /Only the session that submitted this review can reply in its threads: session cli-owne/);
  const terminal = run(["submit", file, "--review", id]);
  assert.equal(terminal.code, 1);
  assert.match(terminal.err, /can only read reviews/);
  assert.equal(run(["feedback", id]).code, 0);
  assert.equal(run(["export", id]).code, 0);
  assert.equal(run(["reply", fb.comments[0].thread, "Yes."], "cli-owner-3333").code, 0);
  // The plan hook acts for the session its input names when the environment names none.
  const hook = spawnSync(process.execPath, [tsx, cli, "plan-review"], {
    encoding: "utf8",
    env: { ...env(), HOOP_PLAN_WAIT_SECONDS: "1" },
    input: JSON.stringify({ session_id: "hook-session-5555", tool_input: { plan: "# Plan\n\n1. Go.\n" } }),
  });
  const decision = JSON.parse(hook.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /No verdict on the plan yet/);
  const planId = JSON.parse(readFileSync(join(home, "plans", "hook-session-5555.json"), "utf8")).review_id;
  assert.equal(new Store(home).meta(planId).owner?.session, "hook-session-5555");
});
