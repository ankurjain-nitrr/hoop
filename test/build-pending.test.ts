import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TAKEN_LIMIT_MS } from "../src/build.js";
import { Hoop } from "../src/hoop.js";
import { OPS } from "../src/ops.js";
import { stopGate } from "../src/stop.js";
import { Store } from "../src/store.js";
import { isWaiting, lastWaited, saveWaitMark } from "../src/wait.js";
import { buildMessage } from "../src/wake.js";
import { createWebServer, type PagesOptions } from "../src/web.js";
import type { ClaudeSession } from "../src/work.js";
import { BROWSER_SKIP, TEST_SESSION, tempHome, withBrowser } from "./helpers.js";

// A pending Generate or Suggest holds its heading until Claude answers or the person cancels it
// (#347), and a request always reaches Claude's session or shows that it hasn't (#348).

// b1 # Cutting cloud cost, b2 paragraph, b3 ## Where the money goes, b4 paragraph, b5 ## Options
const OUTLINE = "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\nOld guess.\n\n## Options\n";
const run = (hoop: Hoop, name: string, input: Record<string, unknown>) => OPS.find((o) => o.name === name)!.run(hoop, input, { actor: "claude" });
const MIN = 60_000;

function started() {
  const hoop = new Hoop(new Store(tempHome()));
  return { hoop, id: hoop.startBuild(OUTLINE).review_id };
}

/** Sets every taken request's `taken_at` to `ms` ago, as if Claude took it then. */
function takenAgo(hoop: Hoop, id: string, ms: number) {
  const build = hoop.builds.read(id);
  for (const r of build.requests ?? []) if (r.taken_at) r.taken_at = new Date(Date.now() - ms).toISOString();
  hoop.builds.save(id, build, "claude", "test");
}

/** A pages server on a free port, with a stand-in for the Claude Code sessions and the sender. */
async function withServer(opts: PagesOptions, fn: (base: string, hoop: Hoop) => Promise<void>) {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop, [], opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hoop);
  } finally {
    server.close();
  }
}

const change = (base: string, id: string, body: unknown) =>
  fetch(`${base}/api/reviews/${id}/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

test("a second request of the same kind on a heading is refused while the first is open, through the API too", async () => {
  await withServer({ sessions: () => [] }, async (base, hoop) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    assert.equal((await change(base, id, { op: "generate", block: "b3" })).status, 201);
    const again = await change(base, id, { op: "generate", block: "b3", note: "again" });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /Claude already has this request on the heading; cancel it to ask again/);
    // Another kind on the same heading is its own request.
    assert.equal((await change(base, id, { op: "suggest", block: "b3", kind: "subsections" })).status, 201);
    assert.equal((await change(base, id, { op: "suggest", block: "b3", kind: "subsections" })).status, 400);
    assert.deepEqual(
      hoop.builds.read(id).requests!.map((r) => [r.block, r.kind ?? "write", r.status]),
      [
        ["b3", "write", "queued"],
        ["b3", "subsections", "queued"],
      ],
    );
  });
});

test("Cancel on a queued request removes it, frees the heading, and Claude writes the section once", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "generate", block: "b3", note: "one" });
  const build = hoop.buildChange(id, { op: "cancel", request: "g1" });
  assert.deepEqual([build.requests![0]!.status, build.requests![0]!.cancelled], ["written", true]);
  assert.equal(build.steps.at(-1)!.what, "cancelled a request to write under a heading");
  assert.deepEqual(hoop.takeRequests(id), [], "nothing left to take");
  hoop.buildChange(id, { op: "generate", block: "b3", note: "two" });
  const tasks = hoop.takeRequests(id);
  assert.deepEqual(
    tasks.map((t) => [t.request, t.note]),
    [["g2", "two"]],
  );
  hoop.buildWrite(id, "b3", "Compute.");
  assert.match(hoop.markdownOf(id), /## Where the money goes\n\nCompute\.\n\n## Options/);
  // Cancelling one Claude already answered changes nothing.
  const version = hoop.builds.read(id).version;
  assert.equal(hoop.buildChange(id, { op: "cancel", request: "g2" }).version, version);
  assert.throws(() => hoop.buildChange(id, { op: "cancel", request: "g9" }), /has no request g9/);
});

test("Cancel on a taken request drops Claude's late answer, and the section keeps the person's text", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "edit", block: "b4", text: "My own guess." });
  hoop.buildChange(id, { op: "generate", block: "b3" });
  hoop.takeRequests(id);
  hoop.buildChange(id, { op: "cancel", request: "g1" });
  assert.throws(() => hoop.buildWrite(id, "b3", "Claude's words."), /the person cancelled request g1 after you took it, so their text stays/);
  // A new Generate the session hasn't taken yet isn't what that late write answers either.
  hoop.buildChange(id, { op: "generate", block: "b3" });
  assert.throws(() => hoop.buildWrite(id, "b3", "Claude's words."), /cancelled request g1/);
  assert.match(hoop.markdownOf(id), /My own guess\./);
  // Once Claude takes the new one, its write lands.
  hoop.takeRequests(id);
  hoop.buildWrite(id, "b3", "Claude's words.");
  assert.match(hoop.markdownOf(id), /Claude's words\./);

  // A suggestion cancelled after Claude took it is refused the same way.
  hoop.buildChange(id, { op: "suggest", block: "b5", kind: "subsections" });
  const [task] = hoop.takeRequests(id);
  hoop.buildChange(id, { op: "cancel", request: task!.request });
  assert.throws(() => hoop.buildSuggest(id, task!.request, [{ heading: "### Spot" }]), /the person cancelled request g3/);
  assert.equal(hoop.builds.read(id).proposals, undefined);
  // A block's Generate again or comment isn't cancelled this way.
  assert.throws(() => hoop.buildChange(id, { op: "cancel", request: "nope" }), /has no request nope/);
});

test("a taken request Claude hasn't answered in 10 minutes is queued again, and the next wait takes it again", async () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "generate", block: "b3" });
  const now = Date.now();
  assert.equal(hoop.builds.take(id, now).length, 1);
  assert.deepEqual(hoop.builds.take(id, now + TAKEN_LIMIT_MS - 1), [], "still Claude's before the limit");
  const again = hoop.builds.take(id, now + TAKEN_LIMIT_MS);
  assert.deepEqual(
    again.map((t) => t.request),
    ["g1"],
    "taken again at the limit",
  );
  assert.deepEqual([hoop.builds.read(id).requests![0]!.status, hoop.builds.read(id).requests![0]!.retried], ["taken", 1]);

  // Through hoop_build_wait, with the take moved back in time instead of waiting.
  takenAgo(hoop, id, TAKEN_LIMIT_MS + MIN);
  const got = (await run(hoop, "build_wait", { review_id: id, seconds: 1 })) as { status: string; requests: { request: string }[] };
  assert.deepEqual([got.status, got.requests.map((r) => r.request)], ["requests", ["g1"]]);
  assert.equal(hoop.builds.read(id).requests![0]!.retried, 2);
  // Claude's write answers it as usual.
  hoop.buildWrite(id, "b3", "Compute.");
  assert.equal(hoop.builds.read(id).requests![0]!.status, "written");
});

test("the build page's view shows a stuck request as queued again, and whether Claude's session waits on the build", async () => {
  await withServer({ sessions: () => [] }, async (base, hoop) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    const view = async () => (await fetch(`${base}/api/reviews/${id}/build`)).json();
    assert.deepEqual((await view()).claude, { listening: false }, "never checked");
    // hoop_build_wait marks its wait: listening while it runs and for a grace after it ran out of time.
    const waiting = run(hoop, "build_wait", { review_id: id, seconds: 1 });
    assert.equal((await view()).claude.listening, true);
    await waiting;
    assert.ok(isWaiting(hoop.store.home, id), "the grace after a wait ran out of time");
    // One that returned requests stops listening at once, and says when it last checked.
    hoop.buildChange(id, { op: "generate", block: "b3" });
    await run(hoop, "build_wait", { review_id: id, seconds: 1 });
    const checked = await view();
    assert.equal(checked.claude.listening, false);
    assert.equal(checked.claude.checked, lastWaited(hoop.store.home, id));

    takenAgo(hoop, id, TAKEN_LIMIT_MS + MIN);
    const stuck = await view();
    assert.deepEqual([stuck.requests[0].status, stuck.requests[0].retried], ["queued", 1]);
    assert.equal(hoop.builds.read(id).requests![0]!.status, "taken", "reading changes nothing");
  });
});

test("a request made while the build's session is idle wakes it once, until it takes them; not while it waits", async () => {
  const sent: [string, string][] = [];
  const sessions = (): ClaudeSession[] => [{ session: TEST_SESSION, pid: 1, status: "idle", socket: "/tmp/hoop-test.sock" }];
  await withServer({ sessions, send: async (s, t) => void sent.push([s, t]) }, async (base, hoop) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    const meta = hoop.store.meta(id);
    await change(base, id, { op: "generate", block: "b3" });
    assert.deepEqual(sent, [["/tmp/hoop-test.sock", buildMessage(meta)]]);
    assert.equal(sent[0]![1], `The person asked for something on the build "Cutting cloud cost" (${id}) in hoop: take it with hoop_build_wait ${id}.`);
    assert.equal(hoop.store.deliveries(id)["build:g1"]!.outcome, "sent");
    // More requests before Claude takes the first send nothing more; edits never do.
    await change(base, id, { op: "suggest", block: "b5", kind: "subsections" });
    await change(base, id, { op: "edit", block: "b4", text: "New guess." });
    assert.equal(sent.length, 1);
    // Once Claude took them, the next request wakes it again.
    hoop.takeRequests(id);
    await change(base, id, { op: "generate", block: "b5" });
    assert.equal(sent.length, 2);
    // While a wait runs, it takes the request itself.
    hoop.takeRequests(id);
    const waiting = run(hoop, "build_wait", { review_id: id, seconds: 2 });
    while (!isWaiting(hoop.store.home, id)) await new Promise((r) => setTimeout(r, 10));
    await change(base, id, { op: "suggest", block: "b1", kind: "outline" });
    assert.equal(sent.length, 2);
    assert.equal(hoop.store.deliveries(id)["build:g4"]!.outcome, "waiting");
    await waiting;
  });
});

/** A transcript whose latest turn started a minute ago and is ending now. */
function transcript(): string {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-build-pending");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${TEST_SESSION}.jsonl`);
  const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const lines = [
    { type: "user", timestamp: at(60), message: { role: "user", content: "Build the cost doc with me" } },
    { type: "assistant", timestamp: at(1), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Started it." }] } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

test("a turn ending with an untaken build request is stopped once, and not again for the same request", () => {
  // The transcript first: a session that has one keeps its reviews beside it, where the gate looks.
  const stop = { hook_event_name: "Stop", session_id: TEST_SESSION, stop_hook_active: false, transcript_path: transcript() };
  const { hoop, id } = started();
  assert.equal(stopGate(hoop.store, stop), undefined, "nothing asked");
  hoop.buildChange(id, { op: "generate", block: "b3" });
  const first = stopGate(hoop.store, stop);
  assert.match(
    first!.block,
    new RegExp(`The person left a request on your build "Cutting cloud cost" in hoop that you haven't taken: take it with hoop_build_wait ${id}\\.`),
  );
  assert.equal(stopGate(hoop.store, stop), undefined, "told once");
  // A new request is a new cause; one Claude took is not.
  hoop.buildChange(id, { op: "suggest", block: "b5", kind: "subsections" });
  assert.match(stopGate(hoop.store, stop)!.block, /left 2 requests on your build/);
  hoop.takeRequests(id);
  hoop.buildChange(id, { op: "suggest", block: "b1", kind: "outline" });
  assert.match(stopGate(hoop.store, stop)!.block, /left a request on your build/);
  assert.equal(stopGate(hoop.store, stop), undefined);
});

test("the Stop hook's script starts hoop for an open build with a request Claude hasn't answered", (t) => {
  // A Claude Code folder of its own, so the other tests' builds don't sit beside this transcript.
  const claudeDir = process.env.HOOP_CLAUDE_DIR;
  process.env.HOOP_CLAUDE_DIR = mkdtempSync(join(tmpdir(), "hoop-claude-"));
  t.after(() => {
    process.env.HOOP_CLAUDE_DIR = claudeDir;
  });
  const stop = { hook_event_name: "Stop", session_id: TEST_SESSION, stop_hook_active: false, transcript_path: transcript() };
  const { hoop, id } = started();
  const bin = mkdtempSync(join(tmpdir(), "hoop-stop-bin-"));
  const crash = join(bin, "crash");
  writeFileSync(crash, `#!/bin/sh\ncat >/dev/null\necho ran >> "${bin}/ran"\nexit 1\n`);
  chmodSync(crash, 0o755);
  const ran = () => (existsSync(join(bin, "ran")) ? readFileSync(join(bin, "ran"), "utf8").split("\n").length - 1 : 0);
  const script = new URL("../plugins/hoop/scripts/stop-gate.sh", import.meta.url).pathname;
  const gate = () => spawnSync("/bin/sh", [script], { input: JSON.stringify(stop), env: { ...process.env, HOOP_HOME: hoop.store.home, HOOP_BIN: crash } });
  gate();
  assert.equal(ran(), 0, "nothing asked");
  hoop.buildChange(id, { op: "generate", block: "b3" });
  gate();
  assert.equal(ran(), 1, "a queued request");
  hoop.takeRequests(id);
  gate();
  assert.equal(ran(), 2, "a taken one, which may be stuck");
  hoop.buildWrite(id, "b3", "Compute.");
  gate();
  assert.equal(ran(), 2, "answered");
});

test("on the page, a pending Generate and Suggest can't be pressed again, show how long they waited, and Cancel frees them", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    await page.addInitScript(() => Object.assign(window, { HOOP_BUILD_MS: 200 }));
    await page.goto(`${base}/r/${id}`);
    await page.getByRole("button", { name: "Generate Heading 1 “Options”" }).click();
    await page.keyboard.press("Enter");
    const pending = page.getByRole("button", { name: "Generate Heading 1 “Options”: pending" });
    assert.equal(await pending.isDisabled(), true);
    assert.equal(await pending.innerText(), "Pending");
    // There is no Generate to press a second time.
    assert.equal(await page.getByRole("button", { name: "Generate Heading 1 “Options”", exact: true }).count(), 0);
    const wait = page.locator(".bwait").first();
    assert.match(await wait.innerText(), /^Queued \d+ s · Claude's session hasn't checked the build yet$/);

    // Suggest subheadings on the same heading is pending on its own.
    await page.getByRole("button", { name: "Suggest subheadings for Heading 1 “Options”" }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Suggest subheadings for Heading 1 “Options”: pending" }).waitFor();
    assert.equal(hoop.builds.read(id).requests!.length, 2);

    // Claude takes the Generate; the line says so. Then the person cancels it, and Claude's late text is dropped.
    hoop.builds.take(id);
    await page.locator(".bstatus", { hasText: "Claude is writing everything under this heading" }).waitFor();
    await page.getByRole("button", { name: "Cancel Generate on Heading 1 “Options”" }).click();
    const generate = page.getByRole("button", { name: "Generate Heading 1 “Options”", exact: true });
    await generate.waitFor();
    assert.equal(await generate.evaluate((el) => el === document.activeElement), true, "focus goes back to Generate");
    assert.throws(() => hoop.buildWrite(id, "b5", "Late."), /cancelled request g1/);
    assert.equal(hoop.markdownOf(id), OUTLINE);
    await page.getByRole("button", { name: "Cancel Suggest subheadings for Heading 1 “Options”" }).click();
    await page.getByRole("button", { name: "Suggest subheadings for Heading 1 “Options”", exact: true }).waitFor();
    assert.equal(await page.locator(".bpending").count(), 0);

    // A wait on the build shows Claude listening, without a reload.
    hoop.buildChange(id, { op: "generate", block: "b3" });
    await page.locator(".bwait", { hasText: "Claude's session hasn't checked the build yet" }).waitFor();
    saveWaitMark(hoop.store.home, id, { pid: process.pid, started: new Date().toISOString() });
    await page.locator(".bwait", { hasText: "Claude's session is checking the build" }).waitFor();

    // A request Claude took and left unanswered too long shows as queued again.
    hoop.builds.take(id);
    await page.locator(".bstatus", { hasText: "Claude is writing everything under this heading" }).waitFor();
    takenAgo(hoop, id, TAKEN_LIMIT_MS + MIN);
    await page.locator(".bwait", { hasText: "Claude didn't answer in time, so it's queued again" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Generate Heading 1 “Where the money goes”: pending" }).isDisabled(), true);
  }),
);
