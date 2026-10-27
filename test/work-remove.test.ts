import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { readStamps, stampHook } from "../src/hook-health.js";
import { Hoop } from "../src/hoop.js";
import { addChanges } from "../src/steer.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { type ClaudeSession, readWork, workHook } from "../src/work.js";
import { BROWSER_SKIP, hasFocus, tempHome, withBrowser } from "./helpers.js";

// The person removes hoop's own record of an ended session from the Work page (#314).
const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const ENDED = "eeeeeeee-1111-2222-3333-444444444444";
const OTHER = "ffffffff-1111-2222-3333-444444444444";
const BUSY = "bbbbbbbb-1111-2222-3333-444444444444";
const IDLE = "cccccccc-1111-2222-3333-444444444444";

/** An hour ago, when the seeded sessions last did anything. */
const HOUR_AGO = new Date(Date.now() - 3600_000);

/**
 * A session with two todos and a subagent, a waiting comment (so gate files) and hook stamps, all an
 * hour old, as is its transcript. `at` makes them recent instead.
 */
function seed(home: string, session: string, transcript: string, at = HOUR_AGO.toISOString()) {
  const base = { ...HOOKS["post-taskcreate"], session_id: session, transcript_path: transcript };
  for (const [id, subject] of [
    ["1", "Read the code"],
    ["2", "Write the fix"],
  ]) {
    const input = { ...base, tool_input: { subject }, tool_response: { task: { id, subject } } };
    workHook(home, input, at);
    stampHook(home, input, at);
  }
  workHook(home, { ...HOOKS["pre-agent"], session_id: session, transcript_path: transcript }, at);
  workHook(home, { ...HOOKS["subagent-start"], session_id: session, transcript_path: transcript }, at);
  addChanges(home, session, [{ kind: "comment", todo: "1", text: "Mind the old rows" }], { by: "owner", reachable: false, now: at });
  utimesSync(transcript, new Date(at), new Date(at));
}

const json = { "content-type": "application/json" };
const removeAt = (base: string, s: string) => fetch(`${base}/api/work/${s}/remove`, { method: "POST", headers: json, body: "{}" });

const files = (home: string, session: string) =>
  [...readdirSync(join(home, "work")), ...readdirSync(join(home, "hooks"))].filter((n) => n.startsWith(session)).sort();

async function serve(home: string, sessions: () => ClaudeSession[]) {
  const server = createWebServer(new Hoop(new Store(home)), [], { sessions });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("removing an ended session deletes hoop's record, gate files and stamps, keeps the transcript, and refuses a running one", async () => {
  const home = tempHome();
  const transcript = join(home, "transcript.jsonl");
  const text = `${JSON.stringify({ type: "user", message: { content: "Fix it" } })}\n`;
  writeFileSync(transcript, text);
  for (const s of [ENDED, BUSY, IDLE]) seed(home, s, transcript);
  assert.ok(files(home, ENDED).includes(`${ENDED}.gate`), "the waiting comment wrote a gate file");
  const { server, base } = await serve(home, () => [
    { session: BUSY, pid: 1, status: "busy" },
    { session: IDLE, pid: 2, status: "idle" },
  ]);
  const remove = (s: string, headers: Record<string, string> = json) => fetch(`${base}/api/work/${s}/remove`, { method: "POST", headers, body: "{}" });
  try {
    // Another site's page and a non-JSON write are refused, and change nothing.
    assert.equal((await remove(ENDED, { ...json, origin: "https://evil.example" })).status, 403);
    assert.equal((await remove(ENDED, { "content-type": "text/plain" })).status, 415);
    assert.ok(readWork(home, ENDED));

    // A running session, busy or idle, is refused.
    for (const s of [BUSY, IDLE]) {
      const res = await remove(s);
      assert.equal(res.status, 409);
      assert.match((await res.json()).error, /still running/);
      assert.ok(readWork(home, s), "a running session keeps its record");
    }

    const ok = await remove(ENDED, { ...json, origin: base });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { removed: ENDED });
    assert.deepEqual(files(home, ENDED), [], "the record, its gate files and its stamps are gone");
    assert.equal(readFileSync(transcript, "utf8"), text, "Claude Code's transcript is untouched");
    const ids = ((await (await fetch(`${base}/api/work`)).json()).sessions as { id: string }[]).map((s) => s.id);
    assert.deepEqual(ids.sort(), [BUSY, IDLE].sort());
    assert.equal((await remove(ENDED)).status, 404, "a removed session has no record");

    // The session resumed: its next todo call starts a fresh record.
    workHook(home, {
      ...HOOKS["post-taskcreate"],
      session_id: ENDED,
      tool_input: { subject: "Again" },
      tool_response: { task: { id: "3", subject: "Again" } },
    });
    const fresh = readWork(home, ENDED)!;
    assert.deepEqual(
      fresh.todos.map((t) => t.text),
      ["Again"],
    );
    assert.equal(fresh.changes, undefined, "nothing of the old record comes back");
    assert.deepEqual(readStamps(home, ENDED), {});
  } finally {
    server.close();
  }
});

test("a session whose SessionEnd came and whose process hasn't updated since can be removed", async () => {
  const home = tempHome();
  const transcript = join(home, "t.jsonl");
  writeFileSync(transcript, "");
  seed(home, ENDED, transcript);
  workHook(home, { ...HOOKS["post-taskcreate"], session_id: ENDED, hook_event_name: "SessionEnd" });
  const ended = readWork(home, ENDED)!.ended!;
  const { server, base } = await serve(home, () => [{ session: ENDED, pid: 1, status: "idle", updatedAt: Date.parse(ended) - 1000 }]);
  try {
    const res = await fetch(`${base}/api/work/${ENDED}/remove`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(existsSync(join(home, "work", `${ENDED}.json`)), false);
  } finally {
    server.close();
  }
});

test("the Work page removes an ended session after an inline confirmation, and all ended ones at once", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  const transcript = join(home, "t.jsonl");
  writeFileSync(transcript, "");
  for (const s of [ENDED, OTHER, BUSY]) seed(home, s, transcript);
  await withBrowser(
    async ({ base, page }) => {
      const dialogs: string[] = [];
      page.on("dialog", (d) => void dialogs.push(d.message()));
      await page.goto(`${base}/work`);
      await page.locator("section.work-session").nth(2).waitFor();
      // Only the ended sessions offer it.
      assert.equal(await page.locator('.session-head [data-act="forget"]').count(), 2);
      const busy = page.locator("section.work-session").filter({ has: page.locator(".sid", { hasText: BUSY.slice(0, 8) }) });
      assert.equal(await busy.locator('[data-act="forget"]').count(), 0);

      // From the keyboard: the confirmation names the session and what it holds, and says what stays.
      const first = page.locator('.session-head [data-act="forget"]').first();
      await first.focus();
      await page.keyboard.press("Enter");
      const confirm = page.locator(".confirm");
      assert.match(await confirm.innerText(), /\(2 todos, 1 agent\) from the Work page\? .*Claude Code's transcript and session are not deleted\./s);
      assert.ok(await hasFocus(page.locator(".confirm [data-confirm]")));
      // Escape cancels, and the focus goes back to the button.
      await page.keyboard.press("Escape");
      assert.equal(await confirm.count(), 0);
      assert.ok(await hasFocus(first));
      assert.ok(readWork(home, ENDED) && readWork(home, OTHER), "a cancelled removal removes nothing");

      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelectorAll("section.work-session").length === 2);
      // The focus goes to the session that took its place.
      assert.ok(await hasFocus(page.locator("section.work-session h2 button").nth(1)));
      assert.equal([readWork(home, ENDED), readWork(home, OTHER)].filter(Boolean).length, 1);

      // Remove all ended shows while two ended sessions are listed: seed the removed one back.
      seed(home, readWork(home, ENDED) ? OTHER : ENDED, transcript);
      await page.reload();
      await page.getByRole("button", { name: "Remove all ended sessions" }).click();
      assert.match(await confirm.innerText(), /Remove 2 ended sessions \(4 todos, 2 agents\)/);
      await confirm.getByRole("button", { name: "Remove" }).click();
      await page.waitForFunction(() => document.querySelectorAll("section.work-session").length === 1);
      assert.equal(readWork(home, ENDED), undefined);
      assert.equal(readWork(home, OTHER), undefined);
      assert.ok(readWork(home, BUSY));
      assert.deepEqual(dialogs, [], "no native dialog");
    },
    new Hoop(new Store(home)),
    { sessions: () => [{ session: BUSY, pid: 1, status: "busy" }] },
  );
});

test("a session that may still run stays: active lately with no SessionEnd, resumed, or carried on after /clear", async () => {
  const home = tempHome();
  const transcript = join(home, "t.jsonl");
  writeFileSync(transcript, "");
  const PID = 4242,
    START = "Mon Oct 26 10:00:00 2026";
  // No SessionEnd and no live entry: its record changed a minute ago, or only its transcript did.
  seed(home, ENDED, transcript, new Date(Date.now() - 60_000).toISOString());
  const lately = join(home, "lately.jsonl");
  writeFileSync(lately, "");
  seed(home, OTHER, lately);
  utimesSync(lately, new Date(), new Date());
  // SessionEnd came, then the session was resumed: its process updated later.
  seed(home, IDLE, transcript);
  workHook(home, { ...HOOKS["post-taskcreate"], session_id: IDLE, hook_event_name: "SessionEnd" }, HOUR_AGO.toISOString());
  // A comment made through a process that runs on under a new session after /clear.
  seed(home, BUSY, transcript);
  addChanges(home, BUSY, [{ kind: "comment", todo: "2", text: "Ship it" }], {
    by: "owner",
    reachable: false,
    now: HOUR_AGO.toISOString(),
    process: { pid: PID, start: START },
  });
  utimesSync(transcript, HOUR_AGO, HOUR_AGO);
  const { server, base } = await serve(home, () => [
    { session: IDLE, pid: 7, status: "idle", updatedAt: Date.now() },
    { session: "dddddddd-1111-2222-3333-444444444444", pid: PID, start: START, status: "idle" },
  ]);
  try {
    for (const [s, reason] of [
      [ENDED, "quiet"],
      [OTHER, "quiet"],
      [IDLE, "running"],
      [BUSY, "cleared"],
    ] as const) {
      const res = await removeAt(base, s);
      assert.equal(res.status, 409, s);
      assert.equal((await res.json()).reason, reason, s);
      assert.ok(readWork(home, s), `${s} keeps its record`);
    }
  } finally {
    server.close();
  }
});

test("a session hoop never recorded is a 404, and nothing is deleted", async () => {
  const home = tempHome();
  const transcript = join(home, "t.jsonl");
  writeFileSync(transcript, "");
  seed(home, OTHER, transcript);
  // Its hooks stamped, but it never had work.
  stampHook(home, { session_id: ENDED, hook_event_name: "Stop" }, HOUR_AGO.toISOString());
  const before = [...files(home, ENDED), ...files(home, OTHER)];
  const { server, base } = await serve(home, () => []);
  try {
    assert.equal((await removeAt(base, ENDED)).status, 404);
    assert.deepEqual([...files(home, ENDED), ...files(home, OTHER)], before);
  } finally {
    server.close();
  }
});

test("Remove all ended removes what it can, keeps the confirm button disabled meanwhile, and says what stayed", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  const transcript = join(home, "t.jsonl");
  writeFileSync(transcript, "");
  for (const s of [ENDED, OTHER]) seed(home, s, transcript);
  await withBrowser(
    async ({ base, page }) => {
      // OTHER's process came back between the page's last poll and the removal; its answer is slow.
      let release = () => {};
      const held = new Promise<void>((r) => (release = r));
      await page.route(`**/api/work/${OTHER}/remove`, async (route) => {
        await held;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "This session is still running.", reason: "running" }),
        });
      });
      await page.goto(`${base}/work`);
      await page.getByRole("button", { name: "Remove all ended sessions" }).click();
      const yes = page.locator(".confirm [data-confirm]");
      await yes.click();
      await page.waitForFunction(() => document.querySelector(".confirm [data-confirm]")?.hasAttribute("disabled"));
      release();
      const err = page.locator(".confirm .steer-error");
      await err.filter({ hasText: "stays" }).waitFor();
      assert.match(await err.innerText(), /^Removed 1 ended session\. .+ stays\. This session is still running\.$/);
      assert.equal(await page.locator("section.work-session").count(), 1, "the removed session is gone and the kept one stays listed");
      assert.match(await page.locator(".confirm > span").innerText(), /Remove .+ \(2 todos, 1 agent\)/);
      assert.equal(await yes.isDisabled(), false);
      assert.ok(await hasFocus(yes));
      assert.equal(readWork(home, ENDED), undefined);
      assert.ok(readWork(home, OTHER));
    },
    new Hoop(new Store(home)),
    { sessions: () => [] },
  );
});
