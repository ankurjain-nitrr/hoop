import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, readJsonDir, tryReadJson, writeJson } from "../src/util.js";

const dir = () => mkdtempSync(join(tmpdir(), "hoop-json-"));

test("readJson gives the fallback only for a missing file, and throws on a broken one", () => {
  const d = dir();
  writeFileSync(join(d, "bad.json"), "{");
  writeFileSync(join(d, "ok.json"), '{"a":1}');
  assert.deepEqual(readJson(join(d, "ok.json"), {}), { a: 1 });
  assert.deepEqual(readJson(join(d, "missing.json"), { none: true }), { none: true });
  assert.equal(readJson(join(d, "missing.json"), undefined), undefined);
  assert.throws(() => readJson(join(d, "missing.json")), { code: "ENOENT" });
  assert.throws(() => readJson(join(d, "bad.json"), {}), SyntaxError);
});

test("tryReadJson gives undefined for a missing or broken file", () => {
  const d = dir();
  writeFileSync(join(d, "bad.json"), "not json");
  assert.equal(tryReadJson(join(d, "bad.json")), undefined);
  assert.equal(tryReadJson(join(d, "missing.json")), undefined);
  assert.equal(tryReadJson(d), undefined);
});

test("readJsonDir reads the kept .json files and skips broken ones", () => {
  const d = dir();
  writeFileSync(join(d, "a.1.json"), '{"n":1}');
  writeFileSync(join(d, "a.2.json"), "{");
  writeFileSync(join(d, "b.1.json"), '{"n":3}');
  writeFileSync(join(d, "a.txt"), '{"n":4}');
  mkdirSync(join(d, "a.dir.json"));
  assert.deepEqual(
    readJsonDir(d, (n) => n.startsWith("a.")),
    [["a.1.json", { n: 1 }]],
  );
  assert.deepEqual(
    readJsonDir(d)
      .map(([n]) => n)
      .sort(),
    ["a.1.json", "b.1.json"],
  );
  assert.deepEqual(readJsonDir(join(d, "missing")), []);
});

test("writeJson writes indented or compact JSON with a final newline", () => {
  const d = dir();
  writeJson(join(d, "pretty.json"), { a: [1] });
  writeJson(join(d, "compact.json"), { a: [1] }, { compact: true });
  assert.equal(readFileSync(join(d, "pretty.json"), "utf8"), '{\n  "a": [\n    1\n  ]\n}\n');
  assert.equal(readFileSync(join(d, "compact.json"), "utf8"), '{"a":[1]}\n');
});
