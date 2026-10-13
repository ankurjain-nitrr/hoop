import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop, HoopError } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { example, mcpClient, tempHome } from "./helpers.js";

function setup() {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const fb = hoop.review(review_id, { verdict: "comment", comments: [
    { item: "FR-3", line: 1, body: "make the bounds inclusive" },
    { item: "FR-1", line: 0, body: "this section is too absolute" },
    { item: "DOC", line: 2, body: "say 'orders' as 'purchases' everywhere" },
  ] });
  const [line, section, docwide] = fb.comments.map((c) => c.thread!);
  return { hoop, review_id, line: line!, section: section!, docwide: docwide! };
}

const errorsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as HoopError).errors.map((e) => `${e.path}: ${e.message}`);
  }
  return [];
};

test("edits within the comment's scope are stored as proposals with word stats", () => {
  const { hoop, review_id, line, section, docwide } = setup();
  const a = hoop.proposeEdits(review_id, line, [{ item: "FR-3", line: 1, find: "in that range", replace: "within both bounds, inclusive" }], "inclusive bounds");
  assert.equal(a.proposals[0]!.start, "When from or to are given, the system shall include only orders created ".length);
  assert.deepEqual(a.proposals[0]!.words, { removed: 3, added: 4, line_words: 16, large: false });
  const b = hoop.proposeEdits(review_id, section, [
    { item: "FR-1", line: 2, find: "never buffered in full", replace: "not buffered in full where possible" },
    { item: "FR-1", line: 0, find: "all", replace: "orders" },
  ]);
  assert.equal(b.proposals.length, 2);
  const c = hoop.proposeEdits(review_id, docwide, [{ item: "FR-2", line: 1, find: "Each row", replace: "Each row (one per purchase)" }, { item: "DOC", line: 1, find: "Order", replace: "Purchase" }]);
  assert.equal(c.proposals.length, 2);
  const res = hoop.feedback(review_id);
  assert.equal(res.status === "reviewed" && res.edits?.length, 5);
  assert.ok(res.status === "reviewed" && res.edits!.every((e) => e.status === "proposed"));
});

test("edits outside the scope, ambiguous, overlapping or malformed are refused, all or nothing", () => {
  const { hoop, review_id, line, section } = setup();
  assert.deepEqual(errorsOf(() => hoop.proposeEdits(review_id, line, [{ item: "FR-3", line: 2, find: "both", replace: "all" }])),
    ["edits.0.item: this comment is on FR-3 line 1; edits must stay on that line"]);
  assert.deepEqual(errorsOf(() => hoop.proposeEdits(review_id, section, [{ item: "FR-2", line: 1, find: "Each", replace: "Every" }])),
    ["edits.0.item: this comment covers section FR-1; edits must stay in it"]);
  const errs = errorsOf(() => hoop.proposeEdits(review_id, section, [
    { item: "FR-1", line: 1, find: "orders", replace: "purchases" },
    { item: "FR-1", line: 1, find: "a CSV file", replace: "a CSV" },
    { item: "FR-1", line: 1, find: "CSV file of", replace: "file of" },
    { item: "FR-1", line: 1, find: "x", replace: "x" },
    { item: "FR-1", line: 2, find: "read", replace: "read\nnow" },
  ]));
  assert.deepEqual(errs.map((e) => e.split(":")[0]), ["edits.0.find", "edits.3.replace", "edits.4.replace", "edits.2.find"]);
  assert.match(errs[0]!, /more than once/);
  assert.match(errs[3]!, /overlaps edit 1/);
  assert.equal(hoop.store.proposals(review_id).length, 0);
  assert.throws(() => hoop.proposeEdits(review_id, "th_nope_1", [{ item: "FR-1", line: 1, find: "a", replace: "b" }]), /no thread/);
});

test("hoop_propose_edits over MCP returns the proposals, and errors name the edit", async () => {
  const home = tempHome();
  const store = new Store(home);
  const hoop = new Hoop(store);
  const { review_id } = hoop.submit(example());
  const thread = hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-3", line: 1, body: "inclusive?" }] }).comments[0]!.thread!;
  const mcp = await mcpClient({ HOOP_HOME: home });
  try {
    const ok = await mcp.call("hoop_propose_edits", { review_id, thread, edits: [{ item: "FR-3", line: 1, find: "in that range", replace: "within both bounds" }] });
    assert.equal(ok.isError, false);
    assert.match(ok.value.proposals[0].id, /^ed_/);
    const bad = await mcp.call("hoop_propose_edits", { review_id, thread, edits: [{ item: "FR-3", line: 1, find: "missing words", replace: "x" }] });
    assert.equal(bad.isError, true);
    assert.equal(bad.value.errors[0].path, "edits.0.find");
  } finally {
    await mcp.close();
  }
});
