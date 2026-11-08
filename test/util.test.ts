import { test } from "node:test";
import assert from "node:assert/strict";
import { count, obj, oneLine, quote, sha256 } from "../src/util.js";

test("obj is a plain object or undefined", () => {
  const o = { a: 1 };
  assert.equal(obj(o), o);
  for (const v of [null, undefined, [], "x", 3, true]) assert.equal(obj(v), undefined, String(v));
});

test("oneLine joins white space into one space, trims, and cuts at max with an ellipsis", () => {
  assert.equal(oneLine("  one\n\ttwo   three  "), "one two three");
  assert.equal(oneLine("abcdef", 6), "abcdef");
  assert.equal(oneLine("abcdefg", 6), "abcde…");
  assert.equal(oneLine("a\n\n".repeat(100), 10), "a a a a a…");
  assert.equal(oneLine("   "), "");
});

test("quote puts one line in straight double quotes", () => {
  assert.equal(quote(" Ship\non  Friday "), '"Ship on Friday"');
});

test("count is singular only for one", () => {
  assert.deepEqual(
    [0, 1, 2].map((n) => count(n, "comment")),
    ["0 comments", "1 comment", "2 comments"],
  );
});

test("sha256 is the hex digest", () => {
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
