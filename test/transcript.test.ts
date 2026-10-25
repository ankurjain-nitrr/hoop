import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { follow } from "../src/transcript.js";

// The shared forward reader: read receipts and requests each read a transcript's bytes once, in
// 1 MB chunks, and go on from where they stopped.

const collect = (path: string, from = 0, midLine = false) =>
  follow(
    path,
    "test",
    from,
    (): string[] => [],
    (seen, line) => void seen.push(line),
    { midLine },
  );

test("the reader keeps a character cut between chunks, reads each line once, and starts again on a rewrite", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hoop-follow-")), "t.jsonl");
  // The euro sign's three bytes straddle the 1 MB chunk boundary.
  const long = `${"x".repeat(1024 * 1024 - 1)}€y`;
  writeFileSync(path, `${long}\nsecond\n`);
  assert.deepEqual(collect(path), [long, "second"]);
  appendFileSync(path, "third\npart");
  assert.deepEqual(collect(path), [long, "second", "third"], "a later call reads on, and leaves a partial line for later");
  appendFileSync(path, "ial\n");
  assert.equal(collect(path)!.at(-1), "partial");
  // A file rewritten to something as long or longer is read again from the start.
  writeFileSync(path, `${"z".repeat(1024 * 1024 + 20)}\nnew\n`);
  assert.deepEqual(collect(path)!.slice(-1), ["new"]);
  assert.equal(collect(path)!.length, 2);
  // A start inside a line skips that line's rest.
  assert.deepEqual(
    follow(
      path,
      "mid",
      5,
      (): string[] => [],
      (seen, line) => void seen.push(line),
      { midLine: true },
    ),
    ["new"],
  );
  assert.equal(collect(join(path, "missing")), undefined);
});
