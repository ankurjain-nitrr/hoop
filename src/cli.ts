#!/usr/bin/env node
import { runMcp } from "./mcp.js";
import { Hoop, PORT, reviewUrl } from "./hoop.js";
import { startWeb } from "./web.js";
import { ensurePages, ipv6Held, probe, runPages, watchStale } from "./pages.js";
import { storeKey } from "./sessions.js";
import { waitForReview } from "./wait.js";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { checkInput, OPS, waitingLine, type CliArgs, type Op } from "./ops.js";
import { init } from "./init.js";
import { planReview } from "./plan.js";
import { prHook } from "./prs.js";
import { workHook } from "./work.js";
import { gateOutput, workGate } from "./steer.js";
import { CLEAR_USAGE, clearReviews } from "./clear.js";
import { currentUser, HoopError, hoopHome } from "./util.js";
import { agentFromEnv, sessionFromEnv, validSession } from "./owner.js";

const USAGE = `Usage: hoop <command>

  init [--print] [--yes | --no]
         Install hoop's Claude Code plugin (its MCP server and hooks) with claude, or print the commands.
         Then turn on Claude Code's todo tools for the Work view (CLAUDE_CODE_ENABLE_TODO_TOOLS=1 in
         its settings): it asks on a terminal; --yes or --no answers; otherwise it only says how.
  mcp    Start the MCP server on stdio and the review pages (for: claude mcp add hoop -- hoop mcp)
  serve  Serve the review pages only, on http://localhost:$HOOP_PORT (default 4747)
  wait <review_id> [--after <cursor>] [--timeout <seconds>]
         Wait until a reviewer submits a review (or the review is approved), then print the
         feedback as JSON. Exit 0 on a review, 3 on timeout. Run it in the background.
  ${CLEAR_USAGE}
         Delete one review, or every review of one Claude Code session, for good. Asks first on a
         terminal; otherwise needs --yes. hoop never deletes reviews by itself.
  plan-review
         Claude Code's plan hook: review the plan on stdin in hoop, and print the hook's decision.
  pr-hook
         Claude Code's Bash hook: track the pull request a \`gh pr create\` on stdin opened. Always exits 0.
  work-hook
         Claude Code's hook on the todo and Agent tools and on subagents: record the session's todos
         and subagents on stdin for the Work page. Always exits 0.
  work-gate
         Claude Code's hook before each tool call: refuse a todo a person removed or edited, a todo
         started out of the order a person set, or any tool call of an agent a person stopped, from
         the Work page. Prints the hook's decision.

The same operations as hoop's agent tools (add --json for JSON output):
${commands()}
`;

function commands() {
  return OPS.filter((op) => op.cli)
    .map((op) => `  ${op.cli!.usage}\n         ${op.title}.`)
    .join("\n");
}

/** The operation and its command words for an argument list. */
function findOp(argv: string[]): { op: Op; command: string } | undefined {
  const names = OPS.flatMap((op) => (op.cli ? [{ op, command: op.cli.command }] : []));
  return names.sort((a, b) => b.command.length - a.command.length).find((n) => n.command.split(" ").every((w, i) => argv[i] === w));
}

/** The `--name <value>` flags in a usage line. */
export const valueFlags = (usage: string) => [...usage.matchAll(/--([a-z-]+) </g)].map((m) => m[1]!);

/**
 * Splits arguments into positionals and flags. A flag the command takes always consumes the next
 * argument (so values may start with `--`); `--name=value` works too, `--json` is the only
 * switch, and `--` ends the flags. Any other flag is refused, naming the valid ones.
 */
export function parseArgs(argv: string[], usage: string): CliArgs {
  const takes = valueFlags(usage);
  const pos: string[] = [],
    flags: Record<string, string | true> = {};
  const bad = (message: string) => new HoopError(message, [{ path: "flags", message }]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("="),
      name = a.slice(2, eq < 0 ? undefined : eq);
    if (name === "json" && eq < 0) {
      flags.json = true;
      continue;
    }
    if (!takes.includes(name))
      throw bad(
        `unknown flag --${name}; ${takes.length ? `this command takes ${takes.map((f) => `--${f}`).join(", ")} and --json` : "this command takes only --json"}`,
      );
    if (eq >= 0) {
      flags[name] = a.slice(eq + 1);
      continue;
    }
    if (i + 1 >= argv.length) throw bad(`--${name} needs a value`);
    flags[name] = argv[++i]!;
  }
  return { pos, flags };
}

/** Readable output: top-level values one per line, nested ones as indented JSON. */
function text(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  return Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => (v !== null && typeof v === "object" ? `${k}:\n${JSON.stringify(v, null, 2).replace(/^/gm, "  ")}` : `${k}: ${v}`))
    .join("\n");
}

/** Runs the operation the arguments name, if any: true when one ran. */
async function runOp(argv: string[]): Promise<boolean> {
  const found = findOp(argv);
  if (!found) return false;
  const { op } = found;
  const cli = op.cli!;
  let out: unknown, args: CliArgs | undefined;
  try {
    args = parseArgs(argv.slice(found.command.split(" ").length), cli.usage);
    const hoop = new Hoop(),
      input = checkInput(op, cli.parse(args));
    const pages = op.link ? (await ensurePages(hoop.store.home, PORT, { wait: true })).notice : undefined;
    out = await op.run(hoop, input, { actor: currentUser() });
    if (pages) {
      process.stderr.write(`hoop: ${pages.message}\n`);
      if (out && typeof out === "object") out = { ...out, pages };
    }
  } catch (err) {
    if (!(err instanceof HoopError)) throw err;
    process.stderr.write(`hoop: ${err.message}\n${err.errors.map((e) => `  ${e.path}: ${e.message}\n`).join("")}`);
    if (err.errors.some((e) => e.message === "required")) process.stderr.write(`usage: hoop ${cli.usage}\n`);
    process.exitCode = 1;
    return true;
  }
  const file = typeof args!.flags.out === "string" ? args!.flags.out : undefined;
  if (file) {
    writeFileSync(file, (out as { markdown: string }).markdown);
    out = { ...(out as object), markdown: undefined, written: file };
  }
  process.stdout.write((args!.flags.json ? JSON.stringify(out, null, 2) : text(out)) + "\n");
  return true;
}

/** Commands act on the repository the terminal is in, from any subdirectory. */
function defaultRepo() {
  if (process.env.HOOP_REPO_DIR) return;
  try {
    process.env.HOOP_REPO_DIR = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    /* not in a git repository: the current directory */
  }
}

async function main(argv: string[]) {
  defaultRepo();
  const [command] = argv;
  switch (command) {
    case "init": {
      const flags = argv.slice(1);
      if (flags.some((f) => !["--print", "--yes", "--no"].includes(f)) || (flags.includes("--yes") && flags.includes("--no"))) {
        process.stderr.write("usage: hoop init [--print] [--yes | --no]\n");
        process.exitCode = 2;
        return;
      }
      const todo = flags.includes("--yes") ? "yes" : flags.includes("--no") ? "no" : undefined;
      process.exitCode = await init({ print: flags.includes("--print"), ...(todo ? { todo } : {}) });
      return;
    }
    case "mcp":
      return runMcp();
    case "serve": {
      if (process.env.HOOP_PAGES === "background") return runPages();
      const hoop = new Hoop();
      // A program on the IPv6 loopback address would answer this server's localhost links.
      if (await ipv6Held(PORT)) return void process.stdout.write(`hoop: another program holds port ${PORT}; set HOOP_PORT to use another port\n`);
      const server = await startWeb(hoop, PORT, { stale: watchStale(hoop) });
      if (server) return void process.stdout.write(`hoop: review pages on http://localhost:${PORT}\n`);
      const held = await probe();
      const ours = held.kind === "old" || (held.kind === "pages" && held.info.store === storeKey(new Hoop().store.home));
      process.stdout.write(
        ours
          ? `hoop: port ${PORT} is already serving hoop\n`
          : held.kind === "pages"
            ? `hoop: another hoop store serves port ${PORT}; set HOOP_PORT to use another port\n`
            : `hoop: another program holds port ${PORT}; set HOOP_PORT to use another port\n`,
      );
      return;
    }
    case "wait": {
      const [, id, ...rest] = argv;
      const usage = "usage: hoop wait <review_id> [--after <cursor>] [--timeout <seconds>]";
      if (!id) throw new Error(usage);
      const opts: { after?: string; seconds?: number } = {};
      for (let i = 0; i < rest.length; i += 2) {
        const [flag, value] = [rest[i], rest[i + 1]];
        if (flag === "--timeout" && Number.isFinite(Number(value)) && Number(value) > 0) opts.seconds = Number(value);
        else if (flag === "--after" && /^\d+\.\d+$/.test(value ?? "")) opts.after = value;
        else {
          process.stderr.write(
            flag === "--timeout"
              ? "hoop: --timeout needs a positive number of seconds\n"
              : flag === "--after"
                ? "hoop: --after needs a cursor such as 1.0, from a submit, feedback or wait result\n"
                : `hoop: ${usage}\n`,
          );
          process.exitCode = 2;
          return;
        }
      }
      const hoop = new Hoop();
      const meta = hoop.store.meta(id);
      // stdout carries only the feedback's JSON; the line for the person goes to stderr.
      process.stderr.write(`hoop: ${waitingLine(meta.title, reviewUrl(meta.id))}
`);
      const result = await waitForReview(hoop, id, { timeoutMs: (opts.seconds ?? 0) * 1000, after: opts.after });
      if (!result) {
        process.stderr.write(`hoop: no review on ${id} within ${opts.seconds}s\n`);
        process.exitCode = 3;
        return;
      }
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    case "clear": {
      try {
        process.exitCode = await clearReviews(argv.slice(1));
      } catch (err) {
        if (!(err instanceof HoopError)) throw err;
        process.stderr.write(`hoop: ${err.message}\n`);
        process.exitCode = 2;
      }
      return;
    }
    case "plan-review": {
      // Claude Code's ExitPlanMode hook: the hook's input on stdin, its decision as JSON on stdout.
      const input = JSON.parse(readFileSync(0, "utf8") || "{}");
      // A hook runs in its Claude Code session, which the hook's input names too.
      const hoop = new Hoop(undefined, agentFromEnv() ?? validSession(input.session_id) ?? null);
      await ensurePages(hoop.store.home, PORT, { wait: true });
      const waitMs = Number(process.env.HOOP_PLAN_WAIT_SECONDS ?? 540) * 1000;
      process.stdout.write(`${JSON.stringify(await planReview(input, hoop, { waitMs }))}\n`);
      return;
    }
    case "pr-hook": {
      // Claude Code's PostToolUse hook on Bash: it never fails the tool call, so every error is quiet.
      try {
        prHook(hoopHome(), JSON.parse(readFileSync(0, "utf8") || "{}"), sessionFromEnv());
      } catch {
        /* unreadable input */
      }
      return;
    }
    case "work-hook": {
      // Claude Code's hooks on the todo tools, the Agent tool and subagents: never fail the tool call.
      try {
        workHook(hoopHome(), JSON.parse(readFileSync(0, "utf8") || "{}"));
      } catch {
        /* unreadable input */
      }
      return;
    }
    case "work-gate": {
      // The gate's shell script decides what an error means: it fails open, except for a stopped agent.
      const input = JSON.parse(readFileSync(0, "utf8") || "{}");
      process.stdout.write(`${JSON.stringify(gateOutput(workGate(hoopHome(), input)))}\n`);
      return;
    }
    default:
      if (await runOp(argv)) return;
      process.stdout.write(USAGE);
      process.exitCode = command && command !== "help" && command !== "--help" ? 2 : 0;
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`hoop: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
