import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changes } from "../src/changes.js";
import { HoopError } from "../src/hoop.js";
import { tempHome } from "./helpers.js";

const repo = () => {
  const dir = tempHome();
  mkdirSync(join(dir, "docs", "changes", "CR-1-initial-build"), { recursive: true });
  mkdirSync(join(dir, "docs", "changes", "CR-2-heading-spacing"), { recursive: true });
  return dir;
};

test("FR-1: a request is kept byte for byte as the next change, at intake", () => {
  const dir = repo();
  const records: string[] = [];
  const changes = new Changes(dir, { onRecord: (r, e) => records.push(`${e}:${r.id}`) });
  const text = "i might dump a lot of change requests.  \nthey have to be queued.\n\n";
  const rec = changes.create(text, { type: "story", reason: "one capability", by: "ankur" });
  assert.equal(rec.id, "CR-3");
  assert.equal(rec.slug, "i-might-dump-a-lot-of-change-requests");
  assert.equal(readFileSync(join(dir, "docs/changes/CR-3-i-might-dump-a-lot-of-change-requests/REQUEST.md"), "utf8"), text);
  assert.deepEqual(rec.steps.map((s) => [s.step, s.by]), [["intake", "ankur"]]);
  assert.equal(changes.create("Second", { type: "task", reason: "r", title: "Docs fix" }).id, "CR-4");
  assert.deepEqual(records, ["create:CR-3", "create:CR-4"]);
});

test("FR-2, FR-3: reclassifying updates the record; a correction with a reason is logged for the classifier", () => {
  const dir = repo(), changes = new Changes(dir);
  const { id } = changes.create("Add | export\nmore", { type: "epic", reason: "several stories" });
  changes.classify(id, "epic", "still several stories");
  assert.equal(existsSync(join(dir, "docs/changes/CLASSIFICATION.md")), false);
  const rec = changes.classify(id, "story", "one capability", { why: "export is one user-visible capability" });
  assert.equal(rec.type, "story");
  assert.equal(changes.get(id).reason, "one capability");
  const log = readFileSync(join(dir, "docs/changes/CLASSIFICATION.md"), "utf8");
  assert.match(log, /\| CR-3 \| Add \\\| export \| epic \| story \| export is one user-visible capability \|/);
});

test("FR-6: steps are recorded in order with time and actor; gates refuse with what is missing", async () => {
  const changes = new Changes(repo(), { gate: (_r, step) => (step === "build" ? ["LLD review rv_x is not approved; run hoop feedback rv_x"] : []) });
  const { id } = changes.create("x", { type: "task", reason: "r" });
  await changes.moveStep(id, "prd", { by: "claude" });
  await changes.moveStep(id, "hld");
  await assert.rejects(changes.moveStep(id, "build"), (e: HoopError) => /can't move to build: LLD review rv_x is not approved/.test(e.message));
  await assert.rejects(changes.moveStep(id, "shipped" as never), /unknown step shipped/);
  assert.deepEqual(changes.get(id).steps.map((s) => s.step), ["intake", "prd", "hld"]);
  assert.equal(changes.step(id), "hld");
  await changes.moveStep(id, "closed");
  assert.equal(changes.step(id), "closed");
});

test("FR-7: fold needs every linked PR merged; gh failures are retryable refusals", async () => {
  const states: Record<number, string> = { 31: "MERGED", 32: "OPEN" };
  const changes = new Changes(repo(), { prState: (pr) => { if (!(pr in states)) throw new Error("gh: not found\nmore"); return states[pr]!; } });
  const { id } = changes.create("x", { type: "task", reason: "r" });
  await assert.rejects(changes.moveStep(id, "fold"), /no PRs linked; run hoop cr link-pr CR-3 <number>/);
  changes.linkPr(id, 31); changes.linkPr(id, 32); changes.linkPr(id, 33);
  await assert.rejects(changes.moveStep(id, "fold"), (e: HoopError) =>
    e.message.includes("PR #32 is open; merge it first") && e.message.includes("couldn't read PR #33 (gh: not found); retry") && !e.message.includes("#31"));
  states[32] = "MERGED"; states[33] = "MERGED";
  assert.equal((await changes.moveStep(id, "fold")).steps.at(-1)!.step, "fold");
});

test("PRs and reviews link to a change; folders from before the registry still list", () => {
  const dir = repo(), changes = new Changes(dir);
  const { id } = changes.create("x", { type: "bug", reason: "r" });
  changes.linkPr(id, 31);
  changes.linkPr(id, 31);
  changes.addReview(id, "prd", "rv_a");
  changes.addReview(id, "prd", "rv_b");
  const rec = changes.get(id);
  assert.deepEqual(rec.prs, [31]);
  assert.deepEqual(rec.reviews, { prd: ["rv_a", "rv_b"] });
  assert.deepEqual(changes.list().map((r) => [r.id, r.type]), [["CR-1", "unknown"], ["CR-2", "unknown"], ["CR-3", "bug"]]);
});

test("bad input is refused with the field: empty request, unknown type, missing reason, bad id", () => {
  const changes = new Changes(repo());
  const path = (fn: () => unknown) => {
    try { fn(); } catch (e) { return (e as HoopError).errors[0]?.path; }
  };
  assert.equal(path(() => changes.create("  ", { type: "task", reason: "r" })), "request");
  assert.equal(path(() => changes.create("x", { type: "chore" as never, reason: "r" })), "type");
  assert.equal(path(() => changes.create("x", { type: "task", reason: " " })), "reason");
  assert.equal(path(() => changes.get("CR-x")), "cr");
  assert.throws(() => changes.get("CR-99"), /no change CR-99/);
  writeFileSync(join(changes.root, "notes.txt"), "not a change");
  assert.equal(changes.list().length, 2);
});
