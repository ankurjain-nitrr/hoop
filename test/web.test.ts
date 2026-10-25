import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { example, TEST_SESSION, tempHome } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";
import { validateFeedback } from "../src/contract.js";
import { currentUser } from "../src/util.js";

export async function withServer(fn: (base: string, hoop: Hoop) => Promise<void>) {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, hoop);
  } finally {
    server.close();
  }
}

test("the review API returns the latest revision with each item's lines and the previous revision", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    hoop.submit({ ...example(), review_id, items: example().items.slice(0, 2) });
    const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
    assert.equal(view.meta.revisions, 2);
    assert.equal(view.doc.items.length, 2);
    assert.equal(view.doc.items[0].lines.length, 3);
    assert.equal(view.previous.revision, 1);
    assert.equal(view.previous.items.length, 4);
    assert.equal(view.status_key, "awaiting_review", "the view carries the review's status key");
    const list = await (await fetch(`${base}/api/reviews`)).json();
    assert.equal(list[0].status_key, "awaiting_review", "the list carries each review's status key");
    assert.deepEqual(
      list.map((m: { id: string }) => m.id),
      [review_id],
    );
  }));

test("pages and assets are served; unknown reviews and routes are 404", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    const page = await fetch(`${base}/r/${review_id}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /import\("\/app.js"\)/, "the page loads the app through a dynamic import");
    assert.equal((await fetch(`${base}/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await fetch(`${base}/api/reviews/rv_missing`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    for (const asset of ["/esc.js", "/status.js", "/icons.js", "/frame.js"]) assert.equal((await fetch(`${base}${asset}`)).status, 200, asset);
  }));

test("the API gives the served folder an identity, and each review its session and place, never a path", () =>
  withServer(async (base, hoop) => {
    const dir = process.env.HOOP_REPO_DIR!;
    const { review_id } = hoop.submit(example());
    const info = await (await fetch(`${base}/api/info`)).json();
    // The served folder is the first open repository.
    assert.equal(info.repos[0].name, basename(realpathSync(dir)));
    assert.match(info.repos[0].key, /^[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(info).includes(realpathSync(dir)), false, "no file path reaches the page");
    // Regression: the list and the view used to carry repo_dir, the folder's full path.
    const listText = await (await fetch(`${base}/api/reviews`)).text();
    const viewText = await (await fetch(`${base}/api/reviews/${review_id}`)).text();
    for (const text of [listText, viewText]) {
      assert.equal(text.includes(realpathSync(dir)) || text.includes(dir) || text.includes("repo_dir"), false, "no file path reaches the page");
      const v = JSON.parse(text);
      const m = Array.isArray(v) ? v[0] : v;
      assert.deepEqual(m.session, { id: TEST_SESSION, label: "session test-ses", live: false });
      assert.deepEqual(m.place, { folder: basename(dir) }, "a folder outside git has no repository");
      assert.equal("repo" in m || "project" in m, false, "reviews are grouped by session, not by repository");
    }
    // A review from a folder inside a git repository names both; one without an owner has no session.
    hoop.store.update(review_id, { repo_dir: "/work/hoop/web", repo: "/work/hoop", owner: undefined });
    const [m] = await (await fetch(`${base}/api/reviews`)).json();
    assert.deepEqual(m.place, { folder: "web", repo: "hoop" });
    assert.equal("session" in m, false);
  }));

const post = (base: string, id: string, body: unknown) =>
  fetch(`${base}/api/reviews/${id}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a review submitted from the page becomes the feedback document Claude reads", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    const res = await post(base, review_id, {
      verdict: "changes_requested",
      summary: "Close, two things",
      comments: [
        { item: "FR-3", line: 1, body: "Use updated_at instead?" },
        { item: "FR-1", line: 2, suggestion: "Rows shall stream as they are read." },
      ],
      answers: [{ item: "Q-1", choice: "b" }],
      viewed: ["FR-1"],
      reviewer: "ankur",
    });
    assert.equal(res.status, 201);
    const fb = hoop.feedback(review_id);
    assert.equal(fb.status, "reviewed");
    if (fb.status !== "reviewed") return;
    const f = fb.feedback[0]!;
    assert.equal(f.verdict, "changes_requested");
    assert.equal(f.reviewer, "ankur");
    const t = review_id.slice(3);
    assert.deepEqual(
      f.comments.map((c) => c.thread),
      [`th_${t}_1`, `th_${t}_2`],
    );
    assert.deepEqual(f.answers, [{ item: "Q-1", choice: "b" }]);
  }));

test("feedback on lines or choices that don't exist is rejected with the field", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    const res = await post(base, review_id, { verdict: "changes_requested", comments: [{ item: "FR-1", line: 7, body: "x" }] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).errors[0].path, "comments.0.line");
  }));

test("a request for changes with no comment is refused; an empty approval is accepted", () =>
  withServer(async (base, hoop) => {
    // Regression (#181): the page sent a review with no comments, answers or summary.
    const md = "# Plan\n\n## Question: Which store?\n\n- Files\n- SQLite\n\n## Steps\n\n- Build it.\n";
    const { review_id } = hoop.submit(parseMarkdown(md));
    // A resolved thread alone asks for no change either (#223).
    for (const empty of [{}, { summary: "  " }, { comments: [], answers: [], resolved_threads: [], viewed: ["S-2"] }, { resolved_threads: ["th_x_1"] }]) {
      const res = await post(base, review_id, { verdict: "changes_requested", ...empty });
      assert.equal(res.status, 400, JSON.stringify(empty));
      assert.match((await res.json()).error, /Request changes needs a comment: comment on a line or section, write an overall comment, or answer a question/);
    }
    assert.equal(hoop.feedback(review_id).status, "pending", "nothing was recorded");
    // An answer kept from an earlier revision, sent again, adds nothing new.
    assert.equal((await post(base, review_id, { verdict: "changes_requested", answers: [{ item: "S-1", choice: "a" }] })).status, 201);
    hoop.receive(review_id);
    hoop.submit({ ...parseMarkdown(md.replace("Build it.", "Build it with files.")), review_id });
    assert.equal((await post(base, review_id, { verdict: "changes_requested", answers: [{ item: "S-1", choice: "a" }] })).status, 400);
    assert.equal((await post(base, review_id, { verdict: "changes_requested", answers: [{ item: "S-1", choice: "b" }] })).status, 201);
    assert.equal((await post(base, review_id, { verdict: "changes_requested", summary: "Use SQLite." })).status, 201);
    // #165: a question is still in the text, so the reviewer answers it with a request for changes.
    const blocked = await post(base, review_id, { verdict: "approved" });
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).error, /1 question is still in the text: answer it and request changes so Claude writes the decision in/);
    const other = hoop.submit(example());
    assert.equal((await post(base, other.review_id, { verdict: "approved" })).status, 201, "an empty approval is accepted");
  }));

test("a person's review has two verdicts: Comment is refused from the page, and an approval carries no new comments", () =>
  withServer(async (base, hoop) => {
    // #223: an approval with the reviewer's own new comments contradicted them, and Comment left Claude guessing.
    const { review_id } = hoop.submit(example());
    const line = { item: "FR-3", line: 1, body: "Inclusive?" };
    const comment = await post(base, review_id, { verdict: "comment", comments: [line] });
    assert.equal(comment.status, 400);
    assert.match((await comment.json()).error, /a review is approved or has changes requested/);
    const approval = await post(base, review_id, { verdict: "approved", comments: [line] });
    assert.equal(approval.status, 400);
    assert.match((await approval.json()).error, /an approval can't carry new comments \(1 sent\): request changes, or delete them to approve/);
    assert.equal(hoop.feedback(review_id).status, "pending", "nothing was recorded");
    // A session's own comment keeps the Comment verdict.
    const session = new Hoop(hoop.store, "other-session-1234").comment(review_id, line);
    assert.equal(session.verdict, "comment");
    const resolved_threads = [session.comments[0]!.thread];
    assert.equal((await post(base, review_id, { verdict: "approved", summary: "Ship it.", resolved_threads })).status, 201, "an approval's notes are fine");
  }));

test("a review stored with the Comment verdict still reads and shows as it was", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    // As an older hoop stored a person's Comment.
    hoop.review(review_id, { verdict: "comment", reviewer: "ana", summary: "Looks close." });
    const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
    assert.equal(view.status_key, "commented");
    assert.equal(view.feedback[0].verdict, "comment");
    assert.equal(view.trail.at(-1).what, "comment");
    const fb = hoop.receive(review_id);
    assert.equal(fb.status === "reviewed" && fb.feedback[0]!.verdict, "comment");
  }));

test("Claude's reply joins the thread; an approved review reopens on a request for changes", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    await post(base, review_id, { verdict: "changes_requested", comments: [{ item: "FR-3", line: 1, body: "why?" }] });
    const thread = `th_${review_id.slice(3)}_1`;
    hoop.reply(thread, "Because exports should not shift when orders change.");
    const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
    assert.equal(view.replies[0].thread, thread);
    assert.equal(view.replies[0].author, "session test-ses");
    assert.equal(view.meta.owner, "session test-ses");
    assert.equal((await post(base, review_id, { verdict: "approved", resolved_threads: [thread] })).status, 201);
    assert.equal(hoop.store.meta(review_id).status, "approved");
    assert.equal((await post(base, review_id, { verdict: "changes_requested", summary: "late" })).status, 201);
    assert.equal(hoop.store.meta(review_id).status, "open", "a request for changes reopens it");
    assert.throws(() => hoop.reply("th_99", "x"), /no thread th_99/);
  }));

test("an approve from the page with no sign-in is accepted and approves the review", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    // Regression: the page needed a GitHub sign-in, sent as a header, to approve or request changes.
    const changes = await post(base, review_id, { verdict: "changes_requested", summary: "One thing" });
    assert.equal(changes.status, 201);
    hoop.receive(review_id);
    hoop.submit({ ...example(), review_id });
    const res = await post(base, review_id, { verdict: "approved", summary: "Ship it.", signed_in: { login: "forged" }, session: { id: "forged" } });
    assert.equal(res.status, 201);
    const fb = await res.json();
    assert.equal(fb.reviewer, currentUser(), "the verdict names the person running hoop");
    assert.equal("signed_in" in fb || "session" in fb, false, "the page can't set either");
    assert.equal(hoop.store.meta(review_id).status, "approved");
    assert.equal((await post(base, review_id, { verdict: "approved" })).status, 400, "an approved review isn't approved again");
    const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
    assert.deepEqual(view.trail.at(-1), { at: fb.at, who: currentUser(), revision: 2, what: "approval", review: "2.0" });
    for (const path of ["/api/whoami", "/signin.js"]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    assert.equal((await fetch(`${base}/api/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
  }));

test("feedback stored with a sign-in's signed_in still loads", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    const fb = { schema: "hoop/feedback@0", review_id, revision: 1, verdict: "approved", comments: [], reviewer: "ana", at: new Date().toISOString() };
    const old = { ...fb, answers: [], resolved_threads: [], viewed: [], signed_in: { login: "ana-gh" } };
    writeFileSync(join(hoop.store.root, review_id, "feedback-1.json"), JSON.stringify([old]));
    const read = hoop.feedback(review_id);
    assert.equal(read.status, "reviewed");
    if (read.status === "reviewed") assert.equal(read.feedback[0]!.verdict, "approved");
    const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
    assert.deepEqual(view.trail.at(-1), { at: fb.at, who: "ana", revision: 1, what: "approval", review: "1.0" });
    const parsed = validateFeedback(old);
    assert.equal(parsed.ok, true, "the contract ignores the field");
    if (parsed.ok) assert.equal("signed_in" in parsed.value, false);
  }));

test("cross-site requests are refused: foreign Origin, non-JSON POST, foreign Host", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    const url = `${base}/api/reviews/${review_id}/feedback`;
    const body = JSON.stringify({ verdict: "approved" });
    const evil = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body });
    assert.equal(evil.status, 403);
    const plain = await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body });
    assert.equal(plain.status, 415);
    const { request } = await import("node:http");
    const rebound = await new Promise<number>((resolve) => {
      const u = new URL(`${base}/api/reviews`);
      request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: "attacker.example:4747" } }, (res) => resolve(res.statusCode!)).end();
    });
    assert.equal(rebound, 403);
    assert.equal(hoop.store.meta(review_id).status, "open");
    const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: base }, body });
    assert.equal(ok.status, 201);
  }));

test("thread ids are unique across reviews, so a reply lands on the right review", () =>
  withServer(async (_base, hoop) => {
    const a = hoop.submit(example()),
      b = hoop.submit(example());
    const ta = hoop.review(a.review_id, { verdict: "comment", comments: [{ item: "FR-1", line: 1, body: "a" }] }).comments[0]!.thread!;
    const tb = hoop.review(b.review_id, { verdict: "comment", comments: [{ item: "FR-1", line: 1, body: "b", thread: "th_forged_1" }] }).comments[0]!.thread!;
    assert.notEqual(ta, tb);
    assert.notEqual(tb, "th_forged_1");
    hoop.reply(tb, "for b");
    assert.equal(hoop.store.replies(b.review_id).length, 1);
    assert.equal(hoop.store.replies(a.review_id).length, 0);
  }));

test("the review view sends each item's blocks, and earlier revisions' blocks beside history", () =>
  withServer(async (base, hoop) => {
    const doc = parseMarkdown("# Title\n\n## One\n\n- an item\n\nText.\n", {});
    const { review_id } = hoop.submit(doc);
    hoop.submit({ ...parseMarkdown("# Title\n\n## One\n\n> a quote\n", {}), review_id });
    const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
    assert.deepEqual(view.doc.items[0].blocks, [{ kind: "quote", indent: 0 }]);
    assert.deepEqual(view.previous.items[0].blocks, [
      { kind: "list", indent: 0 },
      { kind: "paragraph", indent: 0 },
    ]);
    assert.deepEqual(view.history_blocks, {
      1: {
        [view.doc.items[0].id]: [
          { kind: "list", indent: 0 },
          { kind: "paragraph", indent: 0 },
        ],
      },
    });
    assert.equal("blocks" in view.history[1], false, "history keeps its shape");
  }));
