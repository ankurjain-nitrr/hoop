#!/usr/bin/env node
import { runMcp } from "./mcp.js";

const USAGE = `Usage: hoop <command>

  mcp    Start the MCP server on stdio (for: claude mcp add hoop -- npx hoop mcp)
`;

async function main(argv: string[]) {
  const [command] = argv;
  switch (command) {
    case "mcp":
      return runMcp();
    default:
      process.stdout.write(USAGE);
      process.exitCode = command && command !== "help" && command !== "--help" ? 2 : 0;
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`hoop: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
