import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { BROWSER_SKIP, example, TEST_SESSION, tempHome, withBrowser, pagesFor, hoopArgs } from "./helpers.js";
import { createWebServer } from "../src/web.js";
import { parseMarkdown } from "../src/markdown.js";
import { waitForReview } from "../src/wait.js";
import type { Page } from "playwright-core";

async function withServer(fn: (base: string, hoop: Hoop) => Promise<void>) {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hoop);
  } finally {
    server.close();
  }
}

const op = (name: string) => OPS.find((o) => o.name === name)!;
const receiptsFile = (hoop: Hoop, id: string) => join(hoop.store.dirOf(id), "receipts.json");

/** Writes a session's transcript with a title into the test's Claude Code folder. */
function titled(session: string, title: string) {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-receipts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session}.jsonl`), `${JSON.stringify({ type: "custom-title", customTitle: title })}\n`);
}

/** A submitted review with one person's comment on it. */
function reviewed(hoop = new Hoop(new Store(tempHome()))) {
  const { review_id, cursor } = hoop.submit(example());
  hoop.review(review_id, { verdict: "comment", reviewer: "ana", comments: [{ item: "FR-3", line: 1, body: "Inclusive?" }] });
  return { hoop, review_id, cursor };
}

test("hoop_wait records when the agent received each review, named after its session", async () => {
  titled(TEST_SESSION, "Export plan");
  const { hoop, review_id, cursor } = reviewed();
  assert.equal(existsSync(receiptsFile(hoop, review_id)), false);
  const before = Date.now();
  const result = (await op("wait").run(hoop, { review_id, after: cursor, seconds: 1 }, { actor: "claude" })) as { status: string };
  assert.equal(result.status, "reviewed");
  const receipts = hoop.store.receipts(review_id);
  assert.deepEqual(Object.keys(receipts), ["1.0"]);
  assert.equal(receipts["1.0"]!.by, `Export plan (${TEST_SESSION.slice(0, 8)})`);
  assert.ok(Date.parse(receipts["1.0"]!.at) >= before - 1000);
});

test("a receipt for a review stored in a session's folder lands next to it, not in the home folder", async () => {
  const session = "receipt-session-1";
  const folder = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-receipts");
  titled(session, "Session plan");
  const home = tempHome();
  const { hoop, review_id, cursor } = reviewed(new Hoop(new Store(home), session));
  const dir = join(folder, session, ".hoop", "reviews", review_id);
  assert.equal(hoop.store.dirOf(review_id), dir);
  await op("wait").run(hoop, { review_id, after: cursor, seconds: 1 }, { actor: "claude" });
  assert.ok(existsSync(join(dir, "receipts.json")));
  assert.equal(existsSync(join(home, "reviews", review_id)), false, "nothing in the home folder");
  // Another process on the same home folder, like the pages, reads the same receipts.
  assert.deepEqual(Object.keys(new Store(home).receipts(review_id)), ["1.0"]);
});

test("hoop_feedback records a receipt, outside a session as the agent, and a pending review records none", () => {
  const hoop = new Hoop(new Store(tempHome()), null);
  const owner = new Hoop(hoop.store);
  const { review_id } = owner.submit(example());
  op("feedback").run(hoop, { review_id }, { actor: "claude" });
  assert.equal(existsSync(receiptsFile(hoop, review_id)), false, "no review yet, so nothing was received");
  owner.review(review_id, { verdict: "changes_requested", reviewer: "ana", comments: [], summary: "Split it." });
  op("feedback").run(hoop, { review_id }, { actor: "claude" });
  assert.deepEqual(Object.keys(hoop.store.receipts(review_id)), ["1.0"]);
  assert.equal(hoop.store.receipts(review_id)["1.0"]!.by, "agent");
});

test("a review keeps its first receipt when it is read again, and a later review gets its own", async () => {
  const { hoop, review_id } = reviewed();
  hoop.receive(review_id);
  const first = hoop.store.receipts(review_id)["1.0"]!;
  await new Promise((r) => setTimeout(r, 15));
  titled("other-reader-2222", "Other reader");
  new Hoop(hoop.store, "other-reader-2222").receive(review_id);
  op("feedback").run(hoop, { review_id }, { actor: "claude" });
  const read = { ...first, sessions: [TEST_SESSION, "other-reader-2222"] };
  assert.deepEqual(hoop.store.receipts(review_id)["1.0"], read, "the first read stays, and the other session is added");
  hoop.review(review_id, { verdict: "comment", reviewer: "bo", comments: [{ item: "FR-3", line: 1, body: "Also this." }] });
  hoop.receive(review_id);
  const receipts = hoop.store.receipts(review_id);
  assert.deepEqual(receipts["1.0"], read);
  assert.ok(receipts["1.1"] && receipts["1.1"].at > first.at);
});

test("`hoop wait` and `hoop feedback` in a terminal record receipts", async () => {
  const home = tempHome();
  const pages = await pagesFor(home);
  const store = new Store(home);
  const { review_id, cursor } = new Hoop(store).submit(example());
  const env = { ...process.env, ...pages };
  // The cursor from the submit makes the wait count from there, however late its process starts.
  const wait = spawn(process.execPath, [...hoopArgs, "wait", review_id, "--after", cursor, "--timeout", "30"], { env, stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise<number | null>((r) => wait.on("exit", r));
  // The wait says it is waiting once it has read the review, so a slow start can't miss the review.
  await new Promise<void>((r) => {
    let err = "";
    wait.stderr!.on("data", (d) => (err += d).includes("Waiting for your review") && r());
  });
  assert.equal(existsSync(join(home, "reviews", review_id, "receipts.json")), false);
  new Hoop(store).review(review_id, { verdict: "comment", reviewer: "ana", comments: [{ item: "FR-3", line: 1, body: "Inclusive?" }] });
  assert.equal(await exited, 0);
  assert.deepEqual(Object.keys(store.receipts(review_id)), ["1.0"]);
  new Hoop(store).review(review_id, { verdict: "comment", reviewer: "bo", comments: [], summary: "More." });
  const f = spawnSync(process.execPath, [...hoopArgs, "feedback", review_id, "--json"], { encoding: "utf8", env });
  assert.equal(f.status, 0, f.stderr);
  assert.deepEqual(Object.keys(store.receipts(review_id)), ["1.0", "1.1"]);
});

test("the pages' own reads record no receipt, and the view and history carry the receipts", () =>
  withServer(async (base, hoop) => {
    const { review_id } = reviewed(hoop);
    for (const path of ["/", `/r/${review_id}`, "/api/reviews", `/api/reviews/${review_id}`, `/api/reviews/${review_id}/receipts`])
      assert.equal((await fetch(base + path)).status, 200, path);
    assert.equal(existsSync(receiptsFile(hoop, review_id)), false, "the page read the feedback, but the agent didn't");
    let view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
    assert.deepEqual(view.receipts, {});
    assert.equal(view.trail.at(-1).review, "1.0", "the history names the review its event belongs to");
    hoop.receive(review_id);
    view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
    assert.deepEqual(Object.keys(view.receipts), ["1.0"]);
    const { receipts } = await (await fetch(`${base}/api/reviews/${review_id}/receipts`)).json();
    assert.deepEqual(receipts, view.receipts);
  }));

test("the page says a review is not read yet, then when Claude read it, without a reload", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = reviewed(hoop);
    await page.addInitScript(() => {
      (window as unknown as { HOOP_RECEIPTS_MS: number }).HOOP_RECEIPTS_MS = 200;
    });
    await page.goto(`${base}/r/${review_id}`);
    const top = page.locator(".latest-receipt");
    await top.waitFor();
    assert.equal(await top.innerText(), "Latest review: Not read yet");
    await page.locator(".trail summary").click();
    assert.equal(await page.locator(".trail-list .receipt").innerText(), "Not read yet");
    await page.evaluate(() => ((window as unknown as { loaded: boolean }).loaded = true));
    new Hoop(hoop.store, null).receive(review_id);
    const at = new Date(hoop.store.receipts(review_id)["1.0"]!.at);
    const time = await page.evaluate((iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), at.toISOString());
    await page.getByText(`Latest review: Claude read this at ${time}`).waitFor({ timeout: 5000 });
    assert.equal(await page.locator(".trail-list .receipt").innerText(), `Claude read this at ${time}`);
    assert.equal(await page.evaluate(() => (window as unknown as { loaded?: boolean }).loaded), true, "the page wasn't reloaded");
  }),
);

/** A receipt's time as the page writes it. */
const clock = (page: Page, iso: string) => page.evaluate((at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), iso);

/**
 * A review page whose agent waits in another process, as hoop_wait does in Claude's session, and
 * reads nothing during the test. The reviewer has commented on a line and chosen Request changes in
 * Finish your review. The agent and receipts polls run once a minute, unless `receiptsMs` is given.
 */
async function waitingPage(hoop: Hoop, base: string, page: Page, receiptsMs = 60_000) {
  const { review_id, cursor } = hoop.submit(
    parseMarkdown("# Queue the exports\n\nLarge exports stop timing out.\n\n## Steps\n\nPut each export on the queue.\n"),
  );
  const ac = new AbortController();
  const wait = waitForReview(new Hoop(hoop.store), review_id, { after: cursor, signal: ac.signal, intervalMs: 60_000 }).catch(() => undefined);
  await page.addInitScript((ms) => {
    const w = window as unknown as { HOOP_RECEIPTS_MS: number; HOOP_AGENT_MS: number };
    w.HOOP_RECEIPTS_MS = ms;
    w.HOOP_AGENT_MS = 60_000;
  }, receiptsMs);
  await page.goto(`${base}/r/${review_id}`);
  await page.getByText("Claude is waiting for your review").waitFor();
  await page.getByRole("button", { name: /"Steps" line 1$/ }).click();
  await page.locator("#cbody").fill("Say which queue.");
  await page.locator("#addComment").click();
  await page.locator("#finishBtn").click();
  await page.getByRole("radio", { name: /Request changes/ }).check();
  return { review_id, stop: () => (ac.abort(), wait) };
}

test("after a submit the header says at once that the review went to Claude, from the submit's answer", { skip: BROWSER_SKIP }, () =>
  withBrowser(
    async ({ hoop, base, page }) => {
      const { review_id, stop } = await waitingPage(hoop, base, page);
      const posted = page.waitForResponse((r) => r.url().endsWith(`/api/reviews/${review_id}/feedback`));
      await page.locator("#submitReview").click();
      const res = await posted;
      const asked: string[] = [];
      page.on("request", (r) => asked.push(r.url()));
      const time = await clock(page, (await res.json()).delivery.at);
      // Far sooner than any poll.
      const quick = { timeout: 2000 };
      await page.locator('.top [data-status="changes_requested"]').waitFor(quick);
      await page.getByText(`Latest review: Sent to Claude at ${time}, not read yet`).waitFor(quick);
      assert.equal(await page.locator('.top [data-status="awaiting_review"]').count(), 0);
      assert.equal(await page.locator(".agent-state").isHidden(), true, "the header no longer says Claude waits for the review");
      assert.deepEqual(
        asked.filter((u) => u.includes("/api/reviews")),
        [],
        "the page asked the server nothing after the submit",
      );
      await stop();
    },
    new Hoop(new Store(tempHome())),
    { sessions: () => [] },
  ),
);

test("once Claude reads a sent review, the header says when, and what Claude does now", { skip: BROWSER_SKIP }, () =>
  withBrowser(
    async ({ hoop, base, page }) => {
      const { review_id, stop } = await waitingPage(hoop, base, page, 200);
      await page.locator("#submitReview").click();
      await page.getByText(/^Latest review: Sent to Claude at .+, not read yet$/).waitFor();
      await stop();
      new Hoop(hoop.store, null).receive(review_id);
      const time = await clock(page, hoop.store.receipts(review_id)["1.0"]!.at);
      await page.getByText(`Latest review: Claude read this at ${time}`).waitFor({ timeout: 5000 });
      // The wait is over and the session doesn't run: the agent line says so without its own poll.
      await page.getByText("Claude's session has ended. Resume it with").waitFor({ timeout: 5000 });
    },
    new Hoop(new Store(tempHome())),
    { sessions: () => [] },
  ),
);
