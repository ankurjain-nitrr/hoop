import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Hoop, HoopError, PORT } from "./hoop.js";
import { ensurePages } from "./pages.js";
import { generatedAgent } from "./owner.js";
import { registerSession } from "./sessions.js";
import { repoDir } from "./util.js";
import { OPS, type Op } from "./ops.js";

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
- When a flow, architecture, sequence, state machine, data model or timeline is easier to see than to read, include a diagram as a \`\`\`mermaid fenced block; hoop draws it on the review page. Keep it small and labeled; the prose stays the source of truth.
- Submit it with hoop_submit and give the person the link in chat, with one line on what to review.

Building a document together:
When the person asks to build, draft or write a document with you ("help me build a document", "let's kick-start a doc on X", "build it with me"), don't write the whole document, and ask nothing first. Build it with them on the page:
1. Start a build with hoop_build from only a working title (a # heading), with the notes they already gave as a paragraph under it, if any, and give them the link. On the build page they lay out the document by hand, or ask you to suggest an outline, the next section or subsections, and press Generate on a section for its text.
2. Call hoop_build_wait, again whenever it says again: true. For a request of kind "write", write the section with hoop_build_write, from their note and the sections around it; write one section per request, and several at once only when they ask. For kinds "outline", "next" and "subsections", suggest headings with hoop_build_suggest, each with one line on what it covers, from their note and the document; they accept, edit or dismiss each.
3. When they press Finish, hoop_build_wait says finished: the build is now a review of the whole document. Wait on it with hoop_wait, as below.

The loop:
- After you submit, tell the person the link once, then call hoop_wait with the review's cursor, again whenever it says again: true, until a review arrives. Don't repeat the link while you wait.
- It's fine to end your turn instead of waiting: when the person submits their review, hoop sends your Claude Code session a message naming the review, and you read it with hoop_feedback.
- Read the feedback, which hoop_wait returns and hoop_feedback reads again. Answer every comment: reply with hoop_reply, revise by submitting again with the same review_id, or propose exact edits with hoop_propose_edits. Answers to questions come with the feedback; choice "other" carries the person's own words, and recommended: true means the person approved without answering, so hoop took your recommended option; treat it as accepted, not as their pick.
- Repeat until the verdict is approved. Go on only after an approval. A request for changes or a comment means revise and ask again.

Rules:
- Only a person approves or requests changes, on the review page. Never try to approve for them, and don't ask other agents to review a document.
- Everything that waits on the person goes into hoop as well as being said in chat.
- After you open a pull request any way other than \`gh pr create\`, call hoop_track_pr with its URL, so the person sees it on hoop's Home.
- After approval, save the text elsewhere (a file in the project, a document) only when the person asks; hoop_export gives the exact markdown.

Your todo list:
- When you keep a todo list and the person uses hoop's Work view, take the next queued todo in the order the Work view shows it. hoop_work_queue lists your queued todos in that order; when person_order is true, the person reordered them, so start the first one. If you think another should go first, ask the person instead of starting it.`;

/** One MCP tool per operation in `OPS`, named `hoop_<name>`. */
export function createServer(hoop = new Hoop()): McpServer {
  const server = new McpServer({ name: "hoop", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  for (const op of OPS) register(server, hoop, op);
  return server;
}

function register(server: McpServer, hoop: Hoop, op: Op) {
  const { title, description, input: inputSchema } = op;
  server.registerTool(`hoop_${op.name}`, { title, description, inputSchema }, async (args: Record<string, unknown>) => {
    try {
      // An agent other than Claude Code may name no session, so each server process (one per
      // conversation) makes one, named after the client that connected.
      if (!hoop.session) hoop.adopt(generatedAgent(server.server.getClientVersion()?.name));
      const pages = op.link ? (await ensurePages(hoop.store.home, PORT, { wait: true })).notice : undefined;
      const value = await op.run(hoop, args, { actor: "claude" });
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
