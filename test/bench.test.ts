import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { benchOptions, FIRST_PORT, MIN_SPREAD, median, POLL_MS, portFrom, summarize, table, TARGETS, verdictDelay } from "../scripts/bench-stats.js";

// The loop-timing benchmark (scripts/bench.ts, #212) runs only when someone asks for it. These test
// its arithmetic and options (scripts/bench-stats.ts) on tiny inputs; they start no process and
// leave nothing in the temp folder.

test("the median is the middle sample, or the mean of the two middle ones, whatever their order", () => {
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.throws(() => median([]), /no samples/);
});

const six = { "cold start": [900, 100, 200, 300, 250, 150], "page ready": [100, 400, 250, 120, 130, 140], hoop_wait: [1200, 900, 1500, 1100, 1000, 1300] };

test("each judged measure is ok when its median meets its target, and one without a target is only reported", () => {
  const rows = summarize(six);
  assert.deepEqual(
    rows.map((r) => [r.measure, r.median, r.max, r.target, r.ok, r.judged]),
    [
      ["cold start", 225, 900, undefined, true, false],
      ["page ready", 135, 400, 300, true, true],
      ["hoop_wait", 1150, 1500, 1000, false, true],
    ],
  );
  assert.deepEqual(TARGETS, { "cold start": undefined, "page ready": 300, hoop_wait: 1000 }, "the targets #212 sets");
  assert.equal(
    table(rows, "from the build (dist/)"),
    [
      "hoop's loop on this machine, from the build (dist/):",
      "cold start  median   225 ms, max   900 ms over 6  (no target)",
      "page ready  median   135 ms, max   400 ms over 6  ok: target 300 ms",
      "hoop_wait   median  1150 ms, max  1500 ms over 6  OVER: target 1000 ms",
      "",
      "cold start: starting hoop serve to its first answer.",
      "page ready: the review page's HTML and its review JSON, on a warm server; no JS, CSS or drawing.",
      "hoop_wait: the verdict sent to hoop_wait returning it.",
      "hoop_wait checks for a verdict every 2 s; the verdicts land evenly across one check, so half of that (1000 ms) is the poll's share of its median, and the rest is this machine's.",
    ].join("\n"),
  );
});

test("with too few samples to spread over hoop_wait's poll, hoop_wait is reported but not judged", () => {
  const few = { "cold start": [100, 200, 300], "page ready": [100, 120, 140], hoop_wait: [1900, 1950, 2000] };
  const rows = summarize(few);
  const wait = rows.find((r) => r.measure === "hoop_wait")!;
  assert.deepEqual([wait.judged, wait.ok], [false, true], "it doesn't fail the run");
  assert.match(
    table(rows, "x"),
    /hoop_wait {3}median {2}1950 ms, max {2}2000 ms over 3 {2}\(not judged: fewer than 4 samples to spread over hoop_wait's poll; target 1000 ms\)/,
  );
  assert.equal(MIN_SPREAD, 4);
  // page ready is still judged with one sample.
  assert.equal(summarize({ "cold start": [1], "page ready": [400], hoop_wait: [1] }).find((r) => r.measure === "page ready")!.ok, false);
});

test("the options take a sample count from 1 to 50 and --json, and refuse anything else", () => {
  assert.deepEqual(benchOptions([]), { samples: 6, json: false });
  assert.deepEqual(benchOptions(["--samples", "1", "--json"]), { samples: 1, json: true });
  for (const bad of ["0", "51", "2.5", "many"]) assert.throws(() => benchOptions(["--samples", bad]), /--samples takes a whole number from 1 to 50/, bad);
  assert.throws(() => benchOptions(["--loops", "9"]));
});

test("the verdicts land in the middle of equal slices of one poll, so its share of the median doesn't hang on the sample count", () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => verdictDelay(n, 4)),
    [550, 1050, 1550, 2050],
  );
  // However many samples, the time each verdict waits for the next check averages half a poll.
  for (const of of [4, 5, 6, 7, 10]) {
    const waits = Array.from({ length: of }, (_, i) => POLL_MS - ((verdictDelay(i + 1, of) - 300) % POLL_MS));
    assert.ok(Math.abs(waits.reduce((a, b) => a + b, 0) / of - POLL_MS / 2) <= 1, `${of} samples`);
    assert.ok(Math.abs(median(waits) - POLL_MS / 2) <= POLL_MS / of / 2 + 1, `${of} samples: the median`);
  }
});

const listen = (host: string, port = 0) =>
  new Promise<Server | undefined>((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(undefined));
    s.listen(port, host, () => resolve(s));
  });

test("the benchmark's ports start at 4791 and skip one held on 127.0.0.1 or on ::1", async () => {
  assert.equal(FIRST_PORT, 4791);
  const v4 = (await listen("127.0.0.1"))!;
  const port = (v4.address() as { port: number }).port;
  // The next port, held on ::1 only, where the machine has IPv6.
  const v6 = await listen("::1", port + 1);
  try {
    const next = await portFrom(port);
    assert.ok(next > port, `${next} skips the port held on 127.0.0.1, ${port}`);
    if (v6) assert.ok(next > port + 1, `${next} skips the port held on ::1, ${port + 1}`);
  } finally {
    v4.close();
    v6?.close();
  }
});
