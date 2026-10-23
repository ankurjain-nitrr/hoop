import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { isWaiting, WAIT_GRACE_MS, waitForReview } from "../src/wait.js";
import { deliverReview, wakeMessage } from "../src/wake.js";
import { createWebServer, type PagesOptions } from "../src/web.js";
import type { ClaudeSession } from "../src/work.js";
import { BROWSER_SKIP, cli, example, TEST_SESSION, tempHome, tsx, withBrowser } from "./helpers.js";

const TITLE = "Order export: requirements";
const op = (name: string) => OPS.find((o) => o.name === name)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const comment = { verdict: "comment", comments: [{ item: "FR-3", line: 1, body: "Inclusive?" }] };

/** A pages server on a free port, with a stand-in for the Claude Code sessions and the sender. */
async function withServer(opts: PagesOptions, fn: (base: string, hoop: Hoop) => Promise<void>, hoop = new Hoop(new Store(tempHome()))) {
  const server = createWebServer(hoop, [], opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hoop);
  } finally {
    server.close();
  }
}

const postJson = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

/** A fake session socket that collects the lines written to it. */
async function fakeSocket() {
  const path = join(mkdtempSync(join(tmpdir(), "hw-")), "s.sock");
  const lines: string[] = [];
  const server = createSocketServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, lines, close: () => server.close() };
}

const live = (extra: Partial<ClaudeSession> = {}): ClaudeSession[] => [{ session: TEST_SESSION, pid: 1, status: "idle", ...extra }];

test("a person's review from the page reaches the owner's live session as one message over its socket", async () => {
  const sock = await fakeSocket();
  try {
    await withServer({ sessions: () => live({ socket: sock.path }) }, async (base, hoop) => {
      const { review_id } = hoop.submit(example());
      const res = await postJson(`${base}/api/reviews/${review_id}/feedback`, { ...comment, reviewer: "ana" });
      assert.equal(res.status, 201);
      assert.equal(res.body.delivery.outcome, "sent");
      for (let i = 0; i < 50 && !sock.lines.length; i++) await sleep(20);
      assert.equal(sock.lines.length, 1);
      const msg = JSON.parse(sock.lines[0]!);
      assert.equal(msg.type, "user");
      assert.equal(msg.message.content, `ana reviewed "${TITLE}" in hoop: commented, 1 comment. Read it with hoop_feedback ${review_id} and respond.`);
      // The outcome is kept on the review, keyed like its receipt, and the page reads it.
      assert.equal(hoop.store.deliveries(review_id)["1.0"]!.outcome, "sent");
      const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
      assert.equal(view.deliveries["1.0"].outcome, "sent");

      // An approval says to go on.
      await postJson(`${base}/api/reviews/${review_id}/feedback`, { verdict: "approved", reviewer: "ana", comments: [] });
      for (let i = 0; i < 50 && sock.lines.length < 2; i++) await sleep(20);
      assert.equal(
        JSON.parse(sock.lines[1]!).message.content,
        `ana reviewed "${TITLE}" in hoop: approved, 0 comments. Read it with hoop_feedback ${review_id} then go on.`,
      );
    });
  } finally {
    sock.close();
  }
});

test("a review with no live session, or whose socket fails, is recorded as such, and nothing goes to a session that takes no messages", async () => {
  const sent: string[] = [];
  const send = async (_s: string, t: string) => void sent.push(t);
  for (const [sessions, outcome] of [
    [() => [], "no_session"],
    [() => live(), "no_session"],
    [() => live({ socket: join(mkdtempSync(join(tmpdir(), "hw-")), "missing.sock") }), "failed"],
  ] as const) {
    await withServer({ sessions, ...(outcome === "failed" ? {} : { send }) }, async (base, hoop) => {
      const { review_id } = hoop.submit(example());
      const res = await postJson(`${base}/api/reviews/${review_id}/feedback`, { ...comment, reviewer: "ana" });
      assert.equal(res.body.delivery.outcome, outcome);
      if (outcome === "failed") assert.ok(res.body.delivery.error);
      assert.equal(hoop.store.deliveries(review_id)["1.0"]!.outcome, outcome);
    });
  }
  assert.deepEqual(sent, []);
});

test("nothing is sent while the agent waits for the review, nor for an agent's own reply or comment", async () => {
  const sent: string[] = [];
  const send = async (_s: string, t: string) => void sent.push(t);
  await withServer({ sessions: () => live({ socket: "/fake" }), send }, async (base, hoop) => {
    const { review_id, cursor } = hoop.submit(example());
    // The agent waits: the wait takes the review, so no message goes.
    const waiting = waitForReview(new Hoop(hoop.store), review_id, { after: cursor, timeoutMs: 10_000, intervalMs: 50 });
    await sleep(100);
    assert.equal(isWaiting(hoop.store.home, review_id), true);
    const res = await postJson(`${base}/api/reviews/${review_id}/feedback`, { ...comment, reviewer: "ana" });
    assert.equal(res.body.delivery.outcome, "waiting");
    assert.equal((await waiting)?.status, "reviewed");
    assert.equal(isWaiting(hoop.store.home, review_id), false, "a wait that got its review counts no longer");

    // The owner's reply and another session's comment are no person's review.
    const thread = hoop.store.feedback(review_id).at(-1)!.comments[0]!.thread!;
    hoop.reply(thread, "Yes, inclusive.");
    const other = new Hoop(hoop.store, "other-session-1234");
    const fb = other.comment(review_id, { item: "FR-3", line: 1, body: "Agreed." });
    assert.equal(await deliverReview(hoop.store, fb, { sessions: () => live({ socket: "/fake" }), send }), undefined);
    assert.deepEqual(Object.keys(hoop.store.deliveries(review_id)), ["1.0"]);
  });
  assert.deepEqual(sent, []);
  assert.match(wakeMessage({ ...comment, reviewer: "bo", review_id: "rv_x", verdict: "changes_requested" } as never, "T"), /: changes requested, 1 comment\./);
});

test("a wait shows as running while it runs and for a grace after it times out, and not after its process is gone", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id, cursor } = hoop.submit(example());
  assert.equal(isWaiting(hoop.store.home, review_id), false);
  const waiting = waitForReview(hoop, review_id, { after: cursor, timeoutMs: 300, intervalMs: 50 });
  await sleep(100);
  assert.equal(isWaiting(hoop.store.home, review_id), true);
  assert.equal(await waiting, undefined);
  assert.equal(isWaiting(hoop.store.home, review_id), true, "the agent is about to call again");
  assert.equal(isWaiting(hoop.store.home, review_id, Date.now() + WAIT_GRACE_MS + 1000), false);
  // A mark left by a process that is gone counts for nothing.
  const dir = join(hoop.store.home, "waits");
  writeFileSync(join(dir, `${review_id}.999999.json`), JSON.stringify({ pid: 999_999, started: new Date().toISOString() }));
  assert.equal(isWaiting(hoop.store.home, review_id, Date.now() + WAIT_GRACE_MS + 1000), false);
  // A wait with an ID that names no review writes nothing.
  await assert.rejects(waitForReview(hoop, "../../x", { after: "1.0", timeoutMs: 10 }));
  assert.ok(readdirSync(dir).every((n) => n.startsWith(review_id)));
});

test("a pending hoop_wait says what it waits for and where, and so does `hoop wait`", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id, cursor, url } = hoop.submit(example());
  const pending = (await op("wait").run(hoop, { review_id, after: cursor, seconds: 1 }, { actor: "claude" })) as { message: string; url: string };
  assert.equal(pending.url, url);
  assert.equal(pending.message, `Waiting for your review of "${TITLE}" at ${url}. No review yet. Call hoop_wait again with after: "1.0".`);

  const child = spawn(process.execPath, [tsx, cli, "wait", review_id, "--timeout", "1"], { env: { ...process.env, HOOP_HOME: hoop.store.home } });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  assert.equal(code, 3);
  assert.match(err, new RegExp(`^hoop: Waiting for your review of "${TITLE}" at ${url.replace(/[.]/g, "\\.")}\\n`));
});

test("the review page's agent state: waiting, idle, busy or ended, and Home's unread flag", async () => {
  let sessions: ClaudeSession[] = [];
  await withServer({ sessions: () => sessions }, async (base, hoop) => {
    const { review_id, cursor } = hoop.submit(example());
    const agent = async () => (await (await fetch(`${base}/api/reviews/${review_id}/agent`)).json()).agent;
    const unread = async () => (await (await fetch(`${base}/api/reviews`)).json()).find((m: { id: string }) => m.id === review_id).unread;
    assert.deepEqual(await agent(), { state: "ended", session: TEST_SESSION });
    sessions = live({ socket: "/fake" });
    assert.deepEqual(await agent(), { state: "idle", session: TEST_SESSION, wakes: true });
    sessions = live({ status: "busy" });
    assert.deepEqual(await agent(), { state: "busy", session: TEST_SESSION, wakes: false });
    assert.equal(await unread(), false, "no review yet");

    const ac = new AbortController();
    const waiting = waitForReview(new Hoop(hoop.store), review_id, { after: cursor, signal: ac.signal, intervalMs: 50 }).catch(() => undefined);
    await sleep(100);
    assert.deepEqual(await agent(), { state: "waiting" });
    ac.abort();
    await waiting;
    assert.equal((await agent()).state, "busy", "a cancelled wait counts no longer");

    hoop.review(review_id, { ...comment, reviewer: "ana" });
    assert.equal(await unread(), true);
    hoop.receive(review_id);
    assert.equal(await unread(), false);
    hoop.review(review_id, { verdict: "approved", reviewer: "ana", comments: [] });
    assert.equal(await unread(), true, "the latest review counts");
    assert.equal(await agent(), null, "an approved review waits on nobody");
  });
});

test("the page shows the agent's state as it changes, the resume command to copy, and the toast says the review was delivered", {
  skip: BROWSER_SKIP,
}, async () => {
  let sessions: ClaudeSession[] = [];
  const sent: string[] = [];
  await withBrowser(
    async ({ hoop, base, page }) => {
      const { review_id, cursor } = hoop.submit(example());
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
      await page.addInitScript(() => {
        (window as unknown as { HOOP_AGENT_MS: number }).HOOP_AGENT_MS = 150;
      });
      await page.goto(`${base}/r/${review_id}`);
      const line = page.locator(".agent-state");
      await line.waitFor();
      assert.equal(await line.locator("span").innerText(), "Claude's session has ended. Resume it with");
      assert.equal(await line.locator("code").innerText(), `claude --resume ${TEST_SESSION}`);
      await line.getByRole("button", { name: `Copy the command claude --resume ${TEST_SESSION}` }).click();
      await line.getByText("Copied").waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `claude --resume ${TEST_SESSION}`);

      sessions = live({ socket: "/fake" });
      await page.getByText("Claude's session is idle; submitting wakes it").waitFor({ timeout: 5000 });
      const ac = new AbortController();
      const waiting = waitForReview(new Hoop(hoop.store), review_id, { after: cursor, signal: ac.signal, intervalMs: 50 }).catch(() => undefined);
      await page.getByText("Claude is waiting for your review").waitFor({ timeout: 5000 });
      ac.abort();
      await waiting;
      await page.getByText("Claude's session is idle; submitting wakes it").waitFor({ timeout: 5000 });

      await page.locator("#looksGood").click();
      await page.getByText(/Review submitted: Approved\. .*Sent to Claude's session, which reads it now\./).waitFor();
      assert.equal(sent.length, 1);
      assert.match(sent[0]!, /reviewed ".*" in hoop: approved/);
      assert.equal(await line.isHidden(), true, "an approved review shows no agent state");
    },
    new Hoop(new Store(tempHome())),
    { sessions: () => sessions, send: async (_s, t) => void sent.push(t) },
  );
});

test("Home marks a review whose latest review Claude hasn't read with Not read yet", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(example());
    const other = hoop.submit({ ...example(), title: "Read already" }).review_id;
    hoop.review(review_id, { ...comment, reviewer: "ana" });
    hoop.review(other, { ...comment, reviewer: "ana" });
    hoop.receive(other);
    await page.goto(base);
    const row = page.locator(`.list a[href="/r/${review_id}"]`);
    await row.waitFor();
    assert.equal(await row.locator('[data-status="unread"]').innerText(), "Not read yet");
    assert.equal(await page.locator(`.list a[href="/r/${other}"] [data-status="unread"]`).count(), 0);
  }),
);
