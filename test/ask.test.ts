import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { Hoop, type AskResult } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { createWebServer, type PagesOptions } from "../src/web.js";
import { isWaiting } from "../src/wait.js";
import { parseMarkdown } from "../src/markdown.js";
import { BROWSER_SKIP, cli, hasFocus, mcpClient, pagesFor, TEST_SESSION, tempHome, tsx, withBrowser } from "./helpers.js";

const op = (name: string) => OPS.find((o) => o.name === name)!;
const run = (hoop: Hoop, name: string, input: Record<string, unknown>) => op(name).run(hoop, input as never, { actor: "claude" }) as Promise<unknown>;

const KEEP = {
  question: "Keep the old endpoint?",
  context: "Two clients still call it.",
  options: [{ label: "Keep it as an alias", recommended: true }, { label: "Remove it" }],
};
const FORMAT = { question: "Which format?", options: [{ label: "CSV" }, { label: "JSON", recommended: true }, { label: "Both" }] };

/** A pages server on a free port for `hoop`, with no live Claude Code session unless `opts` gives one. */
async function withServer(fn: (base: string, hoop: Hoop) => Promise<void>, opts: PagesOptions = {}, hoop = new Hoop(new Store(tempHome()))) {
  const server = createWebServer(hoop, [], { sessions: () => [], ...opts });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hoop);
  } finally {
    server.close();
  }
}

const answer = (base: string, id: string, body: unknown) =>
  fetch(`${base}/api/reviews/${id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
    async (r) => ({ status: r.status, body: await r.json() }),
  );

test("hoop_ask stores the questions as a review of kind questions and returns at once with its link and a cursor", async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const asked = (await run(hoop, "ask", { questions: [KEEP, FORMAT] })) as AskResult;
  assert.equal(asked.status, "open");
  assert.match(asked.review_id, /^rv_/);
  assert.equal(asked.url, `http://localhost:4747/r/${asked.review_id}`);
  assert.equal(asked.cursor, "1.0");
  assert.deepEqual(
    asked.questions.map((q) => [q.id, q.question, q.answer]),
    [
      ["Q1", KEEP.question, undefined],
      ["Q2", FORMAT.question, undefined],
    ],
  );
  const doc = hoop.store.revision(asked.review_id);
  assert.equal(doc.kind, "questions");
  assert.equal(doc.title, KEEP.question);
  assert.deepEqual(doc.items[0]!.choices, [
    { id: "A", label: "Keep it as an alias", recommended: true },
    { id: "B", label: "Remove it" },
  ]);
  assert.equal(doc.items[0]!.body, KEEP.context);
  assert.equal(hoop.store.meta(asked.review_id).owner?.session, TEST_SESSION);

  // Exactly one option is recommended, there are two to four options, and one to four questions.
  const refused = (questions: unknown) => assert.throws(() => hoop.ask({ questions }), /invalid questions/);
  refused([{ ...KEEP, options: KEEP.options.map((o) => ({ label: o.label })) }]);
  refused([{ ...KEEP, options: KEEP.options.map((o) => ({ ...o, recommended: true })) }]);
  refused([{ ...KEEP, options: [KEEP.options[0]] }]);
  refused([]);
  refused([KEEP, KEEP, KEEP, KEEP, KEEP]);
  // A person's terminal, outside any session, can't ask.
  assert.throws(() => new Hoop(hoop.store, null).ask({ questions: [KEEP] }), /isn't in a Claude Code session/);
});

test("an answer is saved and sent at once; a wait returns once every question is answered, or with partial on each answer", async () => {
  await withServer(async (base, hoop) => {
    const { review_id: id, cursor } = hoop.ask({ questions: [KEEP, FORMAT] });
    const waited = run(hoop, "wait", { review_id: id, after: cursor, seconds: 5 }) as Promise<AskResult>;
    const partial = run(hoop, "wait", { review_id: id, after: cursor, seconds: 5, partial: true }) as Promise<AskResult>;
    const first = await answer(base, id, { question: "Q1", choice: "B", note: "Nobody needs it" });
    assert.equal(first.status, 201);
    assert.equal(first.body.ask.state, "open");
    assert.equal(first.body.status_key, "question");

    const one = await partial;
    assert.equal(one.status, "open");
    assert.deepEqual(
      { ...one.questions[0]!.answer, at: undefined, by: undefined },
      { choice: "B", label: "Remove it", note: "Nobody needs it", at: undefined, by: undefined },
    );
    assert.equal(one.questions[1]!.answer, undefined);

    await answer(base, id, { question: "Q2", choice: "other", text: "Parquet" });
    const all = await waited;
    assert.equal(all.status, "closed", "the wait read every answer");
    assert.deepEqual(all.questions[1]!.answer?.text, "Parquet");
    // Receipts say Claude read each answer.
    const view = await (await fetch(`${base}/api/reviews/${id}`)).json();
    assert.deepEqual(Object.keys(view.receipts), ["1.0", "1.1"]);
    assert.equal(view.status_key, "answered");
  });
});

test("Go with your recommendation answers every unanswered question with the recommended option, marked as taken that way", async () => {
  await withServer(async (base, hoop) => {
    const { review_id: id } = hoop.ask({ questions: [KEEP, FORMAT] });
    await answer(base, id, { question: "Q1", choice: "B" });
    const res = await answer(base, id, { recommended: true });
    assert.equal(res.status, 201);
    const fb = hoop.store.feedback(id);
    assert.deepEqual(fb[1]!.answers, [{ item: "Q2", choice: "B", recommended: true }]);
    assert.equal(fb[1]!.verdict, "comment");
    // Nothing is left to take it for.
    assert.match((await answer(base, id, { recommended: true })).body.error, /every question already has an answer/);
    const read = hoop.receiveAsk(id);
    assert.equal(read.questions[0]!.answer?.choice, "B");
    assert.deepEqual([read.questions[1]!.answer?.choice, read.questions[1]!.answer?.recommended], ["B", true]);
  });
});

test("a changed answer replaces an unread one quietly, and after Claude read it is a correction that keeps both answers", async () => {
  const sent: string[] = [];
  const opts: PagesOptions = {
    sessions: () => [{ session: TEST_SESSION, pid: 1, status: "idle", socket: "/fake.sock" }],
    send: async (_s, text) => void sent.push(text),
  };
  await withServer(async (base, hoop) => {
    const { review_id: id } = hoop.ask({ questions: [KEEP] });
    assert.equal((await answer(base, id, { question: "Q1", choice: "B" })).body.delivery.outcome, "sent");
    // Before Claude read it: replaced quietly, with no second message.
    const quiet = await answer(base, id, { question: "Q1", choice: "A" });
    assert.equal(quiet.body.delivery, undefined);
    assert.equal(sent.length, 1);
    assert.equal(hoop.store.feedback(id)[1]!.answers[0]!.corrects, undefined);
    assert.match((await answer(base, id, { question: "Q1", choice: "A" })).body.error, /already the answer/);

    assert.equal(hoop.receiveAsk(id).status, "closed");
    const corrected = await answer(base, id, { question: "Q1", choice: "B" });
    assert.equal(corrected.body.delivery.outcome, "sent");
    assert.equal(sent.length, 2);
    assert.equal(sent[1], `Corrected in hoop: ${KEEP.question} Changed: A. Keep it as an alias → B. Remove it. Read it with hoop_feedback ${id}.`);
    const read = (await run(hoop, "feedback", { review_id: id })) as AskResult;
    assert.deepEqual(read.questions[0]!.answer?.corrects, { choice: "A", label: "Keep it as an alias" });
    // The page keeps every answer in the question's history.
    assert.deepEqual(
      corrected.body.ask.questions[0].answers.map((a: { choice: string }) => a.choice),
      ["B", "A", "B"],
    );
    // A default wait from the cursor before the correction returns it.
    const again = (await run(hoop, "wait", { review_id: id, after: "1.2", seconds: 1 })) as AskResult;
    assert.equal(again.questions[0]!.answer?.choice, "B");
  }, opts);
});

test("a withdrawn ask shows Claude's reason, takes no answers, and returns any wait at once", async () => {
  await withServer(async (base, hoop) => {
    const { review_id: id, cursor } = hoop.ask({ questions: [KEEP] });
    const waiting = run(hoop, "wait", { review_id: id, after: cursor, seconds: 5 }) as Promise<AskResult>;
    assert.throws(() => hoop.withdraw(id, " "), /one-line reason/);
    const out = (await run(hoop, "withdraw", { review_id: id, reason: "Found it in the client logs" })) as AskResult;
    assert.equal(out.status, "withdrawn");
    assert.equal(out.withdrawn?.reason, "Found it in the client logs");
    assert.equal((await waiting).status, "withdrawn");
    const refused = await answer(base, id, { question: "Q1", choice: "A" });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /withdrew this question: Found it in the client logs/);
    assert.throws(() => hoop.withdraw(id, "again"), /already withdrawn/);
    const view = await (await fetch(`${base}/api/reviews/${id}`)).json();
    assert.equal(view.status_key, "withdrawn");
    assert.equal(view.ask.withdrawn.reason, "Found it in the client logs");

    // An ask whose every question has an answer can't be withdrawn.
    const done = hoop.ask({ questions: [KEEP] }).review_id;
    await answer(base, done, { question: "Q1", choice: "A" });
    assert.throws(() => hoop.withdraw(done, "late"), /has an answer already/);
  });
});

test("an ask whose session has ended still takes answers, and the page shows the session to resume", async () => {
  await withServer(async (base, hoop) => {
    const { review_id: id } = hoop.ask({ questions: [KEEP] });
    const res = await answer(base, id, { question: "Q1", choice: "A" });
    assert.equal(res.status, 201);
    assert.equal(res.body.delivery.outcome, "no_session");
    assert.deepEqual(res.body.agent, { state: "ended", session: TEST_SESSION });
    assert.equal(hoop.receiveAsk(id).questions[0]!.answer?.label, "Keep it as an alias");
  });
});

test("only the asking session waits on, reads or withdraws an ask, and nobody but people answer it", async () => {
  await withServer(async (base, hoop) => {
    const { review_id: id } = hoop.ask({ questions: [KEEP] });
    const other = new Hoop(hoop.store, "other-session-3333");
    const refusal = /Only the session that asked this question/;
    await assert.rejects(run(other, "wait", { review_id: id, seconds: 1 }), refusal);
    await assert.rejects(async () => run(other, "feedback", { review_id: id }), refusal);
    assert.throws(() => other.withdraw(id, "mine now"), refusal);
    // An agent's comment isn't an answer, and the review routes refuse it.
    assert.throws(() => other.comment(id, { item: "Q1", line: 1, body: "A" }), /quick question/);
    // A quick question is never revised, approved or given a request for changes.
    assert.throws(() => hoop.submit({ ...parseMarkdown("# Other\n\nText.\n"), review_id: id }), /can't be revised/);
    for (const verdict of ["approved", "changes_requested"]) {
      const res = await fetch(`${base}/api/reviews/${id}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict, answers: [{ item: "Q1", choice: "A" }] }),
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /never approved/);
    }
    assert.equal(hoop.store.meta(id).status, "open");
    // A review isn't a quick question to answer.
    const review = hoop.submit(parseMarkdown("# Plan\n\nText.\n")).review_id;
    assert.match((await answer(base, review, { question: "Q1", choice: "A" })).body.error, /not a quick question/);
    // Writes need JSON from this machine's pages, as for reviews.
    const form = await fetch(`${base}/api/reviews/${id}/answer`, { method: "POST", body: "question=Q1&choice=A" });
    assert.equal(form.status, 415);
    const foreign = await fetch(`${base}/api/reviews/${id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ question: "Q1", choice: "A" }),
    });
    assert.equal(foreign.status, 403);
    assert.equal(hoop.store.feedback(id).length, 0);
  });
});

test("Home lists an open ask under its session with a Question label and the unanswered count, and an answered one as Answered", async () => {
  await withServer(async (base, hoop) => {
    const { review_id: id } = hoop.ask({ questions: [KEEP, FORMAT] });
    const row = async () => (await (await fetch(`${base}/api/reviews`)).json()).find((m: { id: string }) => m.id === id);
    assert.deepEqual([(await row()).status_key, (await row()).ask], ["question", { state: "open", questions: 2, unanswered: 2 }]);
    assert.equal((await row()).session.id, TEST_SESSION);
    await answer(base, id, { recommended: true });
    assert.deepEqual([(await row()).status_key, (await row()).ask.state, (await row()).unread], ["answered", "answered", true]);
  });
});

test("`hoop ask` asks from a terminal in a session, with a trailing * marking the recommended option", async () => {
  // The command sends its write to a pages process, the only writer.
  const home = tempHome();
  const pages = await pagesFor(home);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [tsx, cli, "ask", "Keep", "the", "old", "endpoint?", "--option", "Keep it*", "--option", "Remove it", "--context", "Two clients call it.", "--json"],
    { env: { ...process.env, ...pages } },
  );
  const out = JSON.parse(stdout) as AskResult;
  const doc = new Store(home, { readOnly: true }).revision(out.review_id);
  assert.equal(doc.title, "Keep the old endpoint?");
  assert.deepEqual(doc.items[0]!.choices, [
    { id: "A", label: "Keep it", recommended: true },
    { id: "B", label: "Remove it" },
  ]);
  assert.equal(doc.items[0]!.body, "Two clients call it.");
});

test(
  "on the ask page, 1 to 4 answer the focused question, Enter in Other sends it, and Go with your recommendation takes the rest",
  { skip: BROWSER_SKIP },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const { review_id: id } = hoop.ask({ questions: [KEEP, FORMAT, { ...FORMAT, question: "Which encoding?" }] });
      await page.goto(`${base}/r/${id}`);
      // A note typed under another question survives the redraw after an answer.
      await page.locator("#note-Q3").fill("Ask the data team");
      await page.locator('[data-q="Q1"][data-choice="A"]').focus();
      await page.keyboard.press("2");
      await page.locator('[data-q="Q1"][data-choice="B"][aria-pressed="true"]').waitFor();
      assert.ok(await hasFocus(page.locator('[data-q="Q1"][data-choice="B"]')), "focus stays on the answer");
      assert.equal(await page.locator("#note-Q3").inputValue(), "Ask the data team");
      await page.locator(".ask-status", { hasText: "no live Claude session" }).waitFor();
      // Other opens a text box; Enter sends it.
      await page.locator('[data-q="Q2"][data-other]').click();
      await page.locator("#other-Q2").fill("Parquet");
      await page.keyboard.press("Enter");
      await page.locator('[data-q="Q2"][data-other][aria-pressed="true"]').waitFor();
      await page.locator(".ask-q", { hasText: "Other: “Parquet”" }).waitFor();
      await page.locator("#goRec").click();
      await page.locator('[data-q="Q3"][data-choice="B"][aria-pressed="true"]').waitFor();
      await page.locator(".ask-q", { hasText: "taken with Go with your recommendation" }).waitFor();
      assert.equal(await page.locator("#goRec").count(), 0);
      assert.deepEqual(
        hoop.receiveAsk(id).questions.map((q) => [q.answer?.choice, q.answer?.text, q.answer?.recommended]),
        [
          ["B", undefined, undefined],
          ["other", "Parquet", undefined],
          ["B", undefined, true],
        ],
      );
      // Once Claude read it, the page says so.
      await page.reload();
      await page.locator(".ask-q .receipt", { hasText: "read this at" }).first().waitFor();
      // A withdrawn ask's options are disabled.
      const gone = hoop.ask({ questions: [KEEP] }).review_id;
      hoop.withdraw(gone, "No longer needed");
      await page.goto(`${base}/r/${gone}`);
      await page.locator(".decided", { hasText: "No longer needed" }).waitFor();
      assert.ok(await page.locator('[data-q="Q1"][data-choice="A"]').isDisabled());
    }),
);

test("over MCP a session asks, waits and withdraws through the pages process, which records the answers it read", async () => {
  const home = tempHome();
  const pages = await pagesFor(home);
  const mcp = await mcpClient(pages);
  const base = `http://127.0.0.1:${pages.HOOP_PORT}`;
  try {
    const asked = (await mcp.call("hoop_ask", { questions: [KEEP] })).value as AskResult;
    const waited = mcp.call("hoop_wait", { review_id: asked.review_id, after: asked.cursor, seconds: 20 });
    // The wait's mark shows before the answer, so the answer goes to the wait, not the session.
    for (let i = 0; i < 100 && !isWaiting(home, asked.review_id); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await answer(base, asked.review_id, { question: "Q1", choice: "B" })).body.delivery.outcome, "waiting");
    const got = (await waited).value as AskResult;
    assert.equal(got.status, "closed");
    assert.equal(got.questions[0]!.answer?.label, "Remove it");
    assert.deepEqual(Object.keys(new Store(home, { readOnly: true }).receipts(asked.review_id)), ["1.0"]);

    const other = (await mcp.call("hoop_ask", { questions: [KEEP] })).value as AskResult;
    const withdrawn = await mcp.call("hoop_withdraw", { review_id: other.review_id, reason: "Not needed" });
    assert.equal(withdrawn.isError, false);
    assert.equal((withdrawn.value as AskResult).status, "withdrawn");
  } finally {
    await mcp.close();
  }
});
