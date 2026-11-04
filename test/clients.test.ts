import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock } from "node:test";
import { Hoop } from "../src/hoop.js";
import { parseMarkdown } from "../src/markdown.js";
import { Store } from "../src/store.js";
import { tempHome } from "./helpers.js";
import { CLIENTS, MARGIN_SECONDS } from "../src/clients.js";
import { OPS, WAIT_MAX, WAIT_OTHER, waitSeconds } from "../src/ops.js";

// #212: hoop_wait and hoop_build_wait are checked against each supported client's tool-call limit
// (src/clients.ts), so no client cuts a wait off before it answers.

test("every supported client's default wait ends before the client's own limit, with a margin", () => {
  for (const c of CLIENTS) {
    const wait = waitSeconds({ claude: c.claude });
    assert.ok(
      wait + MARGIN_SECONDS <= c.toolCallSeconds,
      `${c.name}: a ${wait} s wait leaves under ${MARGIN_SECONDS} s before its ${c.toolCallSeconds} s limit`,
    );
  }
  assert.deepEqual(
    CLIENTS.filter((c) => c.claude).map((c) => c.name),
    ["Claude Code"],
    "only Claude Code gets the long wait",
  );
});

test("each client's limit names where it comes from, and only Claude Code is woken by hoop", () => {
  // A source is a page (a URL) and the setting or figure on it, or, for the SDK, the constant by name.
  for (const c of CLIENTS)
    assert.match(c.source, /(https:\/\/\S+: \S.*|@modelcontextprotocol\/sdk: [A-Z_]+)/, `${c.name} says where ${c.toolCallSeconds} s comes from`);
  assert.match(CLIENTS.find((c) => c.name === "Cursor")!.source, /forum report.*publishes no figure/, "Cursor's figure says it is a report");
  assert.deepEqual(
    CLIENTS.filter((c) => c.wakes).map((c) => c.name),
    ["Claude Code"],
  );
  // The README lists the same clients its table does.
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const c of CLIENTS.filter((x) => x.name !== "Claude Code" && !x.name.startsWith("Any client")))
    assert.ok(readme.includes(`**${c.name}**`), `the README's Other agents lists ${c.name}`);
});

test("a wait holds the seconds asked for, else the long wait in Claude Code and the short one elsewhere", () => {
  assert.equal(waitSeconds({ claude: true }), WAIT_MAX);
  assert.equal(waitSeconds({ claude: false }), WAIT_OTHER);
  assert.equal(waitSeconds(null), WAIT_OTHER);
  assert.equal(waitSeconds({ claude: false }, 30), 30);
  assert.equal(waitSeconds({ claude: true }, 30), 30);
});

/**
 * Runs the operation `name` on `review_id` with time mocked, ticking a second at a time until it
 * answers, and gives its answer and how long, in mocked seconds, it held. Nothing really sleeps.
 */
async function heldFor(hoop: Hoop, name: string, review_id: string) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    let answer: unknown;
    let done = false;
    const run = Promise.resolve(OPS.find((o) => o.name === name)!.run(hoop, { review_id }, { actor: "test" })).then((a) => {
      answer = a;
      done = true;
    });
    while (!done && Date.now() < (WAIT_MAX + 60) * 1000) {
      // Lets the wait run up to its next timer, then moves time on by a second.
      await new Promise((r) => setImmediate(r));
      if (!done) mock.timers.tick(1000);
    }
    await run;
    return { answer: answer as { status?: string }, seconds: Date.now() / 1000 };
  } finally {
    mock.timers.reset();
  }
}

// Regression: hoop_build_wait held WAIT_MAX (600 s) for every client, so Codex, Cursor and SDK
// clients, which end a call after about 60 s, cut it off. Both waits now hold 600 s in Claude Code
// and 45 s elsewhere; time is mocked, so the test doesn't sleep.
test("hoop_wait and hoop_build_wait answer pending after 600 s in Claude Code and 45 s elsewhere", async () => {
  for (const claude of [true, false]) {
    const hoop = new Hoop(new Store(tempHome()), { session: claude ? "claude-session-1" : "a1b2c3d4-codex-mcp-client", claude });
    const { review_id: build } = hoop.startBuild("# Plan the export\n\n## Steps\n");
    const { review_id: review } = hoop.submit(parseMarkdown("# Ship the export\n\nWhy it matters.\n\n## Steps\n\nOne.\n"));
    const expected = claude ? WAIT_MAX : WAIT_OTHER;
    for (const [name, id] of [
      ["build_wait", build],
      ["wait", review],
    ] as const) {
      const { answer, seconds } = await heldFor(hoop, name, id);
      assert.equal(answer.status, "pending", `${name}, ${claude ? "Claude Code" : "another client"}`);
      assert.ok(seconds >= expected && seconds <= expected + 2, `${name}, ${claude ? "Claude Code" : "another client"}: held ${seconds} s, not ${expected} s`);
    }
  }
});
