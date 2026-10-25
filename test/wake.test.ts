import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { isWaiting, WAIT_GRACE_MS, waitForReview } from "../src/wait.js";
import { answerMessage, deliverAction, deliverReview, wakeMessage } from "../src/wake.js";
import { createWebServer, type PagesOptions } from "../src/web.js";
import type { ClaudeSession } from "../src/work.js";
import { BROWSER_SKIP, example, TEST_SESSION, tempHome, withBrowser, pagesFor, hoopArgs } from "./helpers.js";

const TITLE = "Order export: requirements";
const op = (name: string) => OPS.find((o) => o.name === name)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const comment = { verdict: "changes_requested", comments: [{ item: "FR-3", line: 1, body: "Inclusive?" }] };

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
      assert.equal(msg.message.content, `ana reviewed "${TITLE}" in hoop: changes requested, 1 comment. Read it with hoop_feedback ${review_id} and respond.`);
      // The outcome is kept on the review, keyed like its receipt, and the page reads it.
      assert.equal(hoop.store.deliveries(review_id)["1.0"]!.outcome, "sent");
      const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
      assert.equal(view.deliveries["1.0"].outcome, "sent");

      // An approval says to go on.
      const resolved_threads = [`th_${review_id.slice(3)}_1`];
      await postJson(`${base}/api/reviews/${review_id}/feedback`, { verdict: "approved", reviewer: "ana", comments: [], resolved_threads });
      for (let i = 0; i < 50 && sock.lines.length < 2; i++) await sleep(20);
      assert.equal(
        JSON.parse(sock.lines[1]!).message.content,
        `ana reviewed "${TITLE}" in hoop: approved, 0 comments. Read it with hoop_feedback ${review_id} then go on.`,
      );

      // #224: a comment after approval reopens the review and wakes the session as any review does.
      await postJson(`${base}/api/reviews/${review_id}/feedback`, { ...comment, reviewer: "ana" });
      for (let i = 0; i < 50 && sock.lines.length < 3; i++) await sleep(20);
      assert.equal(
        JSON.parse(sock.lines[2]!).message.content,
        `ana reviewed "${TITLE}" in hoop: changes requested after approval, 1 comment. Read it with hoop_feedback ${review_id} and respond.`,
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
    const waiting = waitForReview(new Hoop(hoop.store), review_id, { after: cursor, timeoutMs: 30_000, intervalMs: 50 });
    for (const end = Date.now() + 30_000; !isWaiting(hoop.store.home, review_id) && Date.now() < end; ) await sleep(20);
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

  // The command sends its wait's mark to the pages process, and its link names that process's port.
  const pages = await pagesFor(hoop.store.home);
  const child = spawn(process.execPath, [...hoopArgs, "wait", review_id, "--timeout", "1"], { env: { ...process.env, ...pages } });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  assert.equal(code, 3);
  const link = `http://localhost:${pages.HOOP_PORT}/r/${review_id}`;
  assert.match(err, new RegExp(`^hoop: Waiting for your review of "${TITLE}" at ${link.replace(/[.]/g, "\\.")}\\n`));
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
    hoop.review(review_id, {
      verdict: "approved",
      reviewer: "ana",
      comments: [],
      resolved_threads: (hoop.threads(review_id).threads ?? []).map((t) => t.thread),
    });
    assert.equal(await unread(), true, "the latest review counts");
    assert.equal(await agent(), null, "an approved review waits on nobody");
  });
});

/** A time as Claude Code writes `procStart`: `ps -o lstart` in UTC, such as "Fri Oct 23 17:11:53 2026". */
function lstart(ms: number): string {
  const d = new Date(ms);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${day} ${month} ${String(d.getUTCDate()).padStart(2, " ")} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`;
}

/**
 * This test process as a Claude Code session in the temp `HOOP_CLAUDE_DIR`: its
 * `sessions/<pid>.json` as 2.1.310 writes it. `/clear` rewrites the same file with a new
 * `sessionId`; `pid`, `procStart` and `startedAt` stay.
 */
function claudeProcess() {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.json`);
  const procStart = lstart(Date.now() - process.uptime() * 1000);
  const write = (sessionId: string, extra: object = {}) =>
    writeFileSync(
      file,
      JSON.stringify({
        pid: process.pid,
        sessionId,
        cwd: "/tmp/proj",
        startedAt: 1792839161891,
        procStart,
        version: "2.1.310",
        peerProtocol: 1,
        kind: "interactive",
        entrypoint: "cli",
        pidDomain: "darwin",
        name: "proj-08",
        nameSource: "derived",
        status: "busy",
        updatedAt: 1792852677114,
        ...extra,
      }),
    );
  return { procStart, write, remove: () => rmSync(file, { force: true }) };
}

const CLEARED = "a344f2e4-455b-4293-bb0f-0203b0b08a1d";

test("a review owned by a session that /clear gave a new ID reads as idle, wakes the new ID, and shows it in the header (#221)", async () => {
  const claude = claudeProcess();
  const sock = await fakeSocket();
  try {
    claude.write(TEST_SESSION);
    await withServer({}, async (base, hoop) => {
      const { review_id } = hoop.submit(example());
      assert.deepEqual(hoop.store.meta(review_id).owner!.process, { pid: process.pid, start: claude.procStart }, "the owner records the process it runs in");
      const agent = async () => (await (await fetch(`${base}/api/reviews/${review_id}/agent`)).json()).agent;
      assert.deepEqual(await agent(), { state: "busy", session: TEST_SESSION, wakes: false });

      // /clear: the same process now runs a new session ID.
      claude.write(CLEARED, { status: "idle", messagingSocketPath: sock.path });
      assert.deepEqual(await agent(), { state: "idle", session: CLEARED, wakes: true });
      const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
      assert.equal(view.session.id, CLEARED, "the header names the session the process runs now");
      const res = await postJson(`${base}/api/reviews/${review_id}/feedback`, { ...comment, reviewer: "ana" });
      assert.equal(res.body.delivery.outcome, "sent");
      for (let i = 0; i < 50 && !sock.lines.length; i++) await sleep(20);
      assert.equal(
        JSON.parse(sock.lines[0]!).message.content,
        `ana reviewed "${TITLE}" in hoop: changes requested, 1 comment. Read it with hoop_feedback ${review_id} and respond. ` +
          "This review was started by an earlier conversation in this terminal (before /clear): read the document with hoop_export first.",
        "the new conversation hears that it didn't write the document",
      );

      // The same process ID started at another time is another process, which isn't followed.
      claude.write(CLEARED, { procStart: "Sat Oct 24 09:00:00 2026" });
      assert.deepEqual(await agent(), { state: "ended", session: TEST_SESSION });
    });
  } finally {
    sock.close();
    claude.remove();
  }
});

test("a closed action item tells the session after /clear that an earlier conversation added it (#221)", async () => {
  const sent: string[] = [];
  const owner = { session: TEST_SESSION, process: { pid: 7, start: "Fri Oct 23 17:11:53 2026" } };
  const item = { id: "ac_1", title: "Merge the export PR", description: "", done_when: { kind: "manual" }, owner, created: "", state: "done" } as never;
  const sessions = () => [{ session: CLEARED, pid: 7, start: "Fri Oct 23 17:11:53 2026", socket: "/fake" }];
  assert.equal((await deliverAction(item, { sessions, send: async (_s, t) => void sent.push(t) }))?.outcome, "sent");
  assert.deepEqual(sent, ["Done: Merge the export PR This action item was added by an earlier conversation in this terminal (before /clear)."]);
});

test("after /clear, the session in the owner's process reads, revises, answers for and withdraws what it owns; another session can't (#221)", async () => {
  const claude = claudeProcess();
  try {
    claude.write(TEST_SESSION);
    await withServer({}, async (base, hoop) => {
      const { review_id } = hoop.submit(example());
      const { review_id: ask } = hoop.ask({
        questions: [{ question: "Keep the old endpoint?", options: [{ label: "Keep it", recommended: true }, { label: "Remove it" }] }],
      });
      const item = op("action").run(
        hoop,
        { title: "Merge the export PR", description: "It is green.\nMerging ships it.", done_when: { kind: "manual" } } as never,
        {
          actor: "claude",
        },
      ) as { id: string };
      hoop.review(review_id, { ...comment, reviewer: "ana" });
      const unread = async () => (await (await fetch(`${base}/api/reviews`)).json()).find((m: { id: string }) => m.id === review_id).unread;
      assert.equal(await unread(), true);

      claude.write(CLEARED);
      const after = new Hoop(hoop.store, CLEARED);
      const other = new Hoop(hoop.store, "other-session");

      // Reading the feedback counts as the owner's read, so Home's Not read yet clears.
      after.receive(review_id);
      assert.equal(await unread(), false, "the new session's read is the owner's");
      assert.deepEqual(hoop.store.receipts(review_id)["1.0"]!.sessions, [CLEARED, TEST_SESSION]);
      const { review_id: second } = hoop.submit(example());
      hoop.review(second, { ...comment, reviewer: "ana" });
      other.receive(second);
      assert.deepEqual(hoop.store.receipts(second)["1.0"]!.sessions, ["other-session"], "another session's read isn't the owner's");

      assert.throws(() => other.submit({ ...example(), review_id }, 1), /Only the session that submitted this review can revise it/);
      assert.equal(after.submit({ ...example(), review_id }, 1).revision, 2, "the session after /clear revises");
      assert.equal(hoop.store.meta(review_id).owner!.session, CLEARED, "and owns the review from then on");
      assert.equal(after.submit({ ...example(), review_id }, 2).revision, 3, "what the old ID read stays read");

      assert.throws(() => other.receiveAsk(ask), /Only the session that asked this question/);
      assert.equal(after.receiveAsk(ask).review_id, ask);
      assert.throws(() => op("action_withdraw").run(other, { id: item.id, reason: "not needed" } as never, { actor: "claude" }), /belongs to another session/);
      assert.equal(
        (op("action_withdraw").run(after, { id: item.id, reason: "not needed" } as never, { actor: "claude" }) as { state: string }).state,
        "withdrawn",
      );

      // A file left by a killed process whose ID is now reused doesn't make a session its owner.
      claude.write(CLEARED, { procStart: "Mon Jan  7 09:00:00 2019" });
      assert.throws(() => after.receiveAsk(ask), /Only the session that asked this question/);
    });
  } finally {
    claude.remove();
  }
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
      await page.getByText("Claude's session is idle; submitting wakes it").waitFor();
      const ac = new AbortController();
      const waiting = waitForReview(new Hoop(hoop.store), review_id, { after: cursor, signal: ac.signal, intervalMs: 50 }).catch(() => undefined);
      await page.getByText("Claude is waiting for your review").waitFor();
      ac.abort();
      await waiting;
      await page.getByText("Claude's session is idle; submitting wakes it").waitFor();

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

test("a person's answer to a quick question wakes the asking session with the answer, and a correction with both answers", async () => {
  const sock = await fakeSocket();
  try {
    await withServer({ sessions: () => live({ socket: sock.path }) }, async (base, hoop) => {
      const { review_id: id } = hoop.ask({
        questions: [
          { question: "Keep the old endpoint?", options: [{ label: "Keep it as an alias", recommended: true }, { label: "Remove it" }] },
          { question: "Which format?", options: [{ label: "CSV", recommended: true }, { label: "JSON" }] },
        ],
      });
      const said = async (n: number) => {
        for (let i = 0; i < 50 && sock.lines.length < n; i++) await sleep(20);
        return JSON.parse(sock.lines[n - 1]!).message.content;
      };
      await postJson(`${base}/api/reviews/${id}/answer`, { question: "Q1", choice: "A", note: "Two clients call it" });
      assert.equal(
        await said(1),
        `Answered in hoop: Keep the old endpoint? → A. Keep it as an alias. Note: "Two clients call it". Read it with hoop_feedback ${id}.`,
      );
      await postJson(`${base}/api/reviews/${id}/answer`, { recommended: true });
      assert.equal(
        await said(2),
        `Answered in hoop: Which format? → A. CSV (your recommendation, taken with Go with your recommendation). Read it with hoop_feedback ${id}.`,
      );
      hoop.receiveAsk(id);
      await postJson(`${base}/api/reviews/${id}/answer`, { question: "Q2", choice: "other", text: "Parquet" });
      assert.equal(await said(3), `Corrected in hoop: Which format? Changed: A. CSV → Other: "Parquet". Read it with hoop_feedback ${id}.`);
      // While the asking session waits, the wait takes the answer and nothing is sent.
      const waiting = op("wait").run(hoop, { review_id: id, after: hoop.askResult(id).cursor, seconds: 5 } as never, { actor: "claude" }) as Promise<unknown>;
      for (let i = 0; i < 50 && !isWaiting(hoop.store.home, id); i++) await sleep(20);
      const res = await postJson(`${base}/api/reviews/${id}/answer`, { question: "Q1", choice: "B" });
      assert.equal(res.body.delivery.outcome, "waiting");
      await waiting;
      assert.equal(sock.lines.length, 3);
    });
  } finally {
    sock.close();
  }
});

test("the answer message names each answer as the person gave it", () => {
  const doc = {
    kind: "questions",
    items: [
      {
        id: "Q1",
        title: "Ship today?",
        choices: [
          { id: "A", label: "Yes" },
          { id: "B", label: "No" },
        ],
      },
    ],
  };
  const fb = { review_id: "rv_x", answers: [{ item: "Q1", choice: "other", text: "Tomorrow" }] };
  assert.equal(answerMessage(fb as never, doc as never), 'Answered in hoop: Ship today? → Other: "Tomorrow". Read it with hoop_feedback rv_x.');
});
