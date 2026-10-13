import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Hoop, HoopError } from "./hoop.js";
import { startWeb } from "./web.js";
import { audit } from "./audit.js";
import { OPS } from "./ops.js";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value ?? null, null, 2) }] };
}

function failure(err: unknown, tool: string, args: Record<string, unknown>) {
  const body = err instanceof HoopError ? { error: err.message, errors: err.errors } : { error: String(err) };
  // Claude's failed calls are the main signal for improving hoop's tools and their descriptions.
  if (!(err instanceof HoopError && err.audited)) audit(tool.replace(/^hoop_/, ""), {
    ok: false, actor: "claude", review_id: typeof args.review_id === "string" ? args.review_id : undefined,
    error: body.error, errors: (body as { errors?: { path: string; message: string }[] }).errors?.map((e) => `${e.path}: ${e.message}`),
  });
  return { ...result(body), isError: true };
}

/** One MCP tool per operation in `OPS`, named `hoop_<name>`. */
export function createServer(hoop = new Hoop()): McpServer {
  const server = new McpServer({ name: "hoop", version: "0.1.0" });
  for (const op of OPS) {
    const name = `hoop_${op.name}`;
    server.registerTool(name, { title: op.title, description: op.description, inputSchema: op.input }, async (args: Record<string, unknown>) => {
      try {
        return result(await op.run(hoop, args, { actor: "claude" }));
      } catch (err) {
        return failure(err, name, args);
      }
    });
  }
  return server;
}

/** MCP on stdio, plus the review pages on localhost (D3: one process serves both). */
export async function runMcp(hoop = new Hoop()) {
  await startWeb(hoop).catch((err) => process.stderr.write(`hoop: review pages unavailable: ${err.message}\n`));
  await createServer(hoop).connect(new StdioServerTransport());
}
