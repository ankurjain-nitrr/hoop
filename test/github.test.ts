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
    const method = args[args.indexOf("--method") + 1]!, path = args[args.indexOf("--method") + 2]!;
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
  assert.deepEqual(tree.tree.map((t: any) => t.path), ["decisions/order-export-requirements.json", "decisions/order-export-requirements.md"]);
  assert.match(tree.tree[1].content, /^FR-1 · When a client calls GET \/orders\/export/m);
  assert.equal(gh.calls.find((c) => c.path.endsWith("git/refs"))!.body.ref, "refs/heads/hoop/order-export-requirements");
  const pr = gh.calls.find((c) => c.path.endsWith("/pulls"))!.body;
  assert.equal(pr.base, "main");
  assert.match(pr.body, /- \[ \] `Q-1:b` A new Postgres orders table/);
  assert.deepEqual(hoop.store.meta(res.review_id).github, { repo: "acme/orders", pr: 42, branch: "hoop/order-export-requirements", url: res.url });
});

test("a taken branch name gets a suffix", async () => {
  let tries = 0;
  const gh = fakeGh(repoResponses({ "POST repos/acme/orders/git/refs": () => { if (++tries === 1) throw new Error("gh api: Reference already exists"); return {}; } }));
  const hoop = new Hoop(new Store(tempHome()), new GitHub(gh.run));
  const res = await hoop.submitAny({ ...example(), channel: "github" });
  assert.equal(hoop.store.meta(res.review_id).github?.branch, "hoop/order-export-requirements-2");
});

test("a revision is a new commit on the same PR and keeps ticked answers in the description", async () => {
  const gh = fakeGh(repoResponses({
    "GET repos/acme/orders/git/ref/heads/hoop/order-export-requirements": () => ({ object: { sha: "c1" } }),
    "GET repos/acme/orders/git/commits/c1": () => ({ tree: { sha: "tree1" } }),
    "PATCH repos/acme/orders/git/refs/heads/hoop/order-export-requirements": () => ({}),
    "GET repos/acme/orders/pulls/42": () => ({ body: "- [x] `Q-1:a` The existing in-memory list" }),
    "PATCH repos/acme/orders/pulls/42": () => ({}),
  }));
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
