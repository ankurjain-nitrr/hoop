import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { channel, sendText, sendToSession } from "../src/deliver.js";
import { fakeSocket, sleep, TEST_SESSION, tempHome } from "./helpers.js";
import { idleSession } from "./builders.js";

test("a session takes a message only when it runs with a messaging socket", () => {
  const home = tempHome();
  assert.deepEqual(channel(home, undefined), { none: "no_session" }, "not running");
  assert.deepEqual(channel(home, idleSession()), { none: "no_session" }, "running without a socket");
  // The tests' own Claude Code folder (HOOP_CLAUDE_DIR) pairs every session with this process's home.
  assert.deepEqual(channel(home, idleSession({ socket: "/tmp/s.sock" })), { socket: "/tmp/s.sock" });
  assert.deepEqual(channel(home, idleSession({ socket: "/tmp/s.sock" }), TEST_SESSION), { socket: "/tmp/s.sock" }, "the owner's own session");
});

test("sendText says whether the message went, with the sender's error when it didn't", async () => {
  const sent: [string, string][] = [];
  assert.deepEqual(await sendText("/s", "hi", async (s, t) => void sent.push([s, t])), { sent: true });
  assert.deepEqual(sent, [["/s", "hi"]]);
  assert.deepEqual(
    await sendText("/s", "hi", async () => {
      throw new Error("refused");
    }),
    { sent: false, error: "refused" },
  );
  const gone = await sendText(join(tempHome(), "none.sock"), "hi");
  assert.equal(gone.sent, false, "a socket nothing listens on fails");
});

test("sendToSession writes one user message line to the session's socket", async () => {
  const sock = await fakeSocket();
  try {
    await sendToSession(sock.path, "Reviewed in hoop.\n\n(hoop-ref st_1)");
    for (let i = 0; i < 50 && !sock.lines.length; i++) await sleep(20);
    assert.deepEqual(
      sock.lines.map((l) => JSON.parse(l)),
      [{ type: "user", message: { role: "user", content: "Reviewed in hoop.\n\n(hoop-ref st_1)" } }],
    );
  } finally {
    sock.close();
  }
});
