import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { benchOptions, median, portFrom, summarize, table, TARGETS, verdictDelay } from "../scripts/bench.js";

// The loop-timing benchmark (scripts/bench.ts, #212) runs only when someone asks for it; these test
// its arithmetic and its options on tiny inputs, and start no hoop process.

test("the median is the middle sample, or the mean of the two middle ones, whatever their order", () => {
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.throws(() => median([]), /no samples/);
});

test("each measure is ok when its median meets its target, and one without a target is only reported", () => {
  const rows = summarize({ "cold start": [900, 100, 200], "page ready": [100, 400, 250], hoop_wait: [1200, 900, 1500] });
  assert.deepEqual(rows, [
    { measure: "cold start", samples: [900, 100, 200], median: 200, max: 900, ok: true },
    { measure: "page ready", samples: [100, 400, 250], median: 250, max: 400, target: 300, ok: true },
    { measure: "hoop_wait", samples: [1200, 900, 1500], median: 1200, max: 1500, target: 1000, ok: false },
  ]);
  assert.deepEqual(TARGETS, { "cold start": undefined, "page ready": 300, hoop_wait: 1000 }, "the targets #212 sets");
  assert.equal(
    table(rows, "from the build (dist/)"),
    [
      "hoop's loop on this machine, from the build (dist/):",
      "cold start  median   200 ms, max   900 ms over 3  (no target)",
      "page ready  median   250 ms, max   400 ms over 3  ok: target 300 ms",
      "hoop_wait   median  1200 ms, max  1500 ms over 3  OVER: target 1000 ms",
    ].join("\n"),
  );
});

test("the options take a sample count from 1 to 50 and --json, and refuse anything else", () => {
  assert.deepEqual(benchOptions([]), { samples: 5, json: false });
  assert.deepEqual(benchOptions(["--samples", "1", "--json"]), { samples: 1, json: true });
  for (const bad of ["0", "51", "2.5", "many"]) assert.throws(() => benchOptions(["--samples", bad]), /--samples takes a whole number from 1 to 50/, bad);
  assert.throws(() => benchOptions(["--loops", "9"]));
});

test("the verdicts land at points spread over hoop_wait's two-second poll", () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => verdictDelay(n, 4)),
    [300, 800, 1300, 1800],
  );
  assert.deepEqual([verdictDelay(1, 1)], [300]);
});

test("the benchmark's ports start at 4791 and skip one in use", async () => {
  const held = createServer();
  await new Promise<void>((r) => held.listen(0, "127.0.0.1", r));
  const port = (held.address() as { port: number }).port;
  try {
    const next = await portFrom(port);
    assert.ok(next > port, `${next} is past the port in use, ${port}`);
  } finally {
    held.close();
  }
  assert.ok((await portFrom()) >= 4791);
});
