import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { INSTRUCTIONS } from "../src/mcp.js";
import { Store } from "../src/store.js";
import { example, mcpClient, tempHome, pagesFor } from "./helpers.js";

async function toolNames(env: Record<string, string>) {
  const mcp = await mcpClient(env);
  try {
    return (await mcp.client.listTools()).tools.map((t) => t.name);
  } finally {
    await mcp.close();
  }
}

test("hoop offers the same eighteen tools in every repository", async () => {
  const home = tempHome();
  for (const repo of [tempHome(), new URL("..", import.meta.url).pathname]) {
    const names = await toolNames({ ...(await pagesFor(home)), HOOP_REPO_DIR: repo });
    assert.deepEqual(names.sort(), [
      "hoop_action",
      "hoop_action_withdraw",
      "hoop_ask",
      "hoop_build",
      "hoop_build_suggest",
      "hoop_build_wait",
      "hoop_build_write",
      "hoop_comment",
      "hoop_export",
      "hoop_feedback",
      "hoop_propose_edits",
      "hoop_reply",
      "hoop_submit",
      "hoop_submit_decision",
      "hoop_track_pr",
      "hoop_wait",
      "hoop_withdraw",
      "hoop_work_queue",
    ]);
  }
});

test("no tool is an old name for another, so an agent can't pick one over the tool it replaced", async () => {
  const mcp = await mcpClient(await pagesFor(tempHome()));
  try {
    const { tools } = await mcp.client.listTools();
    assert.ok(!tools.some((t) => t.name === "hoop_submit_markdown"));
    for (const t of tools) assert.doesNotMatch(`${t.title} ${t.description}`, /old name|deprecated/i, t.name);
    const old = (await mcp.client.callTool({ name: "hoop_submit_markdown", arguments: { markdown: "# Plan\n\nShip it.\n" } })) as { isError?: boolean };
    assert.equal(old.isError, true);
  } finally {
    await mcp.close();
  }
});

test("each submit tool takes its format, and a decision document sent to hoop_submit names hoop_submit_decision", async () => {
  const mcp = await mcpClient(await pagesFor(tempHome()));
  try {
    const md = await mcp.call("hoop_submit", { markdown: "# Plan\n\nShip the export.\n" });
    assert.equal(md.isError, false);
    assert.equal(md.value.outcome, "created");
    assert.equal(md.value.notice, undefined);
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
  const mcp = await mcpClient(await pagesFor(home));
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
  const pages = await pagesFor(home);
  const mcp = await mcpClient(pages);
  try {
    const tools = (await mcp.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [
      "hoop_action",
      "hoop_action_withdraw",
      "hoop_ask",
      "hoop_build",
      "hoop_build_suggest",
      "hoop_build_wait",
      "hoop_build_write",
      "hoop_comment",
      "hoop_export",
      "hoop_feedback",
      "hoop_propose_edits",
      "hoop_reply",
      "hoop_submit",
      "hoop_submit_decision",
      "hoop_track_pr",
      "hoop_wait",
      "hoop_withdraw",
      "hoop_work_queue",
    ]);

    const sub = await mcp.call("hoop_submit_decision", { document: example() });
    assert.equal(sub.isError, false);
    assert.match(sub.value.review_id, /^rv_/);
    assert.equal(sub.value.revision, 1);
    assert.equal(sub.value.url, `http://localhost:${pages.HOOP_PORT}/r/${sub.value.review_id}`);

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
  const mcp = await mcpClient(await pagesFor(tempHome()));
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
  const mcp = await mcpClient(await pagesFor(tempHome()));
  try {
    const text = mcp.client.getInstructions() ?? "";
    for (const words of ["hoop_submit", "hoop_wait", "hoop_feedback", "## Question:", "(recommended)", "Only a person approves", "link"])
      assert.ok(text.includes(words), `the instructions mention ${words}`);
  } finally {
    await mcp.close();
  }
});

test("the instructions build a document together from its title, asking nothing first, and ask for Mermaid diagrams", () => {
  assert.match(INSTRUCTIONS, /help me build a document/);
  assert.match(INSTRUCTIONS, /don't write the whole document, and ask nothing first/);
  assert.doesNotMatch(INSTRUCTIONS, /who it's for/);
  assert.match(INSTRUCTIONS, /suggest headings with hoop_build_suggest, each with one line on what it covers/);
  assert.match(INSTRUCTIONS, /write one section per request/);
  assert.match(INSTRUCTIONS, /```mermaid fenced block/);
});
