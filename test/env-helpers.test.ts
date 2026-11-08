import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { NO_SESSION } from "../src/rules.js";
import { clearReviews } from "../src/clear.js";
import { claudeDir, pagesPort } from "../src/util.js";
import { tempHome } from "./helpers.js";

/** Runs `fn` with these environment variables set (undefined unsets one), then puts them back. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (all: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  set(vars);
  try {
    return fn();
  } finally {
    set(before);
  }
}

test("pagesPort is HOOP_PORT from the environment it's given, else 4747", () => {
  assert.equal(pagesPort({}), 4747);
  assert.equal(pagesPort({ HOOP_PORT: "4791" }), 4791);
  assert.equal(
    withEnv({ HOOP_PORT: "4792" }, () => pagesPort()),
    4792,
  );
});

test("claudeDir is HOOP_CLAUDE_DIR, else CLAUDE_CONFIG_DIR, else ~/.claude", () => {
  assert.equal(
    withEnv({ HOOP_CLAUDE_DIR: "/a", CLAUDE_CONFIG_DIR: "/b" }, () => claudeDir()),
    "/a",
  );
  assert.equal(
    withEnv({ HOOP_CLAUDE_DIR: undefined, CLAUDE_CONFIG_DIR: "/b" }, () => claudeDir()),
    "/b",
  );
  assert.equal(
    withEnv({ HOOP_CLAUDE_DIR: undefined, CLAUDE_CONFIG_DIR: undefined }, () => claudeDir()),
    join(homedir(), ".claude"),
  );
});

test("the tools that act for a session refuse a process outside one with the same words", async () => {
  const outside = new Hoop(new Store(tempHome()), null);
  const run = (name: string, input: Record<string, unknown>) => async () => {
    await OPS.find((o) => o.name === name)!.run(outside, input as never, { actor: "claude" });
  };
  const refused = { message: NO_SESSION };
  await assert.rejects(run("track_pr", { url: "https://github.com/o/r/pull/1" }), refused);
  await assert.rejects(run("action", { title: "Run the migration", description: "Run it.", done_when: { kind: "manual" } }), refused);
  await assert.rejects(run("action_withdraw", { id: "ac_x", reason: "done" }), refused);
  await assert.rejects(run("work_queue", {}), refused);
});

test("hoop clear names a review that isn't there", async () => {
  await assert.rejects(clearReviews(["rv_nope0000", "--yes"], new Store(tempHome())), { message: "no review rv_nope0000" });
});
