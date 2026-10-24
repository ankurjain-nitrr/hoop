import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop, type HoopError } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { example, mcpClient, tempHome, pagesFor } from "./helpers.js";

function setup() {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const fb = hoop.review(review_id, {
    verdict: "comment",
    comments: [
      { item: "FR-3", line: 1, body: "make the bounds inclusive" },
      { item: "FR-1", line: 0, body: "this section is too absolute" },
      { item: "DOC", line: 2, body: "say 'orders' as 'purchases' everywhere" },
    ],
  });
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
  const a = hoop.proposeEdits(
    review_id,
    line,
    [{ item: "FR-3", line: 1, find: "in that range", replace: "within both bounds, inclusive" }],
    "inclusive bounds",
  );
  assert.equal(a.proposals[0]!.start, "When from or to are given, the system shall include only orders created ".length);
  assert.deepEqual(a.proposals[0]!.words, { removed: 3, added: 4, line_words: 16, large: false });
  const b = hoop.proposeEdits(review_id, section, [
    { item: "FR-1", line: 2, find: "never buffered in full", replace: "not buffered in full where possible" },
    { item: "FR-1", line: 0, find: "all", replace: "orders" },
  ]);
  assert.equal(b.proposals.length, 2);
  const c = hoop.proposeEdits(review_id, docwide, [
    { item: "FR-2", line: 1, find: "Each row", replace: "Each row (one per purchase)" },
    { item: "DOC", line: 1, find: "Order", replace: "Purchase" },
  ]);
  assert.equal(c.proposals.length, 2);
  const res = hoop.feedback(review_id);
  assert.equal(res.status === "reviewed" && res.edits?.length, 5);
  assert.ok(res.status === "reviewed" && res.edits!.every((e) => e.status === "proposed"));
});

test("edits outside the scope, ambiguous, overlapping or malformed are refused, all or nothing", () => {
  const { hoop, review_id, line, section } = setup();
  assert.deepEqual(
    errorsOf(() => hoop.proposeEdits(review_id, line, [{ item: "FR-3", line: 2, find: "both", replace: "all" }])),
    ["edits.0.item: in_scope: this comment is on FR-3 line 1; edits must stay on that line"],
  );
  assert.deepEqual(
    errorsOf(() => hoop.proposeEdits(review_id, section, [{ item: "FR-2", line: 1, find: "Each", replace: "Every" }])),
    ["edits.0.item: in_scope: this comment covers section FR-1; edits must stay in it"],
  );
  const errs = errorsOf(() =>
    hoop.proposeEdits(review_id, section, [
      { item: "FR-1", line: 1, find: "orders", replace: "purchases" },
      { item: "FR-1", line: 1, find: "a CSV file", replace: "a CSV" },
      { item: "FR-1", line: 1, find: "CSV file of", replace: "file of" },
      { item: "FR-1", line: 1, find: "x", replace: "x" },
      { item: "FR-1", line: 2, find: "read", replace: "read\nnow" },
    ]),
  );
  assert.deepEqual(
    errs.map((e) => e.split(":")[0]),
    ["edits.0.find", "edits.3.replace", "edits.4.replace", "edits.2.find"],
  );
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
  const mcp = await mcpClient(await pagesFor(home));
  try {
    const ok = await mcp.call("hoop_propose_edits", {
      review_id,
      thread,
      edits: [{ item: "FR-3", line: 1, find: "in that range", replace: "within both bounds" }],
    });
    assert.equal(ok.isError, false);
    assert.match(ok.value.proposals[0].id, /^ed_/);
    const bad = await mcp.call("hoop_propose_edits", { review_id, thread, edits: [{ item: "FR-3", line: 1, find: "missing words", replace: "x" }] });
    assert.equal(bad.isError, true);
    assert.equal(bad.value.errors[0].path, "edits.0.find");
  } finally {
    await mcp.close();
  }
});

test("accepting an edit applies only its span in a new revision; rejecting records it; later edits relocate", () => {
  const { hoop, review_id, section } = setup();
  const before = structuredClone(hoop.store.revision(review_id));
  const { proposals } = hoop.proposeEdits(review_id, section, [
    { item: "FR-1", line: 2, find: "never buffered in full", replace: "not buffered in full" },
    { item: "FR-1", line: 2, find: "Rows shall stream", replace: "Rows stream" },
    { item: "FR-1", line: 0, find: "all orders", replace: "orders" },
  ]);
  const [a, b, c] = proposals.map((p) => p.id);
  assert.equal(hoop.decideEdit(review_id, a!, "accept", "ankur").revision, 2);
  // b was made on rev 1 and sits earlier on the same line; it is found again by its unique text.
  assert.deepEqual(hoop.editPosition(review_id, hoop.store.proposals(review_id)[1]!), { start: 0, end: "Rows shall stream".length });
  assert.equal(hoop.decideEdit(review_id, b!, "accept").revision, 3);
  assert.equal(hoop.decideEdit(review_id, c!, "reject").revision, 3);
  const after = hoop.store.revision(review_id);
  assert.equal(after.items[0]!.body!.split("\n")[1], "Rows stream to the client as they are read, not buffered in full.");
  assert.equal(after.items[0]!.title, before.items[0]!.title);
  assert.deepEqual(after.items.slice(1), before.items.slice(1));
  assert.equal(after.title, before.title);
  assert.deepEqual(
    hoop.store.proposals(review_id).map((p) => p.status),
    ["accepted", "accepted", "rejected"],
  );
  assert.deepEqual(
    hoop.store.applied(review_id).map((x) => [x.kind, x.edit_id, x.revision]),
    [
      ["edit", a, 2],
      ["edit", b, 3],
    ],
  );
  assert.throws(() => hoop.decideEdit(review_id, a!, "accept"), /already accepted/);
});

test("an edit whose text changed in a later revision is stale and can only be rejected", () => {
  const { hoop, review_id, line } = setup();
  const { proposals } = hoop.proposeEdits(review_id, line, [{ item: "FR-3", line: 1, find: "in that range", replace: "within both bounds" }]);
  const rev2 = example();
  rev2.items[2].body = "When from or to are given, the system shall include orders created between them.";
  hoop.submit({ ...rev2, review_id });
  assert.equal(hoop.editPosition(review_id, proposals[0]!), null);
  assert.throws(() => hoop.decideEdit(review_id, proposals[0]!.id, "accept"), /has changed since/);
  assert.equal(hoop.decideEdit(review_id, proposals[0]!.id, "reject").proposal.status, "rejected");
});

test("an edit applies only while its line still reads exactly as when it was proposed", () => {
  const { hoop, review_id, section } = setup();
  const { proposals } = hoop.proposeEdits(review_id, section, [{ item: "FR-1", line: 1, find: "a CSV file", replace: "a CSV export" }]);
  // Claude resubmits with a new first line: line 1 now holds different text that also contains "a CSV file".
  const rev2 = example();
  rev2.items[0].body = "Staff can download a CSV file from the admin page.\n" + rev2.items[0].body;
  hoop.submit({ ...rev2, review_id });
  assert.equal(hoop.editPosition(review_id, proposals[0]!), null);
  assert.throws(() => hoop.decideEdit(review_id, proposals[0]!.id, "accept"), /has changed since/);
});

test("accepting one edit shifts later edits on the same line and makes overlapping ones stale", () => {
  const { hoop, review_id, section } = setup();
  const p1 = hoop.proposeEdits(review_id, section, [{ item: "FR-1", line: 1, find: "a client calls", replace: "someone calls" }]).proposals[0]!;
  const p2 = hoop.proposeEdits(review_id, section, [{ item: "FR-1", line: 1, find: "a CSV file", replace: "a CSV export" }]).proposals[0]!;
  const p3 = hoop.proposeEdits(review_id, section, [{ item: "FR-1", line: 1, find: "When a client", replace: "Whenever a client" }]).proposals[0]!;
  hoop.decideEdit(review_id, p1.id, "accept");
  const [, q2, q3] = hoop.store.proposals(review_id);
  assert.notEqual(hoop.editPosition(review_id, q2!), null);
  assert.equal(hoop.editPosition(review_id, q3!), null);
  hoop.decideEdit(review_id, p2.id, "accept");
  assert.equal(
    hoop.store.revision(review_id).items[0]!.body!.split("\n")[0],
    "When someone calls GET /orders/export, the system shall respond with a CSV export of all orders.",
  );
  assert.throws(() => hoop.decideEdit(review_id, p3.id, "accept"), /has changed since/);
});

test("proposals on an applied thread, or on a line that changed since the comment, are refused", () => {
  const { hoop, review_id, line } = setup();
  const { proposals } = hoop.proposeEdits(review_id, line, [{ item: "FR-3", line: 1, find: "in that range", replace: "within both bounds" }]);
  hoop.decideEdit(review_id, proposals[0]!.id, "accept");
  assert.throws(() => hoop.proposeEdits(review_id, line, [{ item: "FR-3", line: 1, find: "both", replace: "the" }]), /already applied/);
  const other = setup();
  const rev2 = example();
  rev2.items[2].body = "Filter by creation date.";
  other.hoop.submit({ ...rev2, review_id: other.review_id });
  assert.throws(
    () => other.hoop.proposeEdits(other.review_id, other.line, [{ item: "FR-3", line: 1, find: "creation", replace: "order" }]),
    /has changed since/,
  );
});
