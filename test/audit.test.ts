import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readAudit, summarize } from "../src/audit.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import type { AddressInfo } from "node:net";
import { example, mcpClient, tempHome } from "./helpers.js";

test("review activity and Claude's failed tool calls land in the audit log, and summarize into improvement signals", async () => {
  const home = tempHome();
  process.env.HOOP_HOME = home;
  try {
    const hoop = new Hoop(new Store(home));
    const { review_id } = hoop.submit(example());
    const line = example().items[2].body as string,
      at = line.indexOf("created");
    const fb = hoop.review(review_id, {
      verdict: "comment",
      reviewer: "ankur",
      comments: [
        { item: "FR-3", line: 1, range: { start: at, end: at + 7, quote: "created" }, suggestion: "placed" },
        { item: "FR-1", line: 0, body: "softer" },
      ],
    });
    hoop.applySuggestion(review_id, fb.comments[0]!.thread!, "ankur");
    const { proposals } = hoop.proposeEdits(review_id, fb.comments[1]!.thread!, [
      { item: "FR-1", line: 1, find: "a CSV file", replace: "a CSV export" },
      { item: "FR-1", line: 2, find: "never buffered in full", replace: "not buffered" },
    ]);
    hoop.decideEdit(review_id, proposals[0]!.id, "accept", "ankur");
    hoop.decideEdit(review_id, proposals[1]!.id, "reject", "ankur");
    hoop.review(review_id, { verdict: "approved", reviewer: "ankur" });

    const mcp = await mcpClient({ HOOP_HOME: home });
    try {
      await mcp.call("hoop_propose_edits", { review_id, thread: fb.comments[1]!.thread!, edits: [{ item: "FR-1", line: 1, find: "orders", replace: "x" }] });
      await mcp.call("hoop_submit", { document: { ...example(), slug: "Bad Slug" } });
    } finally {
      await mcp.close();
    }

    const events = readAudit(join(home, "audit.jsonl"));
    assert.deepEqual(
      events.filter((e) => e.ok !== false).map((e) => e.event),
      ["submit", "review", "apply_suggestion", "propose_edits", "decide_edit", "decide_edit", "review"],
    );
    const failed = events.filter((e) => e.ok === false);
    assert.deepEqual(
      failed.map((e) => [e.event, e.actor]),
      [
        ["propose_edits", "claude"],
        ["submit", "claude"],
      ],
    );
    assert.match(failed[0]!.error!, /is approved/);
    const s = summarize(events);
    assert.equal(s.reviews, 1);
    assert.equal(s.approved, 1);
    assert.equal(s.suggestions_applied, 1);
    assert.deepEqual(s.edits, { proposed: 2, accepted: 1, rejected: 1, acceptance_rate: 0.5, large_rewrites: 0 });
    assert.equal(s.failures, 2);
    assert.ok(
      s.top_failures.some((f) => f.reason.startsWith("submit: slug:")),
      JSON.stringify(s.top_failures),
    );
    assert.ok(s.median_minutes_to_first_verdict! >= 0);
  } finally {
    delete process.env.HOOP_HOME;
  }
});

test("reviewer actions that fail on the page are logged; HOOP_AUDIT=0 turns logging off", async () => {
  const home = tempHome();
  process.env.HOOP_HOME = home;
  try {
    const hoop = new Hoop(new Store(home));
    const server = createWebServer(hoop);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { review_id } = hoop.submit(example());
    await fetch(`${base}/api/reviews/${review_id}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "comment", comments: [{ item: "FR-1", line: 9, body: "x" }] }),
    });
    server.close();
    const failed = readAudit(join(home, "audit.jsonl")).filter((e) => e.ok === false);
    assert.deepEqual(
      failed.map((e) => [e.event, e.actor, e.errors?.[0]?.split(":")[0]]),
      [["review", "reviewer", "comments.0.line"]],
    );
    process.env.HOOP_AUDIT = "0";
    hoop.submit(example());
    assert.equal(readAudit(join(home, "audit.jsonl")).filter((e) => e.event === "submit").length, 1);
  } finally {
    delete process.env.HOOP_HOME;
    delete process.env.HOOP_AUDIT;
  }
});
