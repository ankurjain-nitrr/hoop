#!/usr/bin/env node
// A stand-in for `claude` in test/evals.test.ts: logs its arguments to FAKE_LOG and plays one entry of
// FAKE_PLAN (a JSON array, one entry per run, the last one repeated) as stream-json. An entry may
// submit a markdown review through HOOP_BIN, print a hoop_feedback call, end with a result, or hang.
import { execSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === "purge") process.exit(0);
const runs = readFileSync(process.env.FAKE_LOG, "utf8").split("\n").filter((l) => l && !l.startsWith('["purge"')).length;
const plan = JSON.parse(process.env.FAKE_PLAN);
const entry = plan[Math.min(runs, plan.length) - 1];
const say = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const call = (id, name, input, result) => {
  say({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__plugin_hoop_hoop__${name}`, input } ] } });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: result }] }] } });
};
say({ type: "system", subtype: "init", model: "fake" });
if (entry.submit) {
  const file = join(tmpdir(), `fake-claude-${process.pid}.md`);
  writeFileSync(file, entry.submit);
  const out = execSync(`${process.env.HOOP_BIN} submit ${file}`, { env: { ...process.env, HOOP_SESSION: "fake-session-0001" }, encoding: "utf8" });
  call(`s${runs}`, "hoop_submit", { markdown: entry.submit }, out);
}
if (entry.feedback) call(`f${runs}`, "hoop_feedback", {}, "{}");
if (entry.hang) setInterval(() => {}, 1000);
else say({ type: "result", subtype: entry.subtype ?? "success", num_turns: entry.turns ?? 1, total_cost_usd: entry.cost ?? 0 });
