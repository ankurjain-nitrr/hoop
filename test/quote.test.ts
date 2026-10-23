import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { RULES, rulesText } from "../src/edit.js";
import { Hoop } from "../src/hoop.js";
import { OPS } from "../src/ops.js";
import { resolveQuote } from "../src/quote.js";
import { Store } from "../src/store.js";
import { example, tempHome } from "./helpers.js";

test("a comment names its words in place of a line, and lands on the right line", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const fb = hoop.review(review_id, { verdict: "comment", comments: [{ words: "orders created in that range", body: "Which date?" }] });
  const c = fb.comments[0]!;
  assert.deepEqual([c.item, c.line], ["FR-3", 1]);
  assert.equal(c.range?.quote, "orders created in that range");
  // An item narrows the search, and a reply may leave out its anchor.
  const reply = hoop.review(review_id, { verdict: "comment", comments: [{ thread: c.thread, body: "Created, please." }] });
  assert.deepEqual([reply.comments[0]!.item, reply.comments[0]!.line], ["FR-3", 1]);
  assert.deepEqual(resolveQuote(hoop.store.revision(review_id), { item: "FR-3", words: "created" }).line, 1);
});

test("quoted words that occur nowhere or more than once are refused with every place", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const doc = hoop.store.revision(review_id);
  assert.throws(() => resolveQuote(doc, { words: "no such words here" }), /occurs nowhere/);
  assert.throws(
    () => resolveQuote(doc, { words: "orders" }),
    (err: Error) => /occurs in \d+ places: .*FR-\d line \d.*, .*FR-\d line \d/.test(err.message),
  );
  assert.throws(() => hoop.review(review_id, { verdict: "comment", comments: [{ words: "orders", body: "x" }] }), /occurs in \d+ places/);
});

test("feedback states each comment's scope: its line, its section, or the whole document", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  hoop.review(review_id, {
    verdict: "comment",
    comments: [
      { item: "FR-3", line: 1, body: "line" },
      { item: "FR-3", line: 0, body: "section" },
      { item: "DOC", line: 1, body: "document" },
    ],
  });
  const fb = hoop.feedback(review_id);
  assert.equal(fb.status, "reviewed");
  const scopes = fb.status === "reviewed" ? fb.feedback[0]!.comments.map((c) => (c as { scope?: unknown }).scope) : [];
  assert.deepEqual(scopes, [{ kind: "line" }, { kind: "section", items: ["FR-3"] }, { kind: "document" }]);
});

test("each refused edit names its rule, and the tool's description lists every rule", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const fb = hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-3", line: 1, body: "Say purchased" }] });
  const thread = fb.comments[0]!.thread!;
  const refusal = (edits: unknown[]) => {
    try {
      hoop.proposeEdits(review_id, thread, edits);
    } catch (err) {
      return (err as { errors: { message: string }[] }).errors.map((e) => e.message.split(":")[0]);
    }
    assert.fail("expected a refusal");
  };
  assert.deepEqual(refusal([{ item: "FR-3", line: 1, find: "in", replace: "within" }]), ["once_in_line"]);
  assert.deepEqual(refusal([{ item: "FR-3", line: 1, find: "nothing like this", replace: "x" }]), ["found"]);
  assert.deepEqual(refusal([{ item: "FR-2", line: 1, find: "CSV", replace: "TSV" }]), ["in_scope"]);
  assert.deepEqual(refusal([{ item: "FR-3", line: 1, find: "created", replace: "a\nb" }]), ["no_line_breaks"]);
  assert.deepEqual(refusal([{ item: "FR-3", line: 1, find: "created", replace: "created" }]), ["changes_text"]);
  const section = hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-3", line: 0, body: "Whole section" }] }).comments[0]!.thread!;
  assert.throws(
    () => hoop.proposeEdits(review_id, section, [{ item: "FR-3", line: 9, find: "created", replace: "x" }]),
    (err: Error & { errors: { message: string }[] }) => err.errors[0]!.message.startsWith("line_exists:"),
  );
  assert.deepEqual(
    refusal([
      { item: "FR-3", line: 1, find: "created in", replace: "placed in" },
      { item: "FR-3", line: 1, find: "in that", replace: "within that" },
    ]),
    ["no_overlap"],
  );
  // Without item and line, find picks the one line in the comment's scope.
  const { proposals } = hoop.proposeEdits(review_id, thread, [{ find: "created", replace: "placed" }]);
  assert.deepEqual([proposals[0]!.item, proposals[0]!.line], ["FR-3", 1]);

  const description = OPS.find((o) => o.name === "propose_edits")!.description;
  for (const rule of Object.keys(RULES)) assert.ok(description.includes(`${rule}:`), rule);
  assert.ok(description.includes(rulesText()));
});

test("review fix: an edit refused before the batch check, on changed text, is counted by rule in the audit", () => {
  const home = tempHome();
  const prev = process.env.HOOP_HOME;
  process.env.HOOP_HOME = home;
  try {
    const hoop = new Hoop(new Store(home));
    const { review_id } = hoop.submit(example());
    const fb = hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-3", line: 1, body: "Say purchased" }] });
    hoop.submit({
      ...example(),
      review_id,
      items: example().items.map((i: { id: string; body?: string }) => (i.id === "FR-3" ? { ...i, body: "Changed." } : i)),
    });
    assert.throws(() => hoop.proposeEdits(review_id, fb.comments[0]!.thread!, [{ find: "Changed", replace: "Different" }]), /line_unchanged/);
    const events = readFileSync(join(home, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      events.filter((e) => e.event === "edit_refused").map((e) => e.rules),
      [["line_unchanged"]],
    );
  } finally {
    process.env.HOOP_HOME = prev;
  }
});
