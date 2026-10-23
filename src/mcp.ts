import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Hoop, HoopError, PORT } from "./hoop.js";
import { ensurePages } from "./pages.js";
import { generatedAgent } from "./owner.js";
import { registerSession } from "./sessions.js";
import { repoDir } from "./util.js";
import { OPS, oldNameNotice, type Op } from "./ops.js";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value ?? null, null, 2) }] };
}

function failure(err: unknown) {
  const body = err instanceof HoopError ? { error: err.message, errors: err.errors } : { error: String(err) };
  return { ...result(body), isError: true };
}

/** What every session learns about hoop when it connects, so it works with no skill installed. */
export const INSTRUCTIONS = `hoop keeps a person in the loop on what you write. Use it whenever you write something a person should review or decide on before you act: a plan, a design, requirements, a decision, a strategy, a policy or any document. Also use it when you need the person to choose between options.

How to ask for a review:
- Write the document as markdown. The first "#" heading is its title: say what the decision or change is, not "Review this". The first paragraph is its summary: two sentences on what the person is reviewing and why it matters.
- Pick the document's shape for the task; there is no template.
- Ask each question that needs the person's answer inside the document, as a section headed "## Question: <question>?" with two to four list items as options ("- A. ...", "- B. ..."), and mark your recommendation with "(recommended)" at the end of its item. Don't ask questions about a document only in chat.
- Submit it with hoop_submit and give the person the link in chat, with one line on what to review.

The loop:
- Call hoop_wait with the review's cursor, again whenever it says again: true, until a review arrives.
- Read the feedback, which hoop_wait returns and hoop_feedback reads again. Answer every comment: reply with hoop_reply, revise by submitting again with the same review_id, or propose exact edits with hoop_propose_edits. Answers to questions come with the feedback; choice "other" carries the person's own words, and recommended: true means the person approved without answering, so hoop took your recommended option; treat it as accepted, not as their pick.
- Repeat until the verdict is approved. Go on only after an approval. A request for changes or a comment means revise and ask again.

Rules:
- Only a person approves or requests changes, on the review page. Never try to approve for them, and don't ask other agents to review a document.
- Everything that waits on the person goes into hoop as well as being said in chat.
- After approval, save the text elsewhere (a file in the project, a document) only when the person asks; hoop_export gives the exact markdown.`;

/** One MCP tool per operation in `OPS`, named `hoop_<name>`, plus each old name. */
export function createServer(hoop = new Hoop()): McpServer {
  const server = new McpServer({ name: "hoop", version: "0.1.0" }, { instructions: INSTRUCTIONS });
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
      // An agent other than Claude Code may name no session, so each server process (one per
      // conversation) makes one, named after the client that connected.
      if (!hoop.session) hoop.adopt(generatedAgent(server.server.getClientVersion()?.name));
      const pages = op.link ? (await ensurePages(hoop.store.home, PORT, { wait: true })).notice : undefined;
      let value = await op.run(hoop, args, { actor: "claude" });
      if (old && value && typeof value === "object") value = { notice: oldNameNotice(old, `hoop_${op.name}`), ...value };
      // A link whose pages can't be served still comes back, with the reason beside it.
      return result(pages && value && typeof value === "object" ? { ...value, pages } : value);
    } catch (err) {
      return failure(err);
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
