import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptReads } from "../src/activity.js";
import { Hoop } from "../src/hoop.js";
import { Steer } from "../src/steer.js";
import { Store } from "../src/store.js";
import { type ClaudeSession, readWork, workHook, workView } from "../src/work.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

// Whether the agent read each change the Work page sent: its message carries a reference, and the
// session's transcript, read from where it stood when the message went out, shows when that message
// reached the agent (#211).

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
const iso = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();
const line = (v: unknown) => `${JSON.stringify(v)}\n`;
/** Output the agent writes, `kb` kilobytes of it. */
const output = (kb: number) =>
  Array.from({ length: kb }, (_, n) =>
    line({ type: "assistant", timestamp: iso(40), message: { content: [{ type: "text", text: `${n} ${"x".repeat(1000)}` }] } }),
  ).join("");

/** A session with two queued todos whose transcript is a temp file. */
function seeded() {
  const home = tempHome();
  const transcript = join(mkdtempSync(join(tmpdir(), "hoop-transcript-")), `${SESSION}.jsonl`);
  writeFileSync(transcript, line({ type: "user", timestamp: iso(0), message: { role: "user", content: "Start" } }));
  for (const [id, subject] of [
    ["1", "Read the code"],
    ["2", "Write the migration"],
  ])
    workHook(home, hook("post-taskcreate", { transcript_path: transcript, tool_input: { subject }, tool_response: { task: { id, subject } } }), iso(1));
  return { home, transcript };
}

/** A Steer whose sends are kept, for a live session with a socket. */
function steerFor(home: string) {
  const sent: string[] = [];
  const steer = new Steer(home, () => [{ session: SESSION, pid: 1, status: "busy", socket: "/fake/socket" }], {
    delayMs: 10_000,
    send: async (_socket, text) => void sent.push(text),
  });
  return { steer, sent };
}

const viewOf = (home: string, status: ClaudeSession["status"] = "busy") => workView(home, () => [{ session: SESSION, pid: 1, status }])[0]!;

test("a transcript shows when each Work message reached the agent: as a user message or a message queued while it worked", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hoop-reads-")), "t.jsonl");
  const before = line({ type: "user", timestamp: iso(0), message: { role: "user", content: "(hoop-ref st_before0)" } });
  writeFileSync(
    path,
    before +
      [
        { type: "queue-operation", operation: "enqueue", timestamp: iso(1), content: "From ankur … (hoop-ref st_queued1)" },
        { type: "attachment", timestamp: iso(2), attachment: { type: "queued_command", prompt: "From ankur … (hoop-ref st_queued1)" } },
        { type: "user", timestamp: iso(3), message: { role: "user", content: "Another Claude session sent a message:\nFrom ankur … (hoop-ref st_idle22)" } },
        { type: "user", timestamp: iso(4), message: { role: "user", content: [{ type: "text", text: "(hoop-ref st_parts3)" }] } },
        { type: "assistant", timestamp: iso(5), message: { role: "assistant", content: [{ type: "text", text: "(hoop-ref st_mine44)" }] } },
      ]
        .map(line)
        .join(""),
  );
  assert.deepEqual(
    transcriptReads(path, Buffer.byteLength(before)),
    { st_queued1: iso(2), st_idle22: iso(3), st_parts3: iso(4) },
    "a queued message counts once attached; the agent's own words and what came before the offset don't",
  );
  appendFileSync(path, line({ type: "user", timestamp: iso(9), message: { content: "(hoop-ref st_later5)" } }));
  assert.equal(transcriptReads(path, Buffer.byteLength(before))!.st_later5, iso(9), "a later call reads on from where the last stopped");
  assert.equal(transcriptReads(join(path, "missing"), 0), undefined);
});

test("a sent change reads as read once the transcript holds its message, and stays so in the record", async () => {
  const { home, transcript } = seeded();
  const { steer, sent } = steerFor(home);
  steer.record(SESSION, [{ kind: "remove", todo: "2" }], "ankur");
  const [c] = await steer.flush(SESSION);
  const ref = c!.ref!;
  assert.match(ref, /^st_[a-z0-9]+$/);
  assert.equal(c!.sent_offset, statSync(transcript).size, "the scan starts where the transcript stood when it went out");
  assert.ok(sent[0]!.endsWith(`\n\n(hoop-ref ${ref})`), "the message ends with its reference");
  assert.deepEqual([viewOf(home).changes[0]!.delivery, viewOf(home).changes[0]!.unread], ["sent", true], "not read while the transcript lacks it");

  appendFileSync(transcript, line({ type: "attachment", timestamp: iso(30), attachment: { type: "queued_command", prompt: sent[0] } }));
  const view = viewOf(home);
  assert.deepEqual([view.changes[0]!.delivery, view.changes[0]!.read_at], ["read", iso(30)]);
  steer.markRead([view]);
  const kept = readWork(home, SESSION)!.changes![0]!;
  assert.deepEqual([kept.delivery, kept.read_at], ["read", iso(30)], "kept in the record");
  // Acting on it still settles it as seen.
  workHook(home, hook("post-taskupdate-deleted", { tool_input: { taskId: "2", status: "deleted" } }));
  const done = readWork(home, SESSION)!.changes![0]!;
  assert.deepEqual([done.delivery, done.read_at], ["seen", iso(30)]);
});

test("a read followed by more than the activity tail's worth of output still reads as read", async () => {
  const { home, transcript } = seeded();
  const { steer, sent } = steerFor(home);
  steer.record(SESSION, [{ kind: "comment", todo: "1", text: "Mind the old rows" }], "ankur");
  await steer.flush(SESSION);
  appendFileSync(transcript, line({ type: "user", timestamp: iso(30), message: { role: "user", content: sent[0] } }) + output(400));
  const c = viewOf(home, "idle").changes[0]!;
  assert.deepEqual([c.delivery, c.read_at, c.unread], ["read", iso(30), undefined]);
});

test("the pages process writes a record only for changes newly read", async () => {
  const { home, transcript } = seeded();
  const { steer, sent } = steerFor(home);
  steer.record(SESSION, [{ kind: "comment", todo: "1", text: "Mind the old rows" }], "ankur");
  await steer.flush(SESSION);
  appendFileSync(transcript, line({ type: "user", timestamp: iso(30), message: { role: "user", content: sent[0] } }));
  const file = join(home, "work", `${SESSION}.json`);
  steer.markRead([viewOf(home)]);
  const written = statSync(file).mtimeMs;
  const again = viewOf(home);
  assert.equal(again.changes[0]!.delivery, "read");
  await new Promise((r) => setTimeout(r, 20));
  steer.markRead([again]);
  assert.equal(statSync(file).mtimeMs, written, "a change already recorded as read isn't written again");
});

test("the Work page says when the agent read a change, flags one its turn ended without, and never while the session works", {
  skip: BROWSER_SKIP,
}, async () => {
  const { home, transcript } = seeded();
  const { steer, sent } = steerFor(home);
  steer.record(SESSION, [{ kind: "comment", todo: "1", text: "Mind the old rows" }], "ankur");
  await steer.flush(SESSION);
  steer.record(SESSION, [{ kind: "comment", todo: "2", text: "Keep it small" }], "ankur");
  await steer.flush(SESSION);
  // The first message reached the agent; the session then went on without the second.
  appendFileSync(transcript, line({ type: "user", timestamp: new Date(Date.now() + 1000).toISOString(), message: { role: "user", content: sent[0] } }));
  let status: ClaudeSession["status"] = "busy";
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => ((window as unknown as { HOOP_WORK_MS: number }).HOOP_WORK_MS = 200));
      await page.goto(`${base}/work`);
      const note = (id: string) => page.locator(`.todo[data-todo="${id}"] .note .delivery`);
      await note("1").waitFor();
      assert.match(await note("1").innerText(), /^Read by Claude \d{1,2}:\d{2}/, "with the time it was read");
      assert.equal(await note("2").innerText(), "Sent to the session", "no warning while the session works");
      status = "idle";
      await page.locator(".todo[data-todo='2'] .note .delivery", { hasText: "Not read yet" }).waitFor();
      assert.equal(await note("2").innerText(), "Not read yet: the session's turn ended without it");
    },
    new Hoop(new Store(home)),
    { sessions: () => [{ session: SESSION, pid: 1, status, cwd: "/tmp/proj", socket: "/fake/socket" }] },
  );
  assert.equal(readWork(home, SESSION)!.changes![0]!.delivery, "read", "the page's poll recorded it");
});
