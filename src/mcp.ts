import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Hoop, HoopError, PORT } from "./hoop.js";
import { clientHoop, runOp } from "./remote.js";
import { ensurePages } from "./pages.js";
import { generatedAgent } from "./owner.js";
import { registerSession } from "./sessions.js";
import { repoDir } from "./util.js";
import { OPS, type Op } from "./ops.js";
import { ownInstall, release } from "./version.js";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value ?? null, null, 2) }] };
}

function failure(err: unknown) {
  const body = err instanceof HoopError ? { error: err.message, errors: err.errors, ...(err.detail ? { detail: err.detail } : {}) } : { error: String(err) };
  return { ...result(body), isError: true };
}

/** What every session learns about hoop when it connects, so it works with no skill installed. */
export const INSTRUCTIONS = `hoop keeps a person in the loop on what you write. Use it whenever you write something a person should review or decide on before you act: a plan, a design, requirements, a decision, a strategy, a policy or any document. Also use it when you need the person to choose between options.

How to ask for a review:
- Write the document as markdown. The first "#" heading is its title: say what the decision or change is, not "Review this". A short line in italics right under the title, such as "*Q4 plan for the billing migration*" (at most 120 characters, not a sentence ending in a period), is an optional subtitle. The first paragraph is its summary: two sentences on what the person is reviewing and why it matters.
- Pick the document's shape for the task; there is no template.
- Write for the person deciding: describe behaviour, choices and how you'll know it works. Leave out file names, functions and line counts unless the decision is about them; they belong in the pull requests.
- Ask each question that needs the person's answer inside the document, as a section headed "## Question: <question>?" with two to four list items as options ("- A. ...", "- B. ..."), and mark your recommendation with "(recommended)" at the end of its item. Don't ask questions about a document only in chat.
- When a flow, architecture, sequence, state machine, data model or timeline is easier to see than to read, include a diagram as a \`\`\`mermaid fenced block; hoop draws it on the review page. Keep it small and labeled; the prose stays the source of truth. When feedback lists diagram_errors, a diagram didn't render for the reviewer: fix it in your next revision.
- Submit it with hoop_submit and give the person the link in chat, with one line on what to review.

Quick questions:
- When a decision blocks your next step and fits in one line ("Keep the old endpoint as an alias, or remove it?"), ask it with hoop_ask instead of writing a document: one to four questions, each with two to four options, exactly one marked recommended, and a sentence or two of context when it helps. For anything the person should read in full before deciding, write a document and submit it with hoop_submit.
- hoop_ask returns at once. Tell the person the link once, in chat, with the question itself, so they can answer from either place. Then wait with hoop_wait on the ask's ID (partial: true returns each answer as it comes), or carry on with work that doesn't depend on the answer and wait later; hoop messages your session when they answer.
- No timeout ever picks your recommendation: only the person answers. An answer with recommended: true means they pressed Go with your recommendation. An answer with corrects is a change to an answer you already read: act on the new one.
- When the question is about a line in an open review, pass anchor (its review_id and the line's words, or item and line): it also shows as a card beside that line, and answering it there doesn't review the document.
- If you no longer need an answer (you found it yourself, or the task changed), withdraw the ask with hoop_withdraw and a one-line reason.
- Never use a quick question to ask the person to approve a document or a plan: approvals happen only on the review page.

Building a document together:
When the person asks to build, draft or write a document with you ("help me build a document", "let's kick-start a doc on X", "build it with me"), don't write the whole document, and ask nothing first. Build it with them on the page:
1. Start a build with hoop_build from only a working title (a # heading), with the notes they already gave as a paragraph under it, if any, and give them the link. On the build page they lay out the document by hand, or ask you to suggest an outline, the next section or subsections, and press Generate on a section for its text.
2. Call hoop_build_wait, again whenever it says again: true. For a request of kind "write", write the section with hoop_build_write, from their note and the sections around it; write one section per request, and several at once only when they ask. For kinds "outline", "next" and "subsections", suggest headings with hoop_build_suggest, each with one line on what it covers, from their note and the document; they accept, edit or dismiss each. For kind "rewrite" (Generate again on one block), write that block again with hoop_build_write and its block ID, following their note if they gave one. For kind "revise", the person commented on a block, often on words they selected: when the comment asks for a change, rewrite the block with hoop_build_write and its block ID, changing only what the comment asks; when it asks a question, answer it with hoop_reply on the request's thread. A rewritten block waits for them to accept or undo it.
3. When they press Finish, hoop_build_wait says finished: the build is now a review of the whole document. Wait on it with hoop_wait, as below.

The loop:
- After you submit, tell the person the link once, then call hoop_wait with the review's cursor, again whenever it says again: true, until a review arrives. Don't repeat the link while you wait.
- It's fine to end your turn instead of waiting: when the person submits their review, hoop sends your Claude Code session a message naming the review, and you read it with hoop_feedback.
- After /clear, your session keeps the reviews, quick questions and action items an earlier conversation in this terminal started, and hoop's message says so. You don't remember that document: read it with hoop_export before you answer the feedback or revise it.
- Read the feedback, which hoop_wait returns and hoop_feedback reads again. Answer every comment: reply with hoop_reply, revise, or propose exact edits with hoop_propose_edits. To revise a few sections, send only those edits with hoop_revise_sections (sections by ID, from sections in your last submit's result or hoop_export's, or the feedback's item), with the same review_id and base_revision (the revision field of the feedback, wait or submit result your edits build on): every other section stays exactly as it was. To rewrite or restructure the document, submit the whole markdown again with hoop_submit, with the same review_id and base_revision. The feedback's threads lists every thread the reviewer hasn't resolved, from any revision, each unanswered, answered or applied (the reviewer applied its suggestion or accepted your edit themselves, so it needs no reply); answer each unanswered one, and when a revision's result lists unanswered_threads, reply in them. A revision's result says in changes which sections hoop found added, removed and modified: check it against what you meant to change, and fix a section you changed or dropped by mistake. On an approved review, reply to a thread when it helps the person, but don't hold up your work on it; a request for changes after approval reopens the review, and you answer it as any review. Answers to questions come with the feedback, with a request for changes; choice "other" carries the person's own words. (On a review approved before hoop required questions to be answered first, recommended: true means hoop took your recommended option; treat it as accepted, not as their pick.)
- hoop refuses a revision built on an older revision (a reviewer's Apply makes a new one) or submitted over feedback you haven't read. The refusal names the latest revision and carries that feedback in detail.unread: read it, answer it, export the latest revision with hoop_export when the refusal says so, and submit again with the base_revision it names.
- When the person answers the questions in a document, revise it: write their decisions into the text and remove the Question sections. hoop lets them approve only a revision with no questions left in it, once they resolved every thread, so the approved text has no open questions. A structured decision document (hoop_submit_decision) works the same way: once the answers arrive, revise the same review with hoop_submit (same review_id and base_revision) into a markdown document that states the decisions, with no questions, for the person to approve.
- Repeat until the verdict is approved. Go on only after an approval. An approval isn't final: the person can still comment, and a request for changes after approval reopens the review (reopened: true in the feedback, with approved_revision naming what they approved). Answer it as any review, and submit a new revision of the same review, which needs approving again. A request for changes means revise and ask again. The verdict comment comes from another session's hoop_comment, or from a person's review in an older hoop, which asks for changes too.

Rules:
- Only a person approves or requests changes, on the review page. Never try to approve for them, and don't ask other agents to review a document.
- Everything that waits on the person goes into hoop as well as being said in chat.
- When hoop's tools can't show something you need, tell the person what's missing; don't read hoop's review files or its code to find out what a review holds.
- After you open a pull request any way other than \`gh pr create\`, call hoop_track_pr with its URL, so the person sees it on hoop's Home.
- After approval, save the text elsewhere (a file in the project, a document) only when the person asks; hoop_export gives the exact markdown.

Action items:
- Whenever something waits on the person and isn't a review (merge a pull request, approve a staged npm release, run a command), add an action item with hoop_action, and say it in chat too. Its title says what to do, not "Review this" or a bare number; its done_when lets hoop check it: pr_merged, review_approved, npm_version, or manual when only the person can tell.
- Never tell the person something is done unless its check shows it done. hoop messages your session "Done: <title>" when it sees an item done, or "Won't do: <title> — <reason>" when the person declines it. Withdraw an item you no longer need with hoop_action_withdraw.

Your todo list:
- When you keep a todo list and the person uses hoop's Work view, take the next queued todo in the order the Work view shows it. hoop_work_queue lists your queued todos in that order; when person_order is true, the person reordered them, so start the first one. If you think another should go first, ask the person instead of starting it.

Agents you start:
- A person's comment on a todo or agent in hoop's Work view names its ID (ch_…). Answer it with hoop_reply on that ID, as well as in chat, while the todo or agent is queued or running: the reply shows under their comment.
- hoop's Work view shows the person each agent you start with the Agent tool, by its description. Write the description as the outcome you want, in plain words ("Fix: deleted PRs stay Pending"), not an internal label.
- Ask each agent to start its final report with one plain sentence on the result ("Opened PR #214: Home shows a deleted PR as Gone."), with the link of any pull request, issue or review it opened. The Work view shows that sentence and those links.`;

/** One MCP tool per operation in `OPS`, named `hoop_<name>`. */
export function createServer(hoop = new Hoop()): McpServer {
  const server = new McpServer({ name: "hoop", version: release(ownInstall()) ?? "0.0.0" }, { instructions: INSTRUCTIONS });
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
      const value = await runOp(hoop, op, args, { actor: "claude", ...(pages ? { pages } : {}) });
      // A link whose pages can't be served still comes back, with the reason beside it.
      return result(pages && value && typeof value === "object" ? { ...value, pages } : value);
    } catch (err) {
      return failure(err);
    }
  });
}

/** MCP on stdio. The session records itself, and makes sure a background process serves the pages, which also takes its writes. */
export async function runMcp(hoop = clientHoop()) {
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
