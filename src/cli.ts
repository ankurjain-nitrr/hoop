#!/usr/bin/env node
import { runMcp } from "./mcp.js";
import { Hoop, PORT } from "./hoop.js";
import { startWeb } from "./web.js";
import { waitForReview } from "./wait.js";
import { auditPath, readAudit, summarize } from "./audit.js";

const USAGE = `Usage: hoop <command>

  mcp    Start the MCP server on stdio and the review pages (for: claude mcp add hoop -- hoop mcp)
  serve  Serve the review pages only, on http://localhost:$HOOP_PORT (default 4747)
  audit [--since <days>] [--json]
         Summarize ~/.hoop/audit.jsonl: time to verdict, revisions, edit acceptance, top failures.
  wait <review_id> [--timeout <seconds>]
         Wait until a reviewer submits a review (or the review is approved), then print the
         feedback as JSON. Exit 0 on a review, 3 on timeout. Run it in the background.
`;

async function main(argv: string[]) {
  const [command] = argv;
  switch (command) {
    case "mcp":
      return runMcp();
    case "serve": {
      const server = await startWeb(new Hoop());
      process.stdout.write(server ? `hoop: review pages on http://localhost:${PORT}\n` : `hoop: port ${PORT} is already serving hoop\n`);
      return;
    }
    case "audit": {
      const i = argv.indexOf("--since");
      const days = i > 0 ? Number(argv[i + 1]) : undefined;
      if (days !== undefined && !(days > 0)) throw new Error("--since needs a positive number of days");
      const s = summarize(readAudit(), days);
      if (argv.includes("--json")) return void process.stdout.write(JSON.stringify(s, null, 2) + "\n");
      const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
      process.stdout.write([
        `hoop audit (${auditPath()}${days ? `, last ${days} days` : ""})`,
        `  reviews ${s.reviews} · approved ${s.approved} · median minutes to first verdict ${s.median_minutes_to_first_verdict?.toFixed(1) ?? "n/a"} · revisions per review ${s.mean_revisions_per_review?.toFixed(1) ?? "n/a"}`,
        `  suggestions applied ${s.suggestions_applied} · edits proposed ${s.edits.proposed}, accepted ${s.edits.accepted}, rejected ${s.edits.rejected} (${pct(s.edits.acceptance_rate)} accepted, ${s.edits.large_rewrites} large rewrites)`,
        `  failures ${s.failures}${s.top_failures.length ? ":" : ""}`,
        ...s.top_failures.map((f) => `    ${f.count}× ${f.reason}`),
      ].join("\n") + "\n");
      return;
    }
    case "wait": {
      const [, id, flag, value] = argv;
      if (!id) throw new Error("usage: hoop wait <review_id> [--timeout <seconds>]");
      const seconds = flag === "--timeout" ? Number(value) : 0;
      if (flag && (flag !== "--timeout" || !Number.isFinite(seconds) || seconds <= 0)) {
        process.stderr.write("hoop: --timeout needs a positive number of seconds\n");
        process.exitCode = 2;
        return;
      }
      const timeoutMs = seconds * 1000;
      const result = await waitForReview(new Hoop(), id, { timeoutMs });
      if (!result) {
        process.stderr.write(`hoop: no review on ${id} within ${value}s\n`);
        process.exitCode = 3;
        return;
      }
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    default:
      process.stdout.write(USAGE);
      process.exitCode = command && command !== "help" && command !== "--help" ? 2 : 0;
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`hoop: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
