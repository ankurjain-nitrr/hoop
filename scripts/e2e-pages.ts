// Acceptance run for the pages process: two `hoop mcp` sessions in two repositories share one background pages
// process on one address. Each page names its document's repository, the tracker page offers both,
// and the pages outlive the session that started them. Needs Node 20+ and Chrome.
// Usage: npx tsx scripts/e2e-pages.ts
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { chrome, connectMcp, runHome, step } from "./lib.js";

const PORT = "4794",
  base = `http://localhost:${PORT}`;
const home = runHome("hoop-e2e-pages-home-");

/** A repository folder whose tracker has one item with `title`. */
function repo(name: string, title: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hoop-e2e-${name}-`));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "TRACKER.md"), `# Tracker\n\n| ID | Parent | Title |\n|---|---|---|\n| T-1 | | ${title} |\n`);
  return realpathSync(dir);
}
const a = repo("alpha", "Work in alpha"),
  b = repo("beta", "Work in beta");
// A short idle time, so the run can show that the pages stay up with no session until it passes.
const env = (dir: string) => ({
  ...(process.env as Record<string, string>),
  HOOP_HOME: home,
  HOOP_REPO_DIR: dir,
  HOOP_PORT: PORT,
  HOOP_PAGES_IDLE_MS: "30000",
});

step("FR-1, FR-2: two sessions in two repositories give links on the usual address");
const began = Date.now();
const first = await connectMcp(env(a), a);
const second = await connectMcp(env(b), b);
const fromA = await first.call("hoop_submit_markdown", { markdown: "# Plan for alpha\n\nAlpha ships first.\n" });
const fromB = await second.call("hoop_submit_markdown", { markdown: "# Plan for beta\n\nBeta ships second.\n" });
for (const r of [fromA, fromB]) assert.equal(new URL(r.url).origin, base);
// FR-2: with no server running, the first session's link opens within five seconds.
assert.equal((await fetch(fromA.url.replace("//localhost:", "//127.0.0.1:"))).status, 200);
assert.ok(Date.now() - began < 5000, `the first link opened after ${Date.now() - began} ms`);
const info = await (await fetch(`http://127.0.0.1:${PORT}/api/info`)).json();
assert.deepEqual(info.repos.map((r: { name: string }) => r.name).sort(), [basename(a), basename(b)].sort());

const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
  const page = await browser.newPage();

  step("FR-6: each review page names its own repository");
  for (const [r, dir] of [
    [fromA, a],
    [fromB, b],
  ] as const) {
    await page.goto(r.url);
    await page.locator(".frame-repo").waitFor();
    assert.equal(await page.locator(".frame-repo").innerText(), basename(dir));
  }

  step("FR-6: the tracker page shows each repository's tracker from one server");
  await page.goto(`${base}/tracker`);
  for (const [dir, title] of [
    [a, "Work in alpha"],
    [b, "Work in beta"],
  ] as const) {
    const key = info.repos.find((r: { name: string }) => r.name === basename(dir)).key;
    await page.locator("#tracker-repo").selectOption(key);
    await page.getByText(title).waitFor();
    assert.equal(await page.locator(".frame-repo").innerText(), basename(dir));
  }

  step("FR-7: the header shows the serving version");
  assert.match(await page.locator(".frame-version").innerText(), /^v\d+\.\d+\.\d+/);

  step("FR-2: after the first session ends, the other session keeps working");
  await first.client.close();
  const later = await second.call("hoop_submit_markdown", { markdown: "# Beta notes\n\nStill working.\n" });
  await page.goto(later.url);
  await page.getByText("Still working.").waitFor();

  step("FR-2: with both sessions ended, the pages still answer past an idle check");
  await second.client.close();
  // The idle check runs every five seconds; this waits past one, inside the idle time.
  await new Promise((r) => setTimeout(r, 6000));
  await page.goto(fromA.url);
  await page.getByText("Alpha ships first.").waitFor();
  assert.equal((await (await fetch(`http://127.0.0.1:${PORT}/api/info`)).json()).pid, info.pid, "one pages process served it all");
} finally {
  await browser.close();
  await first.client.close().catch(() => {});
  await second.client.close().catch(() => {});
}

step("Acceptance run passed");
process.exit(0);
