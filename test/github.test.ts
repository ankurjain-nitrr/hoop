import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHub, type GhRunner } from "../src/github.js";
import { Hoop } from "../src/hoop.js";
import { readCheckboxAnswers } from "../src/render.js";
import { Store } from "../src/store.js";
import { example, tempHome } from "./helpers.js";

type Call = { method: string; path: string; body?: any };

/** A fake `gh`: records API calls and answers them from `responses` by "METHOD path". */
export function fakeGh(responses: Record<string, (body: any) => unknown>) {
  const calls: Call[] = [];
  const run: GhRunner = async (args, opts) => {
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "acme/orders", defaultBranchRef: { name: "main" } });
    const method = args[args.indexOf("--method") + 1]!,
      path = args[args.indexOf("--method") + 2]!;
    const body = opts?.input ? JSON.parse(opts.input) : undefined;
    calls.push({ method, path, body });
    const handler = responses[`${method} ${path}`];
    if (!handler) throw new Error(`gh api: unexpected ${method} ${path}`);
    return JSON.stringify(handler(body) ?? {});
  };
  return { run, calls };
}

const repoResponses = (extra: Record<string, (b: any) => unknown> = {}) => ({
  "GET repos/acme/orders/git/ref/heads/main": () => ({ object: { sha: "base1" } }),
  "GET repos/acme/orders/git/commits/base1": () => ({ tree: { sha: "tree0" } }),
  "POST repos/acme/orders/git/trees": () => ({ sha: "tree1" }),
  "POST repos/acme/orders/git/commits": () => ({ sha: "c1" }),
  "POST repos/acme/orders/git/refs": () => ({}),
  "POST repos/acme/orders/pulls": () => ({ number: 42, html_url: "https://github.com/acme/orders/pull/42" }),
  ...extra,
});

test("a github submit opens a PR with the decision files and question checkboxes", async () => {
  const gh = fakeGh(repoResponses());
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const res = await hoop.submitAny({ ...example(), channel: "github" });
  assert.equal(res.url, "https://github.com/acme/orders/pull/42");
  const tree = gh.calls.find((c) => c.path.endsWith("git/trees"))!.body;
  assert.deepEqual(
    tree.tree.map((t: any) => t.path),
    ["decisions/order-export-requirements.json", "decisions/order-export-requirements.md"],
  );
  assert.match(tree.tree[1].content, /^FR-1 · When a client calls GET \/orders\/export/m);
  assert.equal(gh.calls.find((c) => c.path.endsWith("git/refs"))!.body.ref, "refs/heads/hoop/order-export-requirements");
  const pr = gh.calls.find((c) => c.path.endsWith("/pulls"))!.body;
  assert.equal(pr.base, "main");
  assert.match(pr.body, /- \[ \] `Q-1:b` A new Postgres orders table/);
  assert.deepEqual(hoop.store.meta(res.review_id).github, {
    repo: "acme/orders",
    pr: 42,
    branch: "hoop/order-export-requirements",
    url: res.url,
    commits: { c1: 1 },
  });
});

test("a taken branch name gets a suffix", async () => {
  let tries = 0;
  const gh = fakeGh(
    repoResponses({
      "POST repos/acme/orders/git/refs": () => {
        if (++tries === 1) throw new Error("gh api: Reference already exists");
        return {};
      },
    }),
  );
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const res = await hoop.submitAny({ ...example(), channel: "github" });
  assert.equal(hoop.store.meta(res.review_id).github?.branch, "hoop/order-export-requirements-2");
});

test("a revision is a new commit on the same PR and keeps ticked answers in the description", async () => {
  const gh = fakeGh(
    repoResponses({
      "GET repos/acme/orders/git/ref/heads/hoop/order-export-requirements": () => ({ object: { sha: "c1" } }),
      "GET repos/acme/orders/git/commits/c1": () => ({ tree: { sha: "tree1" } }),
      "PATCH repos/acme/orders/git/refs/heads/hoop/order-export-requirements": () => ({}),
      "GET repos/acme/orders/pulls/42": () => ({ body: "- [x] `Q-1:a` The existing in-memory list" }),
      "PATCH repos/acme/orders/pulls/42": () => ({}),
    }),
  );
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const first = await hoop.submitAny({ ...example(), channel: "github" });
  const rev2 = await hoop.submitAny({ ...example(), channel: "github", review_id: first.review_id, title: "Order export v2" });
  assert.equal(rev2.revision, 2);
  assert.equal(rev2.url, first.url);
  const commit = gh.calls.filter((c) => c.path.endsWith("git/commits") && c.method === "POST").at(-1)!.body;
  assert.deepEqual(commit.parents, ["c1"]);
  assert.match(commit.message, /rev 2/);
  const body = gh.calls.find((c) => c.method === "PATCH" && c.path.endsWith("pulls/42"))!.body.body;
  assert.deepEqual(readCheckboxAnswers(body), { "Q-1": "a" });
  assert.match(body, /hoop:order-export-requirements rev 2/);
});

const prResponses = (over: Record<string, (b: any) => unknown> = {}) => ({
  ...repoResponses(),
  "GET repos/acme/orders/pulls/42": () => ({ body: "- [ ] `Q-1:a` x\n- [x] `Q-1:b` y", merged: false, state: "open" }),
  "GET repos/acme/orders/pulls/42/reviews?per_page=100": () => [
    { id: 991, state: "CHANGES_REQUESTED", body: "Two things", user: { login: "priya" }, submitted_at: "2026-10-13T10:00:00Z", commit_id: "c1" },
  ],
  "GET repos/acme/orders/pulls/42/comments?per_page=100": () => [],
  ...over,
});

/** The markdown line number of an item line in rev 1 of the example. */
async function mdLine(item: string, line: number) {
  const { renderMarkdown } = await import("../src/render.js");
  const { validateReview } = await import("../src/contract.js");
  const doc = (validateReview({ ...example(), channel: "github" }) as any).value;
  return Number(Object.entries(renderMarkdown(doc, 1).lineMap).find(([, r]) => r.item === item && r.line === line)![0]);
}

test("a PR review becomes a feedback document: comments mapped to item and line, suggestions, replies, answers", async () => {
  const fr3 = await mdLine("FR-3", 1),
    fr1 = await mdLine("FR-1", 2);
  const comments = [
    {
      id: 7001,
      body: "Use created_at",
      path: "decisions/order-export-requirements.md",
      line: fr3,
      original_line: fr3,
      original_commit_id: "c1",
      pull_request_review_id: 991,
      user: { login: "priya" },
      created_at: "t",
    },
    {
      id: 7002,
      body: "Shorter:\n```suggestion\nFR-1 · Rows shall stream as read.\n```",
      path: "decisions/order-export-requirements.md",
      line: fr1,
      original_line: fr1,
      original_commit_id: "c1",
      pull_request_review_id: 991,
      user: { login: "priya" },
      created_at: "t",
    },
    {
      id: 7003,
      body: "+1",
      path: "decisions/order-export-requirements.md",
      line: null,
      original_line: fr3,
      original_commit_id: "c1",
      in_reply_to_id: 7001,
      pull_request_review_id: 991,
      user: { login: "sam" },
      created_at: "t",
    },
  ];
  const gh = fakeGh(prResponses({ "GET repos/acme/orders/pulls/42/comments?per_page=100": () => comments }));
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const { review_id } = await hoop.submitAny({ ...example(), channel: "github" });
  const res = await hoop.feedbackAny(review_id);
  assert.equal(res.status, "reviewed");
  if (res.status !== "reviewed") return;
  assert.equal(res.approved, false);
  assert.equal(res.url, "https://github.com/acme/orders/pull/42");
  const f = res.feedback[0]!;
  assert.equal(f.verdict, "changes_requested");
  assert.equal(f.reviewer, "priya");
  assert.equal(f.summary, "Two things");
  assert.deepEqual(f.comments, [
    { thread: "gh_7001", item: "FR-3", line: 1, body: "Use created_at" },
    { thread: "gh_7002", item: "FR-1", line: 2, body: "Shorter:", suggestion: "Rows shall stream as read." },
    { thread: "gh_7001", item: "FR-3", line: 1, body: "+1" },
  ]);
  assert.deepEqual(f.answers, [{ item: "Q-1", choice: "b" }]);
  assert.deepEqual(f.source, { channel: "github", pr: 42, review_id: 991, comment_ids: [7001, 7002, 7003] });
});

test("a merged PR is approved and reports the decision files; replies go to the GitHub thread", async () => {
  const replies: any[] = [];
  const gh = fakeGh(
    prResponses({
      "GET repos/acme/orders/pulls/42": () => ({ body: "", merged: true, merged_at: "2026-10-01T10:00:00Z", state: "closed" }),
      "GET repos/acme/orders/pulls/42/reviews?per_page=100": () => [],
      "POST repos/acme/orders/pulls/42/comments/7001/replies": (b) => (replies.push(b), { id: 9001 }),
    }),
  );
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const { review_id } = await hoop.submitAny({ ...example(), channel: "github" });
  const res = await hoop.feedbackAny(review_id);
  assert.equal(res.status === "reviewed" && res.approved, true);
  assert.deepEqual(res.status === "reviewed" && res.decision_files, ["decisions/order-export-requirements.json", "decisions/order-export-requirements.md"]);
  assert.equal(hoop.store.meta(review_id).approved_at, "2026-10-01T10:00:00Z", "approval time is the merge time, not the sync time");
  hoop.store.setFeedback(review_id, [
    {
      schema: "hoop/feedback@0",
      review_id,
      revision: 1,
      verdict: "comment",
      comments: [{ thread: "gh_7001", item: "FR-3", line: 1, body: "why" }],
      answers: [],
      resolved_threads: [],
      viewed: [],
      reviewer: "priya",
      at: "t",
    },
  ]);
  await hoop.replyAny("gh_7001", "Because exports must not shift.");
  assert.deepEqual(replies, [{ body: "Because exports must not shift." }]);
  await assert.rejects(hoop.replyAny("gh_9999", "x"), /no thread gh_9999/);
});

test("the review page refuses local feedback for a GitHub review", async () => {
  const hoop = new Hoop(new Store(tempHome()), new GitHub(fakeGh(prResponses()).run));
  const { review_id } = await hoop.submitAny({ ...example(), channel: "github" });
  assert.throws(() => hoop.review(review_id, { verdict: "comment" }), /reviewed on GitHub/);
});

test("Claude's own replies, ticked boxes and resolved threads don't count as a new review", async () => {
  let reviews: any[] = [],
    comments: any[] = [];
  const gh = fakeGh(
    prResponses({
      "GET repos/acme/orders/pulls/42": () => ({ body: "- [x] `Q-1:b` y", merged: false, state: "open" }),
      "GET repos/acme/orders/pulls/42/reviews?per_page=100": () => reviews,
      "GET repos/acme/orders/pulls/42/comments?per_page=100": () => comments,
      "POST repos/acme/orders/pulls/42/comments/7001/replies": () => ({ id: 8001 }),
    }),
  );
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const { review_id } = await hoop.submitAny({ ...example(), channel: "github" });
  const pending = await hoop.feedbackAny(review_id);
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.answers, [{ item: "Q-1", choice: "b" }]);
  const line = await mdLine("FR-3", 1);
  reviews = [{ id: 991, state: "COMMENTED", body: "", user: { login: "priya" }, submitted_at: "t", commit_id: "c1" }];
  comments = [
    {
      id: 7001,
      body: "why?",
      path: "decisions/order-export-requirements.md",
      line,
      original_line: line,
      original_commit_id: "c1",
      pull_request_review_id: 991,
      user: { login: "priya" },
      created_at: "t",
    },
  ];
  assert.equal((await hoop.feedbackAny(review_id)).status, "reviewed");
  const thread = ((await hoop.feedbackAny(review_id)) as any).feedback[0].comments[0].thread;
  await hoop.replyAny(thread, "Because.");
  reviews.push({ id: 992, state: "COMMENTED", body: "", user: { login: "ankur" }, submitted_at: "t2", commit_id: "c1" });
  comments.push({
    id: 8001,
    body: "Because.",
    path: "decisions/order-export-requirements.md",
    line,
    original_line: line,
    original_commit_id: "c1",
    in_reply_to_id: 7001,
    pull_request_review_id: 992,
    user: { login: "ankur" },
    created_at: "t2",
  });
  const after = await hoop.feedbackAny(review_id);
  assert.equal(after.status === "reviewed" && after.feedback.length, 1);
  assert.equal(after.status === "reviewed" && after.feedback[0]!.comments.length, 1);
});

test("comments off item lines go into the summary instead of being dropped", async () => {
  const gh = fakeGh(
    prResponses({
      "GET repos/acme/orders/pulls/42/comments?per_page=100": () => [
        {
          id: 7101,
          body: "Title is vague",
          path: "decisions/order-export-requirements.md",
          line: 2,
          original_line: 2,
          original_commit_id: "c1",
          pull_request_review_id: 991,
          user: { login: "priya" },
          created_at: "t",
        },
        {
          id: 7102,
          body: "Odd field",
          path: "decisions/order-export-requirements.json",
          line: 3,
          original_line: 3,
          original_commit_id: "c1",
          pull_request_review_id: 991,
          user: { login: "priya" },
          created_at: "t",
        },
      ],
    }),
  );
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const { review_id } = await hoop.submitAny({ ...example(), channel: "github" });
  const res = await hoop.feedbackAny(review_id);
  const f = res.status === "reviewed" ? res.feedback[0]! : undefined;
  assert.match(f!.summary!, /Two things/);
  assert.match(f!.summary!, /On decisions\/order-export-requirements\.md line 2: Title is vague/);
  assert.match(f!.summary!, /\.json line 3: Odd field/);
});

test("a PR closed without merging is a rejected decision, and wait returns on it", async () => {
  const gh = fakeGh(
    prResponses({
      "GET repos/acme/orders/pulls/42": () => ({ body: "", merged: false, state: "closed" }),
      "GET repos/acme/orders/pulls/42/reviews?per_page=100": () => [],
    }),
  );
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const { review_id } = await hoop.submitAny({ ...example(), channel: "github" });
  const { waitForReview } = await import("../src/wait.js");
  const res = await waitForReview(hoop, review_id, { intervalMs: 10, timeoutMs: 500 });
  assert.equal(res?.status === "reviewed" && res.closed, true);
  assert.equal(res?.status === "reviewed" && res.approved, false);
});

test("a failed PR push leaves no revision behind; a local submit can't revise a GitHub review", async () => {
  const gh = fakeGh(
    repoResponses({
      "GET repos/acme/orders/git/ref/heads/hoop/order-export-requirements": () => {
        throw new Error("gh api: 502");
      },
    }),
  );
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const { review_id } = await hoop.submitAny({ ...example(), channel: "github" });
  await assert.rejects(hoop.submitAny({ ...example(), channel: "github", review_id }), /502/);
  assert.equal(hoop.store.meta(review_id).revisions, 1);
  await assert.rejects(hoop.submitAny({ ...example(), review_id }), /is on GitHub/);
});

test("wait retries through transient gh errors", async () => {
  let n = 0;
  const gh = fakeGh(
    prResponses({
      "GET repos/acme/orders/pulls/42": () => {
        if (++n <= 3) throw new Error("gh api: rate limited");
        return { body: "", merged: true, state: "closed" };
      },
    }),
  );
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const { review_id } = await hoop.submitAny({ ...example(), channel: "github" });
  const { waitForReview } = await import("../src/wait.js");
  const res = await waitForReview(hoop, review_id, { intervalMs: 5, timeoutMs: 2000 });
  assert.equal(res?.status === "reviewed" && res.approved, true);
});

test("a GitHub response without a field hoop reads fails naming the endpoint and the field", async () => {
  const gh = fakeGh(prResponses({ "GET repos/acme/orders/pulls/42": () => ({ body: "", state: "open" }) }));
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const { review_id } = await hoop.submitAny({ ...example(), channel: "github" });
  await assert.rejects(
    hoop.feedbackAny(review_id),
    /unexpected GitHub response from GET repos\/acme\/orders\/pulls\/42: merged: Invalid input: expected boolean, received undefined/,
  );
});

test("sync accepts what real GitHub sends: pending and dismissed reviews, a gone commit, a deleted user, a null thread id", async () => {
  const fr3 = await mdLine("FR-3", 1);
  const gh = fakeGh(
    prResponses({
      "GET repos/acme/orders/pulls/42/reviews?per_page=100": () => [
        { id: 990, state: "PENDING", body: "", user: { login: "me" }, commit_id: "c1" },
        { id: 989, state: "DISMISSED", body: "", user: null, submitted_at: "2026-10-13T09:00:00Z", commit_id: "c1" },
        { id: 991, state: "COMMENTED", body: "", user: { login: "priya" }, submitted_at: "2026-10-13T10:00:00Z", commit_id: null },
      ],
      "GET repos/acme/orders/pulls/42/comments?per_page=100": () => [
        {
          id: 7001,
          body: "Use created_at",
          path: "decisions/order-export-requirements.md",
          line: fr3,
          original_line: fr3,
          original_commit_id: null,
          pull_request_review_id: 991,
          user: null,
          created_at: "t",
        },
      ],
      "api graphql": () => ({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  { isResolved: true, comments: { nodes: [{ databaseId: null }] } },
                  null,
                  { isResolved: true, comments: { nodes: [{ databaseId: 7001 }] } },
                ],
              },
            },
          },
        },
      }),
    }),
  );
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const { review_id } = await hoop.submitAny({ ...example(), channel: "github" });
  const res = await hoop.feedbackAny(review_id);
  assert.equal(res.status, "reviewed");
  const fb = res.status === "reviewed" ? res.feedback : [];
  assert.deepEqual(
    fb.map((f) => [f.reviewer, f.revision, f.verdict]),
    [["priya", 1, "comment"]],
    "pending and dismissed reviews are skipped",
  );
  assert.deepEqual(
    fb[0]!.comments.map((c) => [c.item, c.line, c.body]),
    [["FR-3", 1, "Use created_at"]],
  );
  assert.deepEqual(fb[0]!.resolved_threads, ["gh_7001"], "a resolved thread with a null id doesn't drop the others");
});
