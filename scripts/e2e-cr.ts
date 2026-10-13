// Acceptance run for CR-3: one change from capture to fold through the terminal commands alone,
// with a reviewer approving in Chrome on `hoop serve` and fold checking a real merged PR with gh.
// Needs Node 20+, Chrome and a gh login that can read ankurjain-nitrr/hoop.
// Usage: npx tsx scripts/e2e-cr.ts
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const root = new URL("..", import.meta.url).pathname;
const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
const cli = join(root, "src/cli.ts");
const chrome = process.env.HOOP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MERGED_PR = 27; // a merged PR in the repository below
const repo = mkdtempSync(join(tmpdir(), "hoop-e2e-cr-repo-"));
const env = { ...(process.env as Record<string, string>), HOOP_HOME: mkdtempSync(join(tmpdir(), "hoop-e2e-cr-home-")), HOOP_REPO_DIR: repo, HOOP_PORT: "4792" };
const base = "http://localhost:4792";
const step = (s: string) => process.stdout.write(`• ${s}\n`);

/** Runs a hoop command in the repository; `json` adds --json and parses the output. */
function hoop(args: string[], opts: { input?: string; fail?: boolean } = {}) {
  const r = spawnSync(process.execPath, [tsx, cli, ...args, "--json"], { cwd: repo, env, input: opts.input, encoding: "utf8" });
  if (opts.fail) {
    assert.equal(r.status, 1, `expected hoop ${args.join(" ")} to fail`);
    return r.stderr;
  }
  assert.equal(r.status, 0, `hoop ${args.join(" ")}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// A repository whose remote is hoop's, so gh can read the PR linked at fold.
spawnSync("git", ["init", "-q"], { cwd: repo });
spawnSync("git", ["remote", "add", "origin", "https://github.com/ankurjain-nitrr/hoop.git"], { cwd: repo });
mkdirSync(join(repo, "docs", "changes"), { recursive: true });
writeFileSync(join(repo, "docs", "TRACKER.md"), "# Tracker\n\n| ID | Parent | Type | Title | Status | Phase |\n|---|---|---|---|---|---|\n");

const server = spawn(process.execPath, [tsx, cli, "serve"], { env });
await new Promise((r) => server.stdout.once("data", r));
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
const approve = async (url: string) => {
  await page.goto(url);
  await page.getByRole("button", { name: /Finish your review/ }).click();
  await page.locator("#v-approve").check();
  await page.getByRole("button", { name: "Submit review" }).click();
  await page.getByText(/Review submitted: Approved/).waitFor();
};

try {
  step("FR-1: capture a request as written; it shows on the tracker at intake");
  const request = "Let users export orders as CSV.\nFrom the orders page.  \n";
  const cr = hoop(["cr", "create", "--type", "story", "--reason", "one capability"], { input: request });
  assert.equal(cr.id, "CR-1");
  assert.equal(readFileSync(join(repo, "docs/changes/CR-1-let-users-export-orders-as-csv/REQUEST.md"), "utf8"), request);
  assert.deepEqual(hoop(["tracker"]).items.map((i: any) => [i.id, i.status, i.phase]), [["CR-1", "queued", "intake"]]);

  step("FR-2, FR-3: reclassify with a reason; the correction is recorded");
  assert.equal(hoop(["cr", "classify", "CR-1", "task", "--reason", "small", "--why", "one endpoint, no UI"]).type, "task");
  assert.match(readFileSync(join(repo, "docs/changes/CLASSIFICATION.md"), "utf8"), /\| CR-1 \| Let users export orders as CSV\. \| story \| task \| one endpoint, no UI \|/);

  step("FR-4, NFR-1: an HLD before an approved PRD is refused, naming what to do");
  for (const d of ["PRD", "HLD", "LLD"]) writeFileSync(join(repo, `${d}.md`), `# ${d}\n\nThe ${d} for CSV export.\n`);
  assert.match(hoop(["submit", "HLD.md", "--cr", "CR-1", "--doc", "hld"], { fail: true }), /CR-1 has no PRD review; run hoop submit PRD.md --cr CR-1 --doc prd/);

  step("FR-4: PRD, HLD and LLD reviewed and approved in order in the browser");
  const ids: Record<string, string> = {};
  for (const d of ["prd", "hld", "lld"]) {
    const sub = hoop(["submit", `${d.toUpperCase()}.md`, "--cr", "CR-1", "--doc", d]);
    ids[d] = sub.review_id;
    if (d === "prd") assert.match(hoop(["submit", "LLD.md", "--cr", "CR-1", "--doc", "lld"], { fail: true }), /CR-1 has no HLD review/);
    await approve(sub.url);
  }
  assert.equal(hoop(["cr", "show", "CR-1"]).ready.ok, true);

  step("FR-5, FR-7: a revised PRD makes the HLD and LLD stale; build is refused until they're re-approved");
  writeFileSync(join(repo, "PRD.md"), "# PRD\n\nThe PRD for CSV export, with a row limit.\n");
  const prd2 = hoop(["submit", "PRD.md", "--review", ids.prd!]);
  assert.notEqual(prd2.review_id, ids.prd);
  await approve(prd2.url);
  assert.deepEqual(hoop(["cr", "show", "CR-1"]).documents.map((d: any) => [d.doc, d.stale]), [["prd", false], ["hld", true], ["lld", true]]);
  hoop(["cr", "step", "CR-1", "plan"]);
  assert.match(hoop(["cr", "step", "CR-1", "build"], { fail: true }), new RegExp(`HLD review ${ids.hld} is stale`));
  for (const d of ["hld", "lld"]) await approve(hoop(["submit", `${d.toUpperCase()}.md`, "--review", ids[d]!]).url);
  assert.equal(hoop(["cr", "step", "CR-1", "build"]).steps.at(-1).step, "build");

  step("FR-9: the tracker page shows the change at build");
  await page.goto(`${base}/tracker`);
  await page.locator('tr[data-tree-id="CR-1"]').waitFor();
  assert.match(await page.locator('tr[data-tree-id="CR-1"]').innerText(), /task[\s\S]*in progress[\s\S]*build/);

  step("FR-6, FR-7: steps through merge; fold needs a linked, merged PR (checked with gh)");
  for (const s of ["review", "accept", "merge"]) hoop(["cr", "step", "CR-1", s]);
  assert.match(hoop(["cr", "step", "CR-1", "fold"], { fail: true }), /no PRs linked; run hoop cr link-pr CR-1 <number>/);
  hoop(["cr", "link-pr", "CR-1", String(MERGED_PR)]);
  const folded = hoop(["cr", "step", "CR-1", "fold"]);
  assert.deepEqual(folded.steps.map((s: any) => s.step), ["intake", "prd", "hld", "lld", "plan", "build", "review", "accept", "merge", "fold"]);
  assert.deepEqual(hoop(["tracker"]).items.map((i: any) => [i.id, i.status, i.phase]), [["CR-1", "done", "fold"]]);

  step("FR-11: bookkeeping and export from the terminal");
  hoop(["tracker", "set", "CR-1", `PR=#${MERGED_PR}`]);
  assert.match(readFileSync(join(repo, "docs/TRACKER.md"), "utf8"), new RegExp(`\\| CR-1 \\| \\| task \\| .* \\| done \\| fold \\| #${MERGED_PR} \\|`));
  hoop(["export", prd2.review_id, "--out", join(repo, "PRD.exported.md")]);
  assert.equal(readFileSync(join(repo, "PRD.exported.md"), "utf8"), readFileSync(join(repo, "PRD.md"), "utf8"));
  step("Acceptance run passed");
} finally {
  await browser.close();
  server.kill();
}
