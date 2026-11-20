import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { strays } from "../scripts/web-types.mjs";

const root = "/repo";
const include = ["web/fold.js", "web/frame.js"];

test("web-types counts only the checked modules' own declarations as wanted", () => {
  const output = [`TSFILE: ${join(root, "web/fold.d.ts")}`, `TSFILE: ${join(root, "web/frame.d.ts")}`, "web/fold.js(1,1): error TS0000: shown as is"].join(
    "\n",
  );
  assert.deepEqual(strays(output, include, root), []);
});

test("web-types names each declaration written outside the checked modules, as a stub importing src makes (regression)", () => {
  // A checked module that imported web/activity.js, whose stub imports src, wrote a declaration
  // beside every src file it reached.
  const output = [`TSFILE: ${join(root, "web/fold.d.ts")}`, `TSFILE: ${join(root, "src/work.d.ts")}`, `TSFILE: ${join(root, "web/build-history.d.ts")}`].join(
    "\n",
  );
  assert.deepEqual(strays(output, include, root), ["src/work.d.ts", "web/build-history.d.ts"]);
});
