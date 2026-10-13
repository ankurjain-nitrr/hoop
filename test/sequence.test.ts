import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Hoop, HoopError } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { parseMarkdown } from "../src/markdown.js";
import { gatedChanges } from "../src/sequence.js";
import { tempHome } from "./helpers.js";

/** A hoop with a temporary store and repository holding one change, CR-1. */
function setup() {
  const repo = tempHome();
  mkdirSync(join(repo, "docs", "changes"), { recursive: true });
  process.env.HOOP_REPO_DIR = repo;
  const store = new Store(tempHome()), hoop = new Hoop(store);
  const { changes, sequencer } = gatedChanges(store, repo);
  const cr = changes.create("Add an export", { type: "story", reason: "one capability" }).id;
  const submit = (doc: "prd" | "hld" | "lld", review_id?: string, link = true) =>
    hoop.submitAny(parseMarkdown(`# ${doc}\n\nBody of the ${doc}.\n`, { review_id }), link ? { change: { cr, doc } } : {});
  // Approvals compare by time; keep them in distinct milliseconds.
  const approve = async (id: string) => { await sleep(3); hoop.review(id, { verdict: "approved" }); };
  return { hoop, store, changes, sequencer, cr, submit, approve };
}

const refused = (re: RegExp) => (e: HoopError) => e instanceof HoopError && re.test(e.message);

test("FR-4: an HLD is refused until the PRD is approved, an LLD until the HLD; the step follows", async () => {
  const { changes, cr, submit, approve } = setup();
  await assert.rejects(submit("hld"), refused(/can't open the HLD review for CR-1: CR-1 has no PRD review; run hoop submit PRD.md --cr CR-1 --doc prd/));
  const prd = await submit("prd");
  assert.equal(changes.step(cr), "prd");
  await assert.rejects(submit("hld"), refused(new RegExp(`PRD review ${prd.review_id} is not approved; run hoop feedback ${prd.review_id}`)));
  await approve(prd.review_id);
  const hld = await submit("hld");
  await assert.rejects(submit("lld"), refused(/HLD review .* is not approved/));
  await approve(hld.review_id);
  const lld = await submit("lld");
  assert.deepEqual(changes.get(cr).reviews, { prd: [prd.review_id], hld: [hld.review_id], lld: [lld.review_id] });
  assert.deepEqual(changes.get(cr).steps.map((s) => s.step), ["intake", "prd", "hld", "lld"]);
});

test("FR-5, FR-7: a re-approved PRD makes the HLD and LLD stale and build is refused until they are re-approved", async () => {
  const { hoop, changes, sequencer, cr, submit, approve } = setup();
  const ids: Record<string, string> = {};
  for (const doc of ["prd", "hld", "lld"] as const) { ids[doc] = (await submit(doc)).review_id; await approve(ids[doc]!); }
  assert.deepEqual(sequencer.ready(cr), { ok: true, missing: [] });

  // Revising the approved PRD without --cr still counts: the superseding review inherits the link.
  const prd2 = await hoop.submitAny(parseMarkdown("# prd\n\nRevised.\n", { review_id: ids.prd }));
  assert.notEqual(prd2.review_id, ids.prd);
  assert.equal(changes.get(cr).reviews.prd!.at(-1), prd2.review_id);
  assert.match(sequencer.ready(cr).missing.join("\n"), /PRD review .* is not approved/);
  await assert.rejects(submit("hld", ids.hld), refused(/PRD review .* is not approved/), "the HLD waits while the PRD is under review");

  await approve(prd2.review_id);
  assert.deepEqual(sequencer.state(cr).map((s) => [s.doc, s.stale]), [["prd", false], ["hld", true], ["lld", true]]);
  await changes.moveStep(cr, "plan");
  await assert.rejects(changes.moveStep(cr, "build"), refused(new RegExp(`HLD review ${ids.hld} is stale .*; resubmit it with hoop submit HLD.md --review ${ids.hld}`)));
  await assert.rejects(submit("lld", ids.lld), refused(/HLD review .* is stale/));

  const hld2 = await submit("hld", ids.hld);
  await approve(hld2.review_id);
  assert.deepEqual(sequencer.state(cr).map((s) => [s.doc, s.stale]), [["prd", false], ["hld", false], ["lld", true]]);
  const lld2 = await submit("lld", ids.lld);
  await approve(lld2.review_id);
  assert.equal((await changes.moveStep(cr, "build")).steps.at(-1)!.step, "build");
});

test("FR-7, NFR-1: build is refused naming every missing document and how to fix it", async () => {
  const { changes, cr, submit } = setup();
  const prd = await submit("prd");
  for (const step of ["hld", "lld", "plan"] as const) await changes.moveStep(cr, step);
  await assert.rejects(changes.moveStep(cr, "build"), (e: HoopError) => {
    assert.deepEqual(e.errors.map((x) => x.message), [
      `PRD review ${prd.review_id} is not approved; run hoop feedback ${prd.review_id}`,
      "CR-1 has no HLD review; run hoop submit HLD.md --cr CR-1 --doc hld",
      "CR-1 has no LLD review; run hoop submit LLD.md --cr CR-1 --doc lld",
    ]);
    return true;
  });
});

test("NFR-2: reviews without a change are unsequenced; an unknown change or document is refused", async () => {
  const { submit, hoop } = setup();
  const plain = await submit("hld", undefined, false);
  assert.equal(plain.status, "open");
  await assert.rejects(hoop.submitAny(parseMarkdown("# x\n\ny\n"), { change: { cr: "CR-9", doc: "prd" } }), /no change CR-9/);
  await assert.rejects(hoop.submitAny(parseMarkdown("# x\n\ny\n"), { change: { cr: "CR-1", doc: "spec" } }), refused(/unknown document spec/));
});

test("review fixes: a review can't be relinked to another document or change; inherited links use the review's repo", async () => {
  const { hoop, changes, cr, submit, approve } = setup();
  const repoA = process.env.HOOP_REPO_DIR!;
  const prd = await submit("prd");
  await approve(prd.review_id);
  const hld = await submit("hld");
  await assert.rejects(submit("prd", hld.review_id), refused(new RegExp(`review ${hld.review_id} is the HLD of CR-1; submit without review_id`)));
  const other = changes.create("Second change", { type: "task", reason: "r" }).id;
  await assert.rejects(hoop.submitAny(parseMarkdown("# x\n\ny\n", { review_id: hld.review_id }), { change: { cr: other, doc: "hld" } }), refused(/is the HLD of CR-1/));

  // From another repository, a revision of the linked HLD still updates repository A's CR-1.
  process.env.HOOP_REPO_DIR = tempHome();
  const rev = await hoop.submitAny(parseMarkdown("# hld\n\nRevised.\n", { review_id: hld.review_id }));
  assert.equal(rev.review_id, hld.review_id);
  assert.equal(rev.revision, 2);
  process.env.HOOP_REPO_DIR = repoA;
  assert.deepEqual(changes.get(cr).reviews.hld, [hld.review_id]);
});

test("review fixes: a closed predecessor names a new submit as the fix", async () => {
  const { store, sequencer, cr, submit } = setup();
  const prd = await submit("prd");
  store.update(prd.review_id, { status: "closed" });
  assert.deepEqual(sequencer.blockers(cr, "hld"), [`PRD review ${prd.review_id} is closed; start a new one with hoop submit PRD.md --cr CR-1 --doc prd`]);
});
