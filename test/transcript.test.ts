import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { follow, parseEntry, tailLines } from "../src/transcript.js";

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

const FIXTURE = new URL("./fixtures/work-transcript.jsonl", import.meta.url).pathname;

test("parseEntry reads each recorded entry, and gives none for a blank, cut or non-object line", () => {
  const entries = readFileSync(FIXTURE, "utf8").split("\n").map(parseEntry);
  assert.deepEqual(
    entries.slice(0, 3).map((e) => e?.type),
    ["user", "assistant", "user"],
  );
  assert.equal(entries.filter(Boolean).length, 11, "eleven whole entries");
  assert.equal(parseEntry("{ not json"), undefined, "the fixture's last line is cut short");
  for (const line of ["", "   ", "null", "[1]", '"text"', "3"]) assert.equal(parseEntry(line), undefined, line);
});

test("tailLines gives a file's last whole lines, reading further back for a long last line, up to its limit", () => {
  const whole = readFileSync(FIXTURE, "utf8");
  assert.deepEqual(tailLines(FIXTURE, 1 << 20), whole.split("\n"), "a small file is read whole");
  const end = tailLines(FIXTURE, 200);
  assert.ok(end.length > 0 && whole.endsWith(end.join("\n")), "a read from mid-file drops its cut first line");
  assert.ok(whole.split("\n").includes(end[0]!), "every line it gives is whole");
  const long = join(mkdtempSync(join(tmpdir(), "hoop-tail-")), "long.jsonl");
  writeFileSync(long, `{"type":"user"}\n${"x".repeat(5000)}`);
  assert.deepEqual(tailLines(long, 100), ['{"type":"user"}', "x".repeat(5000)], "a single long last line is read from further back, here to the start");
  assert.deepEqual(tailLines(long, 100, 100), [], "but not past the limit");
});
