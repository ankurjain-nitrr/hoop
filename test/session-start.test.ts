import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { NOTE_MAX, readSnapshot, SNAPSHOT_FRESH_MS, saveSnapshot, sessionNote, sessionStartOutput } from "../src/session-start.js";
import { Store } from "../src/store.js";
import { editWork, moveInQueue, workHook } from "../src/work.js";
import { example, hoopArgs, pagesFor, TEST_SESSION, tempHome } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/hook-inputs/session-hooks.json", import.meta.url), "utf8"));
const WORK = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const startScript = new URL("../plugins/hoop/scripts/session-start.sh", import.meta.url).pathname;
const compactScript = new URL("../plugins/hoop/scripts/pre-compact.sh", import.meta.url).pathname;
const SOURCES = ["startup", "resume", "clear", "compact"] as const;

/** The session's transcript in the test's Claude Code folder, so its reviews sit in its `.hoop`. */
function transcript(folder = "-tmp-start") {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "projects", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${TEST_SESSION}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "Go" } })}\n`);
  return path;
}

const hook = (name: string, path: string) => ({ ...structuredClone(HOOKS[name]), transcript_path: path });

/** Todos created through the work hook, as Claude Code's TaskCreate reports them. */
function todos(home: string, path: string, subjects: string[]) {
  subjects.forEach((subject, n) =>
    workHook(home, {
      ...structuredClone(WORK["post-taskcreate"]),
      session_id: TEST_SESSION,
      transcript_path: path,
      tool_input: { subject },
      tool_response: { task: { id: String(n + 1), subject } },
    }),
  );
}

/** A session with two queued todos the person reordered, and a review or question in each state. */
function busySession() {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript();
  const hoop = new Hoop(store);
  todos(home, path, ["Write the migration", "Ship it"]);
  editWork(home, TEST_SESSION, (r) => moveInQueue(r, "2", "before", "1"));
  const unread = hoop.submit({ ...example(), title: "Export plan" }).review_id;
  hoop.review(unread, { verdict: "changes_requested", reviewer: "ana", comments: [], summary: "Split it." });
  const owed = hoop.submit({ ...example(), title: "Storage design" }).review_id;
  hoop.review(owed, { verdict: "changes_requested", reviewer: "bo", comments: [], summary: "Use files." });
  hoop.receive(owed);
  const approved = hoop.submit({ ...example(), title: "Rollout" }).review_id;
  hoop.review(approved, { verdict: "approved", reviewer: "cy", comments: [] });
  const waiting = hoop.submit({ ...example(), title: "Naming" }).review_id;
  const ask = hoop.ask({
    questions: [{ question: "Keep the old endpoint?", options: [{ label: "Keep it", recommended: true }, { label: "Remove it" }] }],
  }).review_id;
  hoop.answer(ask, { question: "Q1", choice: "B" });
  return { home, store, path, ids: { unread, owed, approved, waiting, ask } };
}

test("every session start lists the queue in the person's order, unread feedback and what waits on Claude, under 1,500 characters", () => {
  const { store, path, ids } = busySession();
  for (const source of SOURCES) {
    const note = sessionNote(store, hook(source, path));
    assert.ok(note.length <= NOTE_MAX, `${source}: ${note.length} characters`);
    assert.match(note, /^Queued todos, in the person's order: #2 Ship it; #1 Write the migration\.$/m, source);
    assert.match(note, new RegExp(`"Export plan" \\(${ids.unread}\\) changes requested by ana`), source);
    assert.match(note, new RegExp(`"Rollout" \\(${ids.approved}\\) approved by cy`), `${source}: an approval not read yet is unread feedback`);
    assert.match(note, new RegExp(`"Keep the old endpoint\\?" \\(${ids.ask}\\) answered`), source);
    assert.match(note, new RegExp(`^Waiting on your answer: "Storage design" \\(${ids.owed}\\) changes requested\\.$`, "m"), source);
    assert.doesNotMatch(note, /hoop_|read it with/, `${source}: no instructions`);
    const naming = new RegExp(`"Naming" \\(${ids.waiting}\\) awaiting review`);
    if (source === "compact") assert.match(note, naming, "after a compaction, what is still open");
    else assert.doesNotMatch(note, naming, "a review waiting on the person isn't listed");
    assert.deepEqual(sessionStartOutput(note), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note } });
  }
});

test("a session with nothing in hoop, or an input that isn't a session start, gets no note", () => {
  const store = new Store(tempHome());
  const path = transcript("-tmp-start-empty");
  for (const source of SOURCES) assert.equal(sessionNote(store, hook(source, path)), "");
  const { store: busy, path: busyPath } = busySession();
  for (const input of [null, "x", {}, hook("pre-compact", busyPath), { ...hook("startup", busyPath), session_id: "../x" }])
    assert.equal(sessionNote(busy, input), "");
  assert.equal(sessionStartOutput(""), undefined);
});

test("a long queue is cut to fit, saying how many more there are", () => {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript("-tmp-start-long");
  todos(
    home,
    path,
    Array.from({ length: 60 }, (_, n) => `Todo ${n + 1}: ${"a long description of the work ".repeat(4)}`),
  );
  const note = sessionNote(store, hook("resume", path));
  assert.ok(note.length <= NOTE_MAX, `${note.length} characters`);
  assert.match(note, /#1 Todo 1/);
  assert.match(note, /; \d+ more\.$/);
});

test("the snapshot before a compaction keeps the open reviews, and the session start after it lists the same items", () => {
  const { store, path, ids } = busySession();
  const snapshot = saveSnapshot(store, hook("pre-compact", path))!;
  assert.deepEqual(new Set(snapshot.reviews), new Set([ids.unread, ids.owed, ids.waiting, ids.ask]), "approved reviews aren't open");
  assert.deepEqual(readSnapshot(store.home, TEST_SESSION), snapshot);
  assert.equal(saveSnapshot(store, hook("compact", path)), undefined, "only a PreCompact input takes a snapshot");
  const note = sessionNote(store, hook("compact", path));
  for (const id of snapshot.reviews) assert.match(note, new RegExp(id));
  // Something newer than the snapshot is listed too.
  const newer = new Hoop(store).submit({ ...example(), title: "Later doc" }).review_id;
  assert.match(sessionNote(store, hook("compact", path)), new RegExp(`"Later doc" \\(${newer}\\) awaiting review`));
});

test("regression: the queue after a compaction is the live one, never a snapshot's, so finished todos aren't listed", () => {
  const { home, store, path } = busySession();
  // An older snapshot, as when a later PreCompact's write was dropped, held the queue then.
  saveSnapshot(store, hook("pre-compact", path));
  for (const taskId of ["1", "2"])
    workHook(home, {
      ...structuredClone(WORK["post-taskupdate-completed"]),
      session_id: TEST_SESSION,
      transcript_path: path,
      tool_input: { taskId, status: "completed" },
    });
  assert.doesNotMatch(sessionNote(store, hook("compact", path)), /Queued todos|#1|#2/);
  rmSync(join(home, "work", `${TEST_SESSION}.json`));
  assert.doesNotMatch(sessionNote(store, hook("compact", path)), /Queued todos/, "no Work record means no queue");
});

test("regression: a snapshot from an earlier compaction is ignored; a fresh one is used", () => {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript("-tmp-start-stale");
  const mine = new Hoop(store).submit({ ...example(), title: "Mine" }).review_id;
  // A review the snapshot alone names: another session's, which only a snapshot can bring into this note.
  const other = new Hoop(store, "other-session-0001").submit({ ...example(), title: "Elsewhere" }).review_id;
  const write = (at: string) =>
    writeFileSync(join(home, "compact", `${TEST_SESSION}.json`), JSON.stringify({ session: TEST_SESSION, at, reviews: [mine, other] }));
  mkdirSync(join(home, "compact"), { recursive: true });
  const now = Date.now();
  write(new Date(now - SNAPSHOT_FRESH_MS - 60_000).toISOString());
  const stale = sessionNote(store, hook("compact", path), now);
  assert.match(stale, new RegExp(mine), "what is open now is still listed");
  assert.doesNotMatch(stale, new RegExp(other), "a stale snapshot adds nothing");
  write(new Date(now + 60_000).toISOString());
  assert.doesNotMatch(sessionNote(store, hook("compact", path), now), new RegExp(other), "nor one dated after the start");
  write(new Date(now - 30_000).toISOString());
  assert.match(sessionNote(store, hook("compact", path), now), new RegExp(`"Elsewhere" \\(${other}\\) awaiting review`));
});

test("regression: a superseded review the snapshot named isn't listed as open", () => {
  const { store, path, ids } = busySession();
  saveSnapshot(store, hook("pre-compact", path));
  store.update(ids.waiting, { superseded_by: ids.owed });
  assert.doesNotMatch(sessionNote(store, hook("compact", path)), new RegExp(ids.waiting));
});

test("regression: nothing open writes no snapshot, and removes an older one", () => {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript("-tmp-start-none");
  assert.equal(saveSnapshot(store, hook("pre-compact", path)), undefined);
  assert.equal(existsSync(join(home, "compact", `${TEST_SESSION}.json`)), false);
  const hoop = new Hoop(store);
  const id = hoop.submit(example()).review_id;
  assert.deepEqual(saveSnapshot(store, hook("pre-compact", path))?.reviews, [id]);
  hoop.review(id, { verdict: "approved", reviewer: "ana", comments: [] });
  assert.equal(saveSnapshot(store, hook("pre-compact", path)), undefined);
  assert.equal(readSnapshot(home, TEST_SESSION), undefined, "the older snapshot went with what it held");
});

test("after /clear, the new session ID gets the note for the reviews its process owns", () => {
  // Ownership after /clear rests on the Claude Code process: the review's owner records the pid and
  // start time of the process that submitted it, and Claude Code's `sessions/<pid>.json` names the
  // session ID that process runs now. hoop matches the two (`actsAs`), never the hook's word.
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.json`);
  const d = new Date(Date.now() - process.uptime() * 1000);
  const procStart = `${d.toUTCString().slice(0, 3)} ${d.toUTCString().slice(8, 11)} ${String(d.getUTCDate()).padStart(2, " ")} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`;
  const runs = (sessionId: string) =>
    writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId, cwd: "/tmp/start", startedAt: 1792839161891, procStart, kind: "interactive" }));
  try {
    runs(TEST_SESSION);
    const store = new Store(tempHome());
    const path = transcript("-tmp-start-clear");
    const hoop = new Hoop(store);
    const id = hoop.submit({ ...example(), title: "Before clear" }).review_id;
    assert.equal(store.meta(id).owner?.process?.pid, process.pid, "the owner names its process");
    hoop.review(id, { verdict: "changes_requested", reviewer: "ana", comments: [], summary: "Shorter." });
    const cleared = "a344f2e4-455b-4293-bb0f-0203b0b08a1d";
    const input = { ...hook("clear", path), session_id: cleared };
    runs(cleared);
    assert.match(sessionNote(store, input), new RegExp(`"Before clear" \\(${id}\\) changes requested by ana`));
    runs("another-session-0002");
    assert.equal(sessionNote(store, input), "", "a session ID its process no longer runs owns nothing");
  } finally {
    rmSync(file, { force: true });
  }
});

test("a note with non-ASCII titles and todos stays under the cap and never splits a character", () => {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript("-tmp-start-unicode");
  todos(
    home,
    path,
    Array.from({ length: 30 }, (_, n) => `迁移任务 ${n + 1}：把数据库表逐个迁移到新的存储 🚀🚀🚀 ${"é".repeat(40)}`),
  );
  const hoop = new Hoop(store);
  for (let n = 0; n < 20; n++) {
    const id = hoop.submit({ ...example(), title: `設計ドキュメント ${n + 1}：移行計画の見直し 📦 ${"ü".repeat(60)}` }).review_id;
    hoop.review(id, { verdict: "approved", reviewer: "ana", comments: [] });
  }
  const note = sessionNote(store, hook("resume", path));
  assert.ok(note.length <= NOTE_MAX && [...note].length <= NOTE_MAX, `${note.length} characters`);
  assert.doesNotMatch(note, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no half of a surrogate pair");
  assert.match(note, /迁移任务 1：/);
  assert.match(note, /\d+ more\./);
});

test("the scripts fail open without a hoop folder, and the PreCompact snapshot reaches the next compact start", async () => {
  assert.equal(spawnSync("sh", ["-n", startScript]).status, 0, "POSIX sh");
  assert.equal(spawnSync("sh", ["-n", compactScript]).status, 0, "POSIX sh");
  const real = [process.execPath, ...hoopArgs].join(" ");
  const run = (script: string, input: unknown, env: Record<string, string>) =>
    spawnSync("/bin/sh", [script], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, HOOP_BIN: real, ...env } });

  const path = transcript();
  const missing = join(tmpdir(), `hoop-missing-${process.pid}`);
  for (const source of SOURCES) assert.deepEqual(pick(run(startScript, hook(source, path), { HOOP_HOME: missing })), [0, "", ""], source);
  assert.deepEqual(pick(run(compactScript, hook("pre-compact", path), { HOOP_HOME: missing })), [0, "", ""]);
  const direct = spawnSync(process.execPath, [...hoopArgs, "session-start"], {
    input: JSON.stringify(hook("resume", path)),
    encoding: "utf8",
    env: { ...process.env, HOOP_HOME: missing },
  });
  assert.deepEqual(pick(direct), [0, "", ""], "hoop session-start alone, too");
  assert.equal(existsSync(missing), false, "nothing creates the hoop folder");

  const { home, ids } = busySession();
  // No pages process: the snapshot is dropped, and none starts.
  assert.deepEqual(pick(run(compactScript, hook("pre-compact", path), { HOOP_HOME: home, HOOP_PORT: "1" })), [0, "", ""]);
  assert.equal(readSnapshot(home, TEST_SESSION), undefined);

  const pages = await pagesFor(home);
  assert.deepEqual(pick(run(compactScript, hook("pre-compact", path), pages)), [0, "", ""]);
  assert.ok(readSnapshot(home, TEST_SESSION)?.reviews.includes(ids.waiting), "the pages process wrote the snapshot");
  const out = run(startScript, hook("compact", path), pages);
  assert.equal(out.status, 0);
  const note: string = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  for (const id of Object.values(ids)) assert.match(note, new RegExp(id));
  assert.ok(note.length <= NOTE_MAX);

  const hooks = JSON.parse(readFileSync(new URL("../plugins/hoop/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  assert.equal(hooks.SessionStart[0].matcher, "startup|resume|clear|compact");
  assert.match(hooks.SessionStart[0].hooks[0].command, /session-start\.sh/);
  assert.match(hooks.PreCompact[0].hooks[0].command, /pre-compact\.sh/);
  for (const h of [hooks.SessionStart[0].hooks[0], hooks.PreCompact[0].hooks[0]])
    assert.ok(h.timeout > 4, "Claude Code's timeout is longer than the script's wait");
});

const pick = (r: ReturnType<typeof spawnSync>) => [r.status, String(r.stdout), String(r.stderr)];
