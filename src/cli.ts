#!/usr/bin/env node
import { runMcp } from "./mcp.js";
import { Hoop, PORT } from "./hoop.js";
import { startWeb } from "./web.js";

const USAGE = `Usage: hoop <command>

  mcp    Start the MCP server on stdio and the review pages (for: claude mcp add hoop -- npx hoop mcp)
  serve  Serve the review pages only, on http://localhost:$HOOP_PORT (default 4747)
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
    default:
      process.stdout.write(USAGE);
      process.exitCode = command && command !== "help" && command !== "--help" ? 2 : 0;
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`hoop: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
