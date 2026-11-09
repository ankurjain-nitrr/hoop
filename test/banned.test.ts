import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ID_PREFIXES } from "../src/ids.js";
import { ALLOWED, findBanned, RULES, sources, unallowed } from "../scripts/banned.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const rules = (...names: string[]) => names.map((n) => RULES.find((r) => r.name === n)!);

test("each banned pattern is found outside its owner, and only there", () => {
  const files = [
    { path: "src/util.ts", text: 'JSON.parse(readFileSync(path, "utf8"))' },
    { path: "src/store.ts", text: 'const v = JSON.parse(readFileSync(path, "utf8"));' },
    { path: "src/ids.ts", text: "const id = `rv_${x}`;\nconst re = /rv_[a-z0-9]+/;" },
    { path: "src/hoop.ts", text: "const id = `th_${x}_1`;\nconst other = 'ed_' + y;\nconst re = /^rv_[a-z0-9]+$/;" },
    { path: "web/blocks.js", text: "const ATX = /^#{1,6}/;\nconst F = /^(```|~~~)/;" },
    { path: "web/build.js", text: "const h = /^\\s{0,3}#{1,6}\\s*/;\nconst m = /^```\\s*mermaid\\s*$/;\nconst f = /(```|~~~)/;" },
    { path: "web/api.js", text: "fetch(path)" },
    { path: "web/app.js", text: "await fetch('/api/reviews');" },
    { path: "src/web.ts", text: 'import { a } from "../web/blocks.js";\nimport { b } from "../web/app.js";' },
    { path: "scripts/lib.ts", text: 'JSON.parse(readFileSync(p, "utf8"))' },
  ];
  const found = findBanned(files).map((f) => `${f.rule} ${f.file}:${f.line}`);
  assert.deepEqual(found.sort(), [
    "fence or Mermaid regex web/build.js:2",
    "fence or Mermaid regex web/build.js:3",
    "hand-built ID src/hoop.ts:1",
    "hand-built ID src/hoop.ts:2",
    "heading regex web/build.js:1",
    "raw JSON file read src/store.ts:1",
    "raw fetch in a page web/app.js:1",
    "review ID regex src/hoop.ts:3",
    "server importing a page module src/web.ts:2",
  ]);
});

test("the hand-built ID rule knows every prefix hoop makes IDs with", () => {
  const made = new Set<string>();
  for (const f of sources(root)) for (const m of f.text.matchAll(/\b(?:newId|idPattern|childPattern|childId)\(\s*"([a-z]+)"/g)) made.add(m[1]!);
  for (const kind of readFileSync(join(root, "src/ids.ts"), "utf8")
    .match(/type ChildKind = ([^;]+);/)![1]!
    .matchAll(/"([a-z]+)"/g))
    made.add(kind[1]!);
  assert.ok(made.size >= 8, [...made].join(", "));
  for (const p of made) assert.ok((ID_PREFIXES as readonly string[]).includes(p), `${p}_ IDs: add "${p}" to ID_PREFIXES in src/ids.ts`);
  const rule = rules("hand-built ID");
  for (const p of ID_PREFIXES) {
    assert.equal(findBanned([{ path: "src/x.ts", text: `const id = \`${p}_\${n}\`;` }], rule).length, 1, p);
    assert.equal(findBanned([{ path: "src/x.ts", text: `const id = "${p}_" + n;` }], rule).length, 1, p);
  }
});

test("an allowed use counts up to its number, and one more in the same file is a finding", () => {
  const text = "/#{1,6}/\n/#{1,6}/";
  const found = findBanned([{ path: "src/ops.ts", text }], rules("heading regex"));
  assert.equal(found.length, 2);
  const allowed = { "heading regex": { "src/ops.ts": { count: 1, why: "test" } } };
  assert.deepEqual(
    unallowed(found, allowed).map((f) => f.line),
    [2],
  );
});

test("hoop's own source has no banned pattern outside its owner, and every allowed use is still there", () => {
  const found = findBanned(sources(root));
  assert.deepEqual(unallowed(found), [], "a new use belongs in its owner, or in ALLOWED with its reason");
  for (const [rule, files] of Object.entries(ALLOWED))
    for (const [file, { count }] of Object.entries(files))
      assert.equal(found.filter((f) => f.rule === rule && f.file === file).length, count, `${rule} in ${file}: update ALLOWED`);
});
