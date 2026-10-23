import { spawnSync } from "node:child_process";

/** The marketplace that lists hoop's plugin, and the plugin itself. */
export const MARKETPLACE = "ankurjain-nitrr/hoop";
export const PLUGIN = "hoop@hoop";

/** The `claude` commands that install the plugin: the MCP server, the plan hook and the pull request hook. */
export const SETUP: string[][] = [
  ["plugin", "marketplace", "add", MARKETPLACE],
  ["plugin", "install", PLUGIN],
];

const line = (args: string[]) => `claude ${args.join(" ")}`;
const OLD = "If you installed the old hoop-plan plugin, remove it first: claude plugin uninstall hoop-plan@hoop";

/** Whether `claude` runs here. */
function hasClaude(): boolean {
  const r = spawnSync("claude", ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

/**
 * The one-time setup: installs hoop's Claude Code plugin with `claude` when it is on PATH, or
 * prints the commands. With `print`, it only prints them. Returns the exit code.
 */
export function init(opts: { print?: boolean; out?: (s: string) => void } = {}): number {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  if (opts.print || !hasClaude()) {
    out(`${opts.print ? "" : "claude isn't on PATH. "}Run these to install hoop in Claude Code:\n\n${SETUP.map((a) => `  ${line(a)}\n`).join("")}\n${OLD}\n`);
    return 0;
  }
  for (const args of SETUP) {
    out(`hoop: ${line(args)}\n`);
    const r = spawnSync("claude", args, { stdio: "inherit" });
    if (r.error || r.status !== 0) {
      out(`hoop: that failed${r.status === null ? "" : ` (exit ${r.status})`}. Run these yourself:\n\n${SETUP.map((a) => `  ${line(a)}\n`).join("")}`);
      return 1;
    }
  }
  out(`hoop: installed. Start a new Claude Code session to use it.\n${OLD}\n`);
  return 0;
}
