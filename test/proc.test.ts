import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { uptime } from "node:os";
import { alive, bootId, bootTime, lstartTimes, parseElapsed, processStart, processStarts, sameBoot, sameStart } from "../src/proc.js";

test("alive is true for this process and false for one that has exited", async () => {
  assert.equal(alive(process.pid), true);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
  assert.equal(alive(child.pid!), false);
});

test("the boot time is the same within a process, and a boot ID, where the system gives one, doesn't change", () => {
  assert.ok(Math.abs(bootTime() - (Date.now() - uptime() * 1000)) < 1_000);
  assert.equal(bootId(), bootId());
});

test("processStarts reads several processes at once, and an empty list asks ps nothing", () => {
  assert.deepEqual(processStarts([]), { ran: true, starts: new Map() });
  const { ran, starts } = processStarts([process.pid]);
  if (!ran) return; // no ps on this machine
  assert.ok(Math.abs(starts.get(process.pid)! - (Date.now() - process.uptime() * 1000)) < 5_000);
});

test("an lstart time reads in UTC and in local time, and anything else gives none", () => {
  const utc = Date.parse("2026-10-23T17:11:53Z");
  const times = lstartTimes("Fri Oct 23 17:11:53 2026");
  assert.ok(times.includes(utc), String(times));
  assert.equal(times.length, 2);
  assert.deepEqual(lstartTimes("not a time"), []);
});

test("two boots are the same by boot ID where both have one, else by boot time within two minutes", () => {
  assert.equal(sameBoot({ boot: 0, bootId: "a" }, { boot: 9_999_999, bootId: "a" }), true);
  assert.equal(sameBoot({ boot: 0, bootId: "a" }, { boot: 0, bootId: "b" }), false);
  assert.equal(sameBoot({ boot: 0 }, { boot: 120_000, bootId: "b" }), true);
  assert.equal(sameBoot({ boot: 0 }, { boot: 120_001 }), false);
});

test("the start time comes from ps, and matches this process within a few seconds", () => {
  const t = processStart(process.pid);
  if (t === undefined) return; // no ps on this machine; liveness falls back to the boot time
  assert.ok(Math.abs(t - (Date.now() - process.uptime() * 1000)) < 5_000);
});

test("a start time matches whether ps counts from the wall clock or from boot", () => {
  const started = 1_000_000,
    boot = 400_000;
  // The wall clock stepped 60 seconds forward after the session started.
  assert.equal(sameStart({ started, boot }, { started: started + 60_000, boot: boot + 60_000 }), true, "boot based ps, as on Linux");
  assert.equal(sameStart({ started, boot }, { started, boot: boot + 60_000 }), true, "wall based ps, as on macOS");
  assert.equal(sameStart({ started, boot }, { started: started + 3_600_000, boot }), false, "another process");
});

test("ps elapsed times parse in every form, and anything else is unknown", () => {
  assert.equal(parseElapsed("05:07"), 307);
  assert.equal(parseElapsed("1:02:03"), 3723);
  assert.equal(parseElapsed("2-01:02:03"), 2 * 86400 + 3723);
  assert.equal(parseElapsed("garbage"), undefined);
  assert.equal(parseElapsed(""), undefined);
});

test("the boot relative match needs the same boot, so a process ID reused after a reboot isn't live", () => {
  const entry = { started: 1_000_000, boot: 960_000, bootId: "boot-a" };
  // The next boot: the same offset from boot, a later boot time and another boot identifier.
  assert.equal(sameStart(entry, { started: 9_000_000, boot: 8_960_000, bootId: "boot-b" }), false);
  assert.equal(sameStart(entry, { started: 1_060_000, boot: 1_020_000, bootId: "boot-a" }), true, "a clock step in the same boot");
});
