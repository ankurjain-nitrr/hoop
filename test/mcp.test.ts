import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { example, mcpClient, tempHome } from "./helpers.js";

async function toolNames(env: Record<string, string>) {
  const mcp = await mcpClient(env);
  try {
    return (await mcp.client.listTools()).tools.map((t) => t.name);
  } finally {
    await mcp.close();
  }
}

test("hoop offers the same ten tools in every repository", async () => {
  const home = tempHome();
  for (const repo of [tempHome(), new URL("..", import.meta.url).pathname]) {
    const names = await toolNames({ HOOP_HOME: home, HOOP_REPO_DIR: repo });
    assert.deepEqual(names.sort(), [
      "hoop_comment",
      "hoop_export",
      "hoop_feedback",
      "hoop_propose_edits",
      "hoop_reply",
      "hoop_submit",
      "hoop_submit_decision",
      "hoop_submit_markdown",
      "hoop_track_pr",
      "hoop_wait",
    ]);
  }
});

test("each submit tool takes its format, and each old use works and names the new tool", async () => {
  const mcp = await mcpClient({ HOOP_HOME: tempHome() });
  try {
    const md = await mcp.call("hoop_submit", { markdown: "# Plan\n\nShip the export.\n" });
    assert.equal(md.isError, false);
    assert.equal(md.value.outcome, "created");
    assert.equal(md.value.notice, undefined);
    const oldTool = await mcp.call("hoop_submit_markdown", { markdown: "# Plan\n\nShip it.\n" });
    assert.equal(oldTool.isError, false);
    assert.match(oldTool.value.notice, /hoop_submit_markdown is an old name.*use hoop_submit/);
    const oldFormat = await mcp.call("hoop_submit", { document: example() });
    assert.equal(oldFormat.isError, false);
    assert.match(oldFormat.value.notice, /hoop_submit_decision/);
    const decision = await mcp.call("hoop_submit_decision", { document: example() });
    assert.equal(decision.value.notice, undefined);
  } finally {
    await mcp.close();
  }
});

test("hoop_wait returns a review, or says to call again with its cursor", async () => {
  const home = tempHome();
  const mcp = await mcpClient({ HOOP_HOME: home });
  try {
    const sub = (await mcp.call("hoop_submit_decision", { document: example() })).value;
    assert.equal(sub.cursor, "1.0");
    const started = Date.now();
    const pending = await mcp.call("hoop_wait", { review_id: sub.review_id, after: sub.cursor, seconds: 1 });
    assert.ok(Date.now() - started < 45_000);
    assert.equal(pending.value.status, "pending");
    assert.equal(pending.value.again, true);
    assert.match(pending.value.message, /Call hoop_wait again with after: "1\.0"/);
    // A review that lands between two calls returns at once from the next call.
    new Hoop(new Store(home)).review(sub.review_id, { verdict: "comment", summary: "between calls", comments: [{ item: "FR-3", line: 1, body: "Why?" }] });
    const reviewed = await mcp.call("hoop_wait", { review_id: sub.review_id, after: pending.value.cursor, seconds: 1 });
    assert.equal(reviewed.value.status, "reviewed");
    assert.equal(reviewed.value.feedback.at(-1).summary, "between calls");
    assert.equal(reviewed.value.cursor, "1.1");
  } finally {
    await mcp.close();
  }
});

test("submit over MCP stores the review and returns its id and URL; feedback is pending until reviewed", async () => {
  const home = tempHome();
  const mcp = await mcpClient({ HOOP_HOME: home, HOOP_PORT: "4799" });
  try {
    const tools = (await mcp.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [
      "hoop_comment",
      "hoop_export",
      "hoop_feedback",
      "hoop_propose_edits",
      "hoop_reply",
      "hoop_submit",
      "hoop_submit_decision",
      "hoop_submit_markdown",
      "hoop_track_pr",
      "hoop_wait",
    ]);

    const sub = await mcp.call("hoop_submit_decision", { document: example() });
    assert.equal(sub.isError, false);
    assert.match(sub.value.review_id, /^rv_/);
    assert.equal(sub.value.revision, 1);
    assert.equal(sub.value.url, `http://localhost:4799/r/${sub.value.review_id}`);

    const pending = await mcp.call("hoop_feedback", { review_id: sub.value.review_id });
    assert.equal(pending.value.status, "pending");

    new Store(home).addFeedback(sub.value.review_id, {
      schema: "hoop/feedback@0",
      review_id: sub.value.review_id,
      revision: 1,
      verdict: "changes_requested",
      comments: [{ item: "FR-3", line: 1, body: "Use created_at" }],
      answers: [{ item: "Q-1", choice: "b" }],
      resolved_threads: [],
      viewed: [],
      reviewer: "ankur",
      at: new Date().toISOString(),
    });
    const fb = await mcp.call("hoop_feedback", { review_id: sub.value.review_id });
    assert.equal(fb.value.status, "reviewed");
    assert.equal(fb.value.feedback[0].verdict, "changes_requested");
    assert.match(fb.value.feedback[0].comments[0].thread, new RegExp(`^th_${sub.value.review_id.slice(3)}_1$`));

    const rev2 = await mcp.call("hoop_submit_decision", { document: { ...example(), review_id: sub.value.review_id } });
    assert.equal(rev2.value.revision, 2);
    assert.equal((await mcp.call("hoop_feedback", { review_id: sub.value.review_id })).value.status, "pending");
  } finally {
    await mcp.close();
  }
});

test("invalid documents and unknown reviews come back as tool errors naming the problem", async () => {
  const mcp = await mcpClient({ HOOP_HOME: tempHome() });
  try {
    const bad = await mcp.call("hoop_submit_decision", { document: { ...example(), slug: "Bad Slug" } });
    assert.equal(bad.isError, true);
    assert.equal(bad.value.errors[0].path, "slug");
    const missing = await mcp.call("hoop_feedback", { review_id: "rv_nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.value.error, /no review rv_nope/);
  } finally {
    await mcp.close();
  }
});

test("a session learns when and how to use hoop when it connects, with no skill installed", async () => {
  const mcp = await mcpClient({ HOOP_HOME: tempHome() });
  try {
    const text = mcp.client.getInstructions() ?? "";
    for (const words of ["hoop_submit", "hoop_wait", "hoop_feedback", "## Question:", "(recommended)", "Only a person approves", "link"])
      assert.ok(text.includes(words), `the instructions mention ${words}`);
  } finally {
    await mcp.close();
  }
});
