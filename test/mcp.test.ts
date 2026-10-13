import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { example, mcpClient, tempHome } from "./helpers.js";

test("submit over MCP stores the review and returns its id and URL; feedback is pending until reviewed", async () => {
  const home = tempHome();
  const mcp = await mcpClient({ HOOP_HOME: home, HOOP_PORT: "4799" });
  try {
    const tools = (await mcp.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["hoop_cr_classify", "hoop_cr_create", "hoop_cr_get", "hoop_cr_link_pr", "hoop_cr_step", "hoop_export", "hoop_feedback",
      "hoop_propose_edits", "hoop_reply", "hoop_submit", "hoop_submit_markdown", "hoop_tracker_get", "hoop_tracker_set"]);

    const sub = await mcp.call("hoop_submit", { document: example() });
    assert.equal(sub.isError, false);
    assert.match(sub.value.review_id, /^rv_/);
    assert.equal(sub.value.revision, 1);
    assert.equal(sub.value.url, `http://localhost:4799/r/${sub.value.review_id}`);

    const pending = await mcp.call("hoop_feedback", { review_id: sub.value.review_id });
    assert.equal(pending.value.status, "pending");

    new Store(home).addFeedback(sub.value.review_id, {
      schema: "hoop/feedback@0", review_id: sub.value.review_id, revision: 1, verdict: "changes_requested",
      comments: [{ item: "FR-3", line: 1, body: "Use created_at" }], answers: [{ item: "Q-1", choice: "b" }],
      resolved_threads: [], viewed: [], reviewer: "ankur", at: new Date().toISOString(),
    });
    const fb = await mcp.call("hoop_feedback", { review_id: sub.value.review_id });
    assert.equal(fb.value.status, "reviewed");
    assert.equal(fb.value.feedback[0].verdict, "changes_requested");
    assert.match(fb.value.feedback[0].comments[0].thread, new RegExp(`^th_${sub.value.review_id.slice(3)}_1$`));

    const rev2 = await mcp.call("hoop_submit", { document: { ...example(), review_id: sub.value.review_id } });
    assert.equal(rev2.value.revision, 2);
    assert.equal((await mcp.call("hoop_feedback", { review_id: sub.value.review_id })).value.status, "pending");
  } finally {
    await mcp.close();
  }
});

test("invalid documents and unknown reviews come back as tool errors naming the problem", async () => {
  const mcp = await mcpClient({ HOOP_HOME: tempHome() });
  try {
    const bad = await mcp.call("hoop_submit", { document: { ...example(), slug: "Bad Slug" } });
    assert.equal(bad.isError, true);
    assert.equal(bad.value.errors[0].path, "slug");
    const missing = await mcp.call("hoop_feedback", { review_id: "rv_nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.value.error, /no review rv_nope/);
  } finally {
    await mcp.close();
  }
});
