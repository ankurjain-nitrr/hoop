import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  for (const c of CLIENTS) assert.ok(c.source.length > 20, `${c.name} says where ${c.toolCallSeconds} s comes from`);
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

// Regression: hoop_build_wait held WAIT_MAX (600 s) for every client, so Codex, Cursor and SDK
// clients, which end a call after 60 s, cut it off; it now waits as hoop_wait does.
test("hoop_build_wait and hoop_wait say the same default: the long wait in Claude Code, the short one elsewhere", () => {
  for (const name of ["wait", "build_wait"]) {
    const op = OPS.find((o) => o.name === name)!;
    assert.match(op.description, new RegExp(`by default up to ${WAIT_MAX} seconds in Claude Code and ${WAIT_OTHER} elsewhere`), name);
  }
  const source = readFileSync(new URL("../src/ops.ts", import.meta.url), "utf8");
  assert.equal((source.match(/waitSeconds\(hoop\.actor, seconds\)/g) ?? []).length, 2, "both waits take their seconds from waitSeconds");
});
