// The gate on file writes while a session's own review waits on the person (rv_mw7pt2ccf618dc).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop, reviewUrl } from "../src/hoop.js";
import { parseMarkdown } from "../src/markdown.js";
import { reviewMarkPath } from "../src/review-mark.js";
import { reviewGate } from "../src/review-gate.js";
import { shellWrites, writesFiles } from "../src/shell-writes.js";
import { Store } from "../src/store.js";
import { TEST_SESSION, tempHome } from "./helpers.js";

const DOC = parseMarkdown("# Back up the orders database nightly\n\nThe backup plan.\n\n## Script\n\nscripts/backup.sh dumps the database.\n");
const call = (tool_name: string, tool_input: Record<string, unknown>, session = TEST_SESSION) => ({
  session_id: session,
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input,
});
const write = call("Write", { file_path: "scripts/backup.sh", content: "#!/bin/sh\n" });

test("a file write while the session's review waits on the person is refused once per revision, naming the review and the way out", () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  const { review_id } = hoop.submit(DOC);
  const mark = reviewMarkPath(hoop.store.home, TEST_SESSION);
  assert.ok(existsSync(mark), "the submit marks the session for the gate");

  // Regression (#212, never-approves 3/3): Claude wrote the script straight after submitting the plan.
  const deny = reviewGate(hoop.store, write);
  assert.equal(
    deny,
    `Your review "Back up the orders database nightly" (${reviewUrl(review_id)}) waits on the person to review revision 1, so hold off on changing files ` +
      `for the work it plans until they approve it. Wait with hoop_wait ${review_id}, or end your turn and hoop tells you when they review. ` +
      "If this change isn't part of that work, make it again: it goes on (hoop says this once for each revision).",
  );
  assert.equal(existsSync(mark), false, "told, so later calls start no process");
  assert.equal(reviewGate(hoop.store, write), undefined, "the same write again goes on");

  // A new revision waits again: one more refusal.
  hoop.submit({ ...DOC, review_id }, 1);
  assert.match(reviewGate(hoop.store, call("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" })) ?? "", /to review revision 2,/);
  assert.equal(reviewGate(hoop.store, write), undefined);
});

test("the person's review, a close or another session's review leaves file writes alone", () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  const { review_id } = hoop.submit(DOC);
  hoop.review(review_id, { verdict: "approved", reviewer: "ana", comments: [], answers: [] }, true);
  assert.equal(reviewGate(hoop.store, write), undefined, "approved: nothing waits");
  assert.equal(existsSync(reviewMarkPath(hoop.store.home, TEST_SESSION)), false, "and the gate file goes");

  const asked = hoop.submit(parseMarkdown("# Pick a queue\n\nWhich queue.\n\n## Options\n\nTwo.\n"));
  hoop.review(asked.review_id, { verdict: "changes_requested", reviewer: "ana", comments: [{ item: "DOC", line: 1, body: "Name it." }], answers: [] }, true);
  assert.equal(reviewGate(hoop.store, write), undefined, "reviewed: Claude has feedback to act on, not a wait");

  const closed = hoop.submit(parseMarkdown("# Rename the job\n\nRename it.\n\n## Steps\n\nDo it.\n"));
  hoop.store.update(closed.review_id, { closed: { by: "ana", at: new Date().toISOString() } });
  assert.equal(reviewGate(hoop.store, write), undefined, "closed: nothing waits");

  // The plan hook's review of the session's plan: plan mode already holds the writes.
  const planned = hoop.submit(parseMarkdown("# Plan\n\nThe plan.\n\n## Steps\n\nDo it.\n"));
  mkdirSync(join(hoop.store.home, "plans"), { recursive: true });
  writeFileSync(join(hoop.store.home, "plans", `${TEST_SESSION}.json`), JSON.stringify({ review_id: planned.review_id, hash: "h", cursor: "1.0" }));
  assert.equal(reviewGate(hoop.store, write), undefined, "the plan's own review isn't a cause");

  const other = new Hoop(hoop.store, "other-session-0001");
  other.submit(DOC);
  assert.equal(reviewGate(hoop.store, write), undefined, "another session's review isn't this session's wait");
  assert.match(reviewGate(hoop.store, call("Write", { file_path: "x" }, "other-session-0001")) ?? "", /^Your review /);
});

test("only file tools and shell commands that write are refused; reads and other tools go on, keeping the gate file", () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  hoop.submit(DOC);
  for (const [tool, input] of [
    ["Read", { file_path: "scripts/backup.sh" }],
    ["Bash", { command: "grep -rn backup scripts 2>&1" }],
    ["Bash", { command: "ls scripts > /dev/null" }],
    ["mcp__plugin_hoop_hoop__hoop_wait", { review_id: "rv_x" }],
  ] as const)
    assert.equal(reviewGate(hoop.store, call(tool, input)), undefined, `${tool} ${JSON.stringify(input)}`);
  assert.ok(existsSync(reviewMarkPath(hoop.store.home, TEST_SESSION)), "nothing was told yet");
  assert.match(reviewGate(hoop.store, call("Bash", { command: "cat > scripts/backup.sh <<'EOF'\n#!/bin/sh\nEOF" })) ?? "", /^Your review /);
  // What counts as a write, shared with the eval checks.
  assert.deepEqual(["echo x > a", "echo x &> a", "tee a", "sed -i s/a/b/ f", "rm a", "git status", "cat a 2>&1"].map(shellWrites), [
    true,
    true,
    true,
    true,
    false,
    false,
    false,
  ]);
  assert.equal(writesFiles("NotebookEdit", {}), true);
  assert.equal(writesFiles("Glob", {}), false);
});
