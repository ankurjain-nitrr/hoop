import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hoop } from "../src/hoop.js";
import { OPS } from "../src/ops.js";
import { clientHoop, Remote, runOp } from "../src/remote.js";
import { storeKey } from "../src/sessions.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { Queue, STORE_HEADER } from "../src/writes.js";
import { example, freePort, tempHome, TEST_SESSION, tsx, hoopArgs } from "./helpers.js";

const run = promisify(execFile);
const op = (name: string) => OPS.find((o) => o.name === name)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A pages server for `home` in this process, on a free port. */
async function serve(home = tempHome()) {
  const hoop = new Hoop(new Store(home));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  after(() => server.close());
  return { hoop, home, port };
}

/** A session's Hoop: a read-only store, with its writes sent to the pages on `port`. */
function session(home: string, port: number, agent = { session: "writer-owner", claude: false }) {
  const hoop = clientHoop(agent, home);
  hoop.remote = new Remote(home, port, { start: false });
  return hoop;
}

const markdown = "# Ship the export\n\nWhy we ship it now.\n\n## Plan\n\nDo it in two steps.\n";

test("a session's writes go through the pages process, and its own store refuses to write", async () => {
  const { hoop, home, port } = await serve();
  const s = session(home, port);
  assert.equal(s.store.readOnly, true);
  const r = (await runOp(s, op("submit"), { markdown }, { actor: "claude" })) as { review_id: string; outcome: string };
  assert.equal(r.outcome, "created");
  // The pages process wrote it, and the session reads it straight from the files.
  assert.equal(hoop.store.meta(r.review_id).title, "Ship the export");
  assert.equal(s.store.meta(r.review_id).owner?.session, "writer-owner");
  assert.throws(() => s.store.addReply(r.review_id, { thread: "th_x_1", author: "a", body: "b", at: "now" }), /only hoop's pages process writes/);
  assert.throws(() => s.store.create(example()), /only hoop's pages process writes/);
  // A refusal in the pages process comes back as the same refusal.
  await assert.rejects(
    runOp(session(home, port, { session: "someone-else", claude: false }), op("submit"), { markdown, review_id: r.review_id }, { actor: "claude" }),
    /Only the session that submitted this review can revise it/,
  );
});

test("a write with no pages process fails with the reason, and writes nothing", async () => {
  const home = tempHome();
  const s = session(home, await freePort());
  await assert.rejects(runOp(s, op("submit"), { markdown }, { actor: "claude" }), /only through its pages process, and none answers on port \d+/);
  assert.deepEqual(readdirSync(home), []);
});

test("many sessions writing one review at once through the pages process lose nothing", async () => {
  const { hoop, home, port } = await serve();
  const owner = new Hoop(hoop.store, { session: "writer-owner", claude: false });
  const { review_id } = owner.submit(example());
  const thread = owner.review(review_id, { verdict: "comment", comments: [{ item: "DOC", line: 1, body: "first" }] }).comments[0]!.thread!;
  const n = 40,
    tags = ["a", "b", "c"];
  await Promise.all(
    tags.map(
      (tag) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [tsx, new URL("./writer-worker.ts", import.meta.url).pathname, home, String(port), review_id, thread, String(n), tag],
            {
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let err = "";
          child.stderr.on("data", (d) => (err += d));
          child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${tag} exited ${code}: ${err}`))));
        }),
    ),
  );
  assert.equal(hoop.store.replies(review_id).length, tags.length * n);
  const feedback = hoop.store.feedback(review_id);
  assert.equal(feedback.length, 1 + tags.length * n);
  const threads = feedback.flatMap((f) => f.comments.map((c) => c.thread));
  assert.equal(new Set(threads).size, threads.length, "every comment got its own thread");
  assert.ok(!readdirSync(hoop.store.dirOf(review_id)).some((f) => f.endsWith(".lock")), "no lock files");
});

test("writes for one review run one at a time; other reviews' run beside them", async () => {
  const q = new Queue();
  const events: string[] = [];
  const job = (name: string, ms: number) => async () => {
    events.push(`${name} start`);
    await sleep(ms);
    events.push(`${name} end`);
    return name;
  };
  const failing = q.run("rv_a", async () => {
    events.push("bad start");
    throw new Error("bad");
  });
  const [a, b, c] = await Promise.all([q.run("rv_a", job("a1", 40)), q.run("rv_a", job("a2", 5)), q.run("rv_b", job("b1", 10)), failing.catch(() => "")]);
  assert.deepEqual([a, b, c], ["a1", "a2", "b1"]);
  // A failed write doesn't stop the next one; a2 starts only after a1 ends; b1 runs during a1.
  assert.ok(events.indexOf("bad start") < events.indexOf("a1 start"));
  assert.ok(events.indexOf("a2 start") > events.indexOf("a1 end"));
  assert.ok(events.indexOf("b1 end") < events.indexOf("a1 end"));
});

test("the pages process serializes a review's writes that wait in the middle", async () => {
  // A person's review waits to message the session; another write to the review waits its turn.
  const home = tempHome();
  const hoop = new Hoop(new Store(home), { session: "writer-owner", claude: true });
  const { review_id } = hoop.submit(example());
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const server = createWebServer(hoop, [], {
    sessions: () => [{ session: "writer-owner", pid: process.pid, status: "idle", socket: "/nowhere" }],
    send: async () => {
      order.push("send start");
      await held;
      order.push("send end");
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const page = fetch(`http://127.0.0.1:${port}/api/reviews/${review_id}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verdict: "changes_requested", comments: [{ item: "DOC", line: 1, body: "from the page" }] }),
  });
  while (!order.length) await sleep(5);
  const s = session(home, port, { session: "writer-owner", claude: true });
  const reply = runOp(s, op("comment"), { review_id, item: "DOC", line: 1, body: "from the session" }, { actor: "claude" }).then(() =>
    order.push("session wrote"),
  );
  await sleep(150);
  assert.deepEqual(order, ["send start"], "the session's write waits for the page's");
  release();
  await Promise.all([page, reply]);
  assert.deepEqual(order, ["send start", "send end", "session wrote"]);
});

/** A POST to the write route with the headers given. */
const post = (port: number, headers: Record<string, string>, body = "{}") =>
  new Promise<{ status: number; text: string }>((resolve) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/write/op", headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", () => resolve({ status: 0, text: "" }));
    req.end(body);
  });

test("the write route refuses browsers, other sites and other stores", async () => {
  const { hoop, home, port } = await serve();
  const key = storeKey(home);
  const body = JSON.stringify({ name: "submit", input: { markdown }, agent: { session: "evil", claude: false }, place: { repo_dir: "/tmp" } });
  const json = { "content-type": "application/json", [STORE_HEADER]: key };
  assert.equal((await post(port, { ...json, origin: "http://evil.example" }, body)).status, 403, "another site");
  assert.equal((await post(port, { ...json, origin: `http://localhost:${port}` }, body)).status, 403, "hoop's own page");
  assert.equal((await post(port, { ...json, "sec-fetch-site": "cross-site" }, body)).status, 403, "a browser without Origin");
  assert.equal((await post(port, { "content-type": "text/plain", [STORE_HEADER]: key }, body)).status, 415, "a form or text post");
  assert.equal((await post(port, { "content-type": "application/json", [STORE_HEADER]: "0000000000000000" }, body)).status, 409, "another store");
  assert.equal((await post(port, { "content-type": "application/json" }, body)).status, 409, "no store");
  assert.equal(hoop.store.list().length, 0, "nothing was written");
  // The same request from a session goes through.
  assert.equal((await post(port, json, body)).status, 200);
  assert.equal(hoop.store.list().length, 1);
});

test("a command starts the pages process when none runs, and sends its write to it", async () => {
  const home = tempHome(),
    port = await freePort();
  const file = join(mkdtempSync(join(tmpdir(), "hoop-doc-")), "doc.md");
  writeFileSync(file, markdown);
  const env = { ...process.env, HOOP_HOME: home, HOOP_PORT: String(port), HOOP_PAGES: "on" };
  const { stdout } = await run(process.execPath, [...hoopArgs, "submit", file, "--json"], { env, timeout: 30_000 });
  const info = (await fetch(`http://127.0.0.1:${port}/api/info`).then((r) => r.json())) as { pid: number; store: string };
  after(() => {
    try {
      process.kill(info.pid);
    } catch {
      /* gone */
    }
  });
  assert.equal(info.store, storeKey(home));
  assert.notEqual(info.pid, process.pid);
  const { review_id } = JSON.parse(stdout);
  assert.equal(new Store(home).meta(review_id).owner?.session, TEST_SESSION);
});

test("the hooks drop their write when no pages process answers, quietly and without starting one", async () => {
  const home = tempHome(),
    port = await freePort();
  const env = { ...process.env, HOOP_HOME: home, HOOP_PORT: String(port), HOOP_PAGES: "on" };
  const hook = (command: string, input: unknown) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = execFile(process.execPath, [...hoopArgs, command], { env, timeout: 20_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
      );
      child.stdin!.end(JSON.stringify(input));
    });
  const pr = await hook("pr-hook", {
    session_id: "hook-session",
    tool_input: { command: "gh pr create --fill" },
    tool_response: { stdout: "https://github.com/acme/app/pull/7\n" },
  });
  assert.deepEqual(pr, { code: 0, out: "" });
  const work = await hook("work-hook", {
    session_id: "hook-session",
    hook_event_name: "PostToolUse",
    tool_name: "TaskCreate",
    tool_input: { subject: "Write tests" },
    tool_response: { task: { id: "1", subject: "Write tests" } },
  });
  assert.deepEqual(work, { code: 0, out: "" });
  assert.equal(existsSync(join(home, "prs.json")), false);
  assert.equal(existsSync(join(home, "work")), false);
  // Neither started a pages process.
  assert.equal(
    await fetch(`http://127.0.0.1:${port}/api/info`).then(
      () => "answered",
      () => "none",
    ),
    "none",
  );
});
