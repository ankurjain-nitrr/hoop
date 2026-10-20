// Live end-to-end run of the GitHub channel against a real repository you own.
// Usage: HOOP_E2E_REPO=owner/name npx tsx scripts/e2e-github.ts
// It clones the repo to a temp dir, drives `hoop mcp` like Claude would, reviews the PR with `gh`,
// merges it, and checks every step. It leaves a merged decision PR and decisions/ files behind.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { cli, connectMcp, root, tsx } from "./lib.js";

const repo = process.env.HOOP_E2E_REPO;
if (!repo) throw new Error("set HOOP_E2E_REPO=owner/name (a repo you can push to and merge in)");
const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8" });
const step = (s: string) => process.stdout.write(`\n• ${s}\n`);

const dir = mkdtempSync(join(tmpdir(), "hoop-e2e-"));
const home = mkdtempSync(join(tmpdir(), "hoop-e2e-home-"));
execFileSync("gh", ["repo", "clone", repo, join(dir, "repo"), "--", "-q"]);
const cwd = join(dir, "repo");
const env = { ...(process.env as Record<string, string>), HOOP_HOME: home, HOOP_REPO_DIR: cwd, HOOP_PORT: "4790" };

const { client, call } = await connectMcp(env, cwd);

const slug = `e2e-${Date.now().toString(36)}`;
const doc = JSON.parse(readFileSync(join(root, "examples/order-export.json"), "utf8"));
Object.assign(doc, { channel: "github", slug, title: `E2E ${slug}` });

step("hoop_submit opens a decision PR");
const sub = await call("hoop_submit", { document: doc });
const pr = Number(String(sub.url).split("/").pop());
console.log(`  ${sub.url}`);
const files = JSON.parse(gh("api", `repos/${repo}/pulls/${pr}/files`)).map((f: { filename: string }) => f.filename);
assert.deepEqual(files.sort(), [`decisions/${slug}.json`, `decisions/${slug}.md`]);

step("review the PR on GitHub: a line comment with a suggestion, a ticked checkbox");
const md = gh("api", `repos/${repo}/contents/decisions/${slug}.md?ref=hoop/${slug}`, "--jq", ".content");
const lines = Buffer.from(md, "base64").toString("utf8").split("\n");
const fr3 = lines.findIndex((l) => l.startsWith("FR-3 · When from or to")) + 1;
const review = {
  event: "COMMENT",
  body: "E2E review",
  comments: [
    {
      path: `decisions/${slug}.md`,
      line: fr3,
      body: "Inclusive bounds?\n```suggestion\nFR-3 · When from or to are given, the system shall include orders created within both bounds, inclusive.\n```",
    },
  ],
};
execFileSync("gh", ["api", "--method", "POST", `repos/${repo}/pulls/${pr}/reviews`, "--input", "-"], { input: JSON.stringify(review) });
const body = JSON.parse(gh("api", `repos/${repo}/pulls/${pr}`)).body as string;
execFileSync("gh", ["api", "--method", "PATCH", `repos/${repo}/pulls/${pr}`, "--input", "-"], {
  input: JSON.stringify({ body: body.replace("- [ ] `Q-1:b`", "- [x] `Q-1:b`") }),
});

step("hoop_feedback maps the GitHub review back to the contract");
const fb = await call("hoop_feedback", { review_id: sub.review_id });
assert.equal(fb.status, "reviewed");
const f = fb.feedback.at(-1);
const c = f.comments[0];
assert.equal(c.item, "FR-3");
assert.equal(c.line, 1);
assert.equal(c.body, "Inclusive bounds?");
assert.equal(c.suggestion, "When from or to are given, the system shall include orders created within both bounds, inclusive.");
assert.deepEqual(f.answers, [{ item: "Q-1", choice: "b" }]);
console.log(`  ${JSON.stringify(c)}`);

step("hoop_reply answers in the GitHub thread");
await call("hoop_reply", { thread: c.thread, body: "Yes: both bounds inclusive in rev 2." });
const replies = JSON.parse(gh("api", `repos/${repo}/pulls/${pr}/comments`)).filter((x: { in_reply_to_id?: number }) => x.in_reply_to_id);
assert.equal(replies.length, 1);

step("a revision is a new commit on the same PR and keeps the ticked answer");
doc.items[2].body = "When from or to are given, the system shall include orders created within both bounds, inclusive.";
const rev2 = await call("hoop_submit", { document: { ...doc, review_id: sub.review_id } });
assert.equal(rev2.revision, 2);
assert.equal(JSON.parse(gh("api", `repos/${repo}/pulls/${pr}/commits`)).length, 2);
assert.match(JSON.parse(gh("api", `repos/${repo}/pulls/${pr}`)).body, /- \[x\] `Q-1:b`/);

step("hoop wait exits with approved: true when the PR is merged");
const wait = spawn(process.execPath, [tsx, cli, "wait", sub.review_id, "--timeout", "180"], { env, cwd });
let out = "";
wait.stdout.on("data", (d) => (out += d));
gh("pr", "merge", String(pr), "--repo", repo, "--squash", "--delete-branch");
const code = await new Promise((r) => wait.on("close", r));
assert.equal(code, 0);
const done = JSON.parse(out);
assert.equal(done.approved, true);
assert.deepEqual(done.decision_files, [`decisions/${slug}.json`, `decisions/${slug}.md`]);
gh("api", `repos/${repo}/contents/decisions/${slug}.json`);

await client.close();
process.stdout.write(`\nAll GitHub channel steps passed (${sub.url}).\n`);
