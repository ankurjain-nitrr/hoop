import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Hoop, HoopError, PORT } from "./hoop.js";
import { ensurePages } from "./pages.js";
import { registerSession } from "./sessions.js";
import { repoDir } from "./util.js";
import { audit } from "./audit.js";
import { OPS, oldNameNotice, type Op } from "./ops.js";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value ?? null, null, 2) }] };
}

function failure(err: unknown, tool: string, args: Record<string, unknown>) {
  const body = err instanceof HoopError ? { error: err.message, errors: err.errors } : { error: String(err) };
  // Claude's failed calls are the main signal for improving hoop's tools and their descriptions.
  if (!(err instanceof HoopError && err.audited))
    audit(tool.replace(/^hoop_/, ""), {
      ok: false,
      actor: "claude",
      review_id: typeof args.review_id === "string" ? args.review_id : undefined,
      error: body.error,
      errors: (body as { errors?: { path: string; message: string }[] }).errors?.map((e) => `${e.path}: ${e.message}`),
    });
  return { ...result(body), isError: true };
}

/** One MCP tool per operation in `OPS`, named `hoop_<name>`, plus each old name. */
export function createServer(hoop = new Hoop()): McpServer {
  const server = new McpServer({ name: "hoop", version: "0.1.0" });
  for (const op of OPS) {
    register(server, hoop, op, `hoop_${op.name}`, op.title, op.description, op.input);
    for (const old of op.old?.tools ?? [])
      register(server, hoop, op, `hoop_${old}`, `${op.title} (old name)`, `Old name of hoop_${op.name}. ${op.description}`, op.input, `hoop_${old}`);
  }
  return server;
}

function register(server: McpServer, hoop: Hoop, op: Op, name: string, title: string, description: string, inputSchema: Op["input"], old?: string) {
  server.registerTool(name, { title, description, inputSchema }, async (args: Record<string, unknown>) => {
    try {
      const pages = op.link ? (await ensurePages(hoop.store.home, PORT, { wait: true })).notice : undefined;
      let value = await op.run(hoop, args, { actor: "claude" });
      if (old && value && typeof value === "object") value = { notice: oldNameNotice(old, `hoop_${op.name}`), ...value };
      // A link whose pages can't be served still comes back, with the reason beside it.
      return result(pages && value && typeof value === "object" ? { ...value, pages } : value);
    } catch (err) {
      return failure(err, name, args);
    }
  });
}

/** MCP on stdio. The session records itself, and makes sure a background process serves the pages. */
export async function runMcp(hoop = new Hoop()) {
  const remove = registerSession(hoop.store.home, repoDir());
  // A signal ends the process without "exit", so remove the session first, then end as the signal would.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(sig, () => {
      remove();
      process.kill(process.pid, sig);
    });
  await ensurePages(hoop.store.home);
  await createServer(hoop).connect(new StdioServerTransport());
}
