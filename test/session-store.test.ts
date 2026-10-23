import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { migrateHome } from "../src/migrate.js";
import { Store } from "../src/store.js";
import { reviewView } from "../src/web.js";
import { cli, example, tempHome, tsx } from "./helpers.js";

/** A session transcript in the test's Claude Code folder; returns the folder that holds it. */
function transcript(session: string, project = "-tmp-work") {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "projects", project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session}.jsonl`), `${JSON.stringify({ type: "ai-title", aiTitle: "Work" })}\n`);
  return dir;
}

const index = (home: string) => JSON.parse(readFileSync(join(home, "index.json"), "utf8")).reviews;

test("a session keeps its reviews in .hoop beside its transcript, and a session hoop can't find keeps them in the home folder", () => {
  const home = tempHome();
  const folder = transcript("store-session-1");
  const hoop = new Hoop(new Store(home), "store-session-1");
  const { review_id } = hoop.submit(example());
  const dir = join(folder, "store-session-1", ".hoop", "reviews", review_id);
  assert.ok(existsSync(join(dir, "review.json")));
  assert.equal(existsSync(join(home, "reviews", review_id)), false, "nothing in the home folder");
  assert.deepEqual(index(home), { [review_id]: join(folder, "store-session-1", ".hoop") });
  // Feedback, a reply and a revision stay in the same folder.
  const fb = hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-3", line: 1, body: "Why?" }] });
  hoop.reply(fb.comments[0]!.thread!, "Because.");
  hoop.submit({ ...example(), review_id });
  assert.deepEqual(readdirSync(dir).sort(), ["feedback-1.json", "replies.json", "rev-1.json", "rev-2.json", "review.json"]);
  // An approved review's successor is the session's too.
  hoop.review(review_id, { verdict: "approved" });
  const next = hoop.submit({ ...example(), review_id });
  assert.ok(existsSync(join(folder, "store-session-1", ".hoop", "reviews", next.review_id, "review.json")));
  const lost = new Hoop(new Store(home), "no-transcript-2").submit(example());
  assert.ok(existsSync(join(home, "reviews", lost.review_id, "review.json")));
  assert.equal(index(home)[lost.review_id], undefined);
});

test("one store serves every session's reviews, and a session folder Claude Code deleted drops out quietly", () => {
  const home = tempHome();
  const one = transcript("serve-session-1", "-tmp-one"),
    two = transcript("serve-session-2", "-tmp-two");
  const a = new Hoop(new Store(home), "serve-session-1").submit(example());
  const b = new Hoop(new Store(home), "serve-session-2").submit({ ...example(), title: "Second session" });
  const c = new Hoop(new Store(home), "no-transcript-3").submit({ ...example(), title: "No session folder" });
  // The pages process has its own store on the same home folder.
  const pages = new Hoop(new Store(home), null);
  assert.deepEqual(
    pages.store
      .list()
      .map((m) => m.id)
      .sort(),
    [a.review_id, b.review_id, c.review_id].sort(),
  );
  assert.equal(reviewView(pages, b.review_id).doc.title, "Second session");
  const fb = pages.review(a.review_id, { verdict: "comment", comments: [{ item: "FR-3", line: 1, body: "x" }] });
  assert.equal(pages.store.findThread(fb.comments[0]!.thread!), a.review_id);
  // Claude Code removes a session's folder after its cleanup period.
  rmSync(join(two, "serve-session-2"), { recursive: true });
  assert.deepEqual(
    pages.store
      .list()
      .map((m) => m.id)
      .sort(),
    [a.review_id, c.review_id].sort(),
  );
  assert.equal(index(home)[b.review_id], undefined, "the index forgets it");
  assert.ok(index(home)[a.review_id]);
  assert.throws(() => pages.store.meta(b.review_id), /no review/);
  assert.ok(existsSync(join(one, "serve-session-1", ".hoop", "reviews", a.review_id)));
});

test("hoop clear deletes one review, or one session's reviews, only when confirmed", () => {
  const home = tempHome();
  const folder = transcript("clear-session-1");
  transcript("clear-session-2");
  const mine = new Hoop(new Store(home), "clear-session-1");
  const [a, b] = [mine.submit(example()).review_id, mine.submit(example()).review_id];
  const theirs = new Hoop(new Store(home), "clear-session-2").submit(example()).review_id;
  const loose = new Hoop(new Store(home), "no-transcript-9").submit(example()).review_id;
  const run = (args: string[]) => spawnSync(process.execPath, [tsx, cli, "clear", ...args], { encoding: "utf8", env: { ...process.env, HOOP_HOME: home } });
  const at = (id: string) => join(folder, "clear-session-1", ".hoop", "reviews", id);
  // Without a terminal, nothing is deleted until --yes.
  const unconfirmed = run([a]);
  assert.equal(unconfirmed.status, 2);
  assert.match(unconfirmed.stderr, /deletes review .* for good; pass --yes to confirm/);
  assert.ok(existsSync(at(a)));
  const one = run([a, "--yes"]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(existsSync(at(a)), false);
  assert.equal(index(home)[a], undefined);
  assert.equal(run(["rv_missing", "--yes"]).status, 2);
  assert.equal(run(["--session", "clear-session-1"]).status, 2);
  assert.equal(run(["--session", "../x", "--yes"]).status, 2);
  assert.equal(run(["--all", "--yes"]).status, 2, "there is no --all");
  const all = run(["--session", "clear-session-1", "--yes"]);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /cleared review/);
  assert.equal(existsSync(at(b)), false);
  assert.ok(new Store(home).meta(theirs), "another session's review stays");
  // A review in the home folder clears too.
  assert.equal(run([loose, "--yes"]).status, 0);
  assert.equal(existsSync(join(home, "reviews", loose)), false);
  assert.match(run(["--session", "clear-session-1", "--yes"]).stdout, /no reviews to clear/);
  assert.equal(run([]).status, 2);
});

/** A review as an earlier release kept it in the home folder, with optional fields. */
function legacyReview(home: string, extra: Record<string, unknown> = {}): string {
  const store = new Store(home, { migrate: false });
  const meta = store.create(example(), extra);
  store.addFeedback(meta.id, {
    schema: "hoop/feedback@0",
    review_id: meta.id,
    revision: 1,
    verdict: "comment",
    comments: [{ item: "FR-3", line: 1, body: "Inclusive?" }],
    answers: [],
    resolved_threads: [],
    viewed: [],
    reviewer: "ana",
    at: "2026-01-01T00:00:00.000Z",
  });
  store.addReply(meta.id, { thread: `th_${meta.id.slice(3)}_1`, author: "claude", body: "Yes.", at: "2026-01-01T00:00:01.000Z" });
  return meta.id;
}

/** Every file of a review folder, by name, as bytes. */
const snapshot = (dir: string) =>
  Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).map((e) => [e.name, e.isFile() ? readFileSync(join(dir, e.name)).toString("base64") : "folder"]),
  );
const hoopOf = (folder: string, session: string) => join(folder, session, ".hoop");

test("the first run moves each review into its session's folder, byte for byte, and reports what moved and stayed", () => {
  const home = tempHome();
  const ownerDir = transcript("owner-session-7");
  const byOwner = legacyReview(home, { owner: { session: "owner-session-7" } });
  const planDir = transcript("plan-session-8", "-tmp-plans");
  const byPlan = legacyReview(home);
  mkdirSync(join(home, "plans"));
  writeFileSync(join(home, "plans", "plan-session-8.json"), JSON.stringify({ review_id: byPlan, hash: "h", cursor: "1.0" }));
  const noSession = legacyReview(home);
  const goneSession = legacyReview(home, { owner: { session: "deleted-session-9" } });
  // A review folder holding a folder of its own isn't one hoop wrote: it stays whole.
  const odd = legacyReview(home, { owner: { session: "owner-session-7" } });
  mkdirSync(join(home, "reviews", odd, "extra"));
  const stays = [noSession, goneSession, odd];
  const before = Object.fromEntries([byOwner, byPlan, ...stays].map((id) => [id, snapshot(join(home, "reviews", id))]));

  const lines: string[] = [];
  const report = migrateHome(home, { report: (t) => lines.push(t) });
  assert.deepEqual(report, { moved: 2, stayed: 3, failed: 0 });
  assert.match(lines[0]!, /^moved 2 reviews into their Claude Code sessions' folders; 3 stayed in /);
  const moved = { [byOwner]: hoopOf(ownerDir, "owner-session-7"), [byPlan]: hoopOf(planDir, "plan-session-8") };
  assert.deepEqual(index(home), moved);
  for (const [id, folder] of Object.entries(moved)) {
    assert.deepEqual(snapshot(join(folder, "reviews", id)), before[id], `${id} is byte for byte the same`);
    assert.equal(existsSync(join(home, "reviews", id)), false, `${id} left the home folder`);
  }
  for (const id of stays) assert.deepEqual(snapshot(join(home, "reviews", id)), before[id], `${id} stays as it was`);
  // Every review stays readable, wherever it is.
  const store = new Store(home);
  assert.equal(store.list().length, 5);
  for (const id of [byOwner, byPlan, ...stays]) assert.equal(store.replies(id)[0]!.body, "Yes.");
  // It runs once.
  assert.equal(migrateHome(home), undefined);
  assert.equal(JSON.parse(readFileSync(join(home, "migrated.json"), "utf8")).moved, 2);
});

test("a migration cut short at any step goes on where it stopped and loses nothing", () => {
  const home = tempHome();
  const folder = hoopOf(transcript("resume-session-1"), "resume-session-1");
  const reviews = join(folder, "reviews");
  mkdirSync(reviews, { recursive: true });
  const ids = Array.from({ length: 5 }, () => legacyReview(home, { owner: { session: "resume-session-1" } }));
  const [midCopy, copied, indexed, partial, newer] = ids as [string, string, string, string, string];
  const before = Object.fromEntries(ids.map((id) => [id, snapshot(join(home, "reviews", id))]));
  // Cut during the copy: a half-filled temp folder.
  mkdirSync(join(reviews, `.${midCopy}.99999.migrating`));
  writeFileSync(join(reviews, `.${midCopy}.99999.migrating`, "review.json"), "{");
  // Cut after the copy was renamed into place, before the index named it.
  cpSync(join(home, "reviews", copied), join(reviews, copied), { recursive: true });
  // Cut after the index named it, before the original was removed.
  cpSync(join(home, "reviews", indexed), join(reviews, indexed), { recursive: true });
  // A copy that doesn't match its original, and that the index doesn't name: copied again.
  mkdirSync(join(reviews, partial));
  writeFileSync(join(reviews, partial, "review.json"), "{}");
  // Named by the index and written to since: the copy is the review, and wins.
  cpSync(join(home, "reviews", newer), join(reviews, newer), { recursive: true });
  writeFileSync(join(reviews, newer, "replies.json"), "[]\n");
  writeFileSync(join(home, "index.json"), JSON.stringify({ format: 1, reviews: { [indexed]: folder, [newer]: folder } }));

  assert.deepEqual(migrateHome(home), { moved: 5, stayed: 0, failed: 0 });
  for (const id of [midCopy, copied, indexed, partial]) assert.deepEqual(snapshot(join(reviews, id)), before[id], id);
  assert.equal(readFileSync(join(reviews, newer, "replies.json"), "utf8"), "[]\n");
  assert.deepEqual(readdirSync(join(home, "reviews")), []);
  assert.deepEqual(readdirSync(reviews).sort(), [...ids].sort(), "no temp folder is left");
  assert.equal(Object.keys(index(home)).length, 5);
});

test("a review that can't move yet stays readable, and moves on a later run", { skip: process.getuid?.() === 0 ? "root ignores permissions" : false }, () => {
  const home = tempHome();
  const dir = transcript("locked-session-1", "-tmp-locked");
  const id = legacyReview(home, { owner: { session: "locked-session-1" } });
  const before = snapshot(join(home, "reviews", id));
  chmodSync(dir, 0o555);
  const lines: string[] = [];
  try {
    assert.deepEqual(migrateHome(home, { report: (t) => lines.push(t) }), { moved: 0, stayed: 0, failed: 1 });
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.match(lines[0]!, /1 could not move yet and stay readable there/);
  assert.deepEqual(snapshot(join(home, "reviews", id)), before);
  assert.equal(existsSync(join(home, "migrated.json")), false, "the next run tries again");
  assert.equal(new Store(home, { migrate: false }).meta(id).id, id);
  assert.deepEqual(migrateHome(home), { moved: 1, stayed: 0, failed: 0 });
  assert.deepEqual(snapshot(join(hoopOf(dir, "locked-session-1"), "reviews", id)), before);
});

test("the first command of the new release moves the reviews and says so", () => {
  const home = tempHome();
  const dir = transcript("first-run-session-1");
  const id = legacyReview(home, { owner: { session: "first-run-session-1" } });
  const env = { ...process.env, HOOP_HOME: home, HOOP_REPO_DIR: mkdtempSync(join(tmpdir(), "hoop-repo-")) };
  const r = spawnSync(process.execPath, [tsx, cli, "feedback", id, "--json"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /moved 1 review into their Claude Code sessions' folders; 0 stayed/);
  assert.equal(JSON.parse(r.stdout).review_id, id);
  assert.ok(existsSync(join(hoopOf(dir, "first-run-session-1"), "reviews", id, "review.json")));
  const again = spawnSync(process.execPath, [tsx, cli, "feedback", id], { encoding: "utf8", env });
  assert.doesNotMatch(again.stderr, /moved/);
});
