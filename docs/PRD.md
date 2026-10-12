# hoop: humans in the loop for agent decisions

Status: draft (rev 1) · Owner: Ankur Jain

## TL;DR

Coding agents now make many decisions that need a human: requirements, how work is sliced into
PRs, plans, trade-offs. Code review has a good interface (diffs, line comments, approvals). Every
other decision is reviewed as a wall of text in a terminal. hoop gives those decisions the same
treatment: Claude submits a decision as a structured JSON document over MCP, hoop renders it as a
reviewable page, people approve, choose or comment per item, and Claude reads the feedback back
over MCP. Execution starts only when the plan is approved.

```
Claude ──MCP──▶ hoop server ──▶ store ──▶ web app ──▶ reviewers
   ▲                                                     │
   └──────MCP (feedback, decisions)◀── store ◀───────────┘
```

## 1. Problem

| Problem in the terminal today | Effect |
|---|---|
| Long plans and specs scroll past as plain text | Reviewers skim or rubber-stamp; errors hide in volume |
| No way to comment on one item | Feedback is a free-text reply that mixes many points |
| Choices are limited (AskUserQuestion: up to 4 questions, 4 options, one round at a time) | Big decisions get squeezed or asked serially |
| No diff between revisions of a plan | Reviewers re-read everything to find what changed |
| Single person, synchronous | Teammates, PMs or leads can't weigh in; the session blocks while waiting |
| Decisions live in the conversation | Lost on compaction or a new session; no record of who approved what and why |
| Approval is all or nothing (plan mode: approve or reject) | Can't approve 8 requirements and send back 2 |

Evidence: reviewers can't keep up with agent output and approvals become rubber stamps
([arXiv 2608.23642](https://arxiv.org/html/2608.23642v1)); decision fatigue from coding agents
([Stack Overflow, 2026](https://stackoverflow.blog/2026/05/21/coding-agents-are-giving-everyone-decision-fatigue/));
raw agent output is impractical to review without a scannable format
([Label Studio](https://labelstud.io/blog/how-to-evaluate-ai-agents-in-production/)).

## 2. What exists

| Tool | What it does | Gap for hoop |
|---|---|---|
| Claude Code plan mode, AskUserQuestion | Approve or reject a plan; small multiple-choice rounds | Terminal only, no per-item feedback, no history |
| [Plannotator](https://github.com/backnotprop/plannotator) | Browser review of plans and diffs, inline annotations, plan diffs, local archive | Hook-based, not MCP; markdown, not structured decisions; no multiple choice or per-item verdicts; team mode on a waitlist |
| GitHub PR review of a spec file | Line comments on markdown | Prose diffs are hard to judge; no choices; no agent read-back beyond comments |
| [MCP elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation) | Flat forms inside the MCP client: accept, decline or cancel | Inline and synchronous, flat schema, no review or history |
| [MCP Apps (SEP-1865)](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) | Interactive UI rendered inside an MCP host | Lives in the host's chat, not for other reviewers or the terminal |
| [HumanLayer](https://chatgate.ai/post/humanlayer/) | Approve or deny tool calls via Slack or email | Tool-call gating, not document review |
| [LangGraph interrupts](https://docs.langchain.com/oss/python/langchain/human-in-the-loop) | Approve, edit, reject or respond per tool call | Tied to LangGraph |

The gap: structured, per-item review of agent decisions, outside the terminal, with history,
read back by the agent over MCP.

## 3. Goals and non-goals

Goals
- Any agent decision can be reviewed per item in a browser in under a few minutes.
- Feedback goes back to Claude as structured data, not prose to re-parse.
- Revisions show only what changed.
- Approved decisions are a durable record the agent and people can look up later.
- Execution is gated on approval.

Non-goals (v1)
- Code review of diffs (GitHub and Claude's code review already do it well).
- A project management tool (no tickets, sprints or boards).
- Hosting other people's data: v1 runs locally.

## 4. Users

- **Driver:** the developer working with Claude; reviews most decisions.
- **Reviewer:** a teammate, lead or PM asked to weigh in on a specific decision.
- **Agent:** Claude (or any MCP client) that submits decisions and reads feedback.

## 5. Flow

1. Claude reaches a decision point (for example devloop's `scope` freeze or `slice` map) and calls
   `hoop.submit` with a review document. hoop returns a review ID and URL.
2. Claude tells the user the URL and waits without blocking the session (see 9, "Waiting").
3. Reviewers open the page: TL;DR first, then items. Per item they approve, request a change,
   pick an option, or comment; then submit an overall verdict.
4. Claude calls `hoop.feedback`, gets structured verdicts, and revises. A new revision is submitted
   against the same review; the page shows per-item diffs and which comments it addressed.
5. When the overall verdict is "approved", the review is frozen and Claude proceeds (execution
   starts on plan approval).
6. Later, any session can call `hoop.decisions` to look up what was approved and why.

## 6. JSON contract (v0)

Review document (agent → hoop):

```json
{
  "schema": "hoop/review@0",
  "review_id": null,
  "revision": 1,
  "kind": "requirements | slice_map | plan | questions | decision | doc",
  "title": "Order export: requirements",
  "tldr": "6 requirements, 2 open questions. Streaming is the main risk.",
  "context": { "repo": "acme/orders", "branch": "feat/export", "links": ["..."] },
  "items": [
    {
      "id": "FR-1",
      "type": "requirement | slice | step | question | option | note",
      "title": "Export all orders as CSV",
      "body": "When a client calls GET /orders/export, the system shall ...",
      "check": "integration test streams 100k rows",
      "choices": [{ "id": "a", "label": "CSV", "recommended": true }],
      "risk": "low | medium | high",
      "depends_on": ["FR-0"]
    }
  ],
  "asks": "approve_all | per_item | choose"
}
```

Feedback (hoop → agent):

```json
{
  "schema": "hoop/feedback@0",
  "review_id": "rv_123",
  "revision": 1,
  "verdict": "approved | changes_requested | pending",
  "items": [
    { "id": "FR-1", "verdict": "approve" },
    { "id": "FR-3", "verdict": "change", "comment": "Use created_at, not updated_at",
      "suggestion": "When from/to are given ..." },
    { "id": "Q-2", "choice": "b", "comment": "We have Postgres already" }
  ],
  "general": ["Split FR-5 into its own slice"],
  "reviewers": [{ "name": "ankur", "at": "2026-10-13T10:00:00Z" }]
}
```

## 7. Functional requirements

- FR-1: When an agent calls `hoop.submit` with a valid review document, hoop shall store it and
  return a review ID and URL. Check: contract test with valid and invalid documents.
- FR-2: When a document fails schema validation, hoop shall reject it with field-level errors.
  Check: invalid examples return errors naming the field.
- FR-3: The review page shall show the TL;DR first and each item collapsed to its title, with
  bodies expandable. Check: UI test on a 30-item review.
- FR-4: A reviewer shall be able to approve, request a change on, comment on, or choose an option
  for each item, and submit an overall verdict. Check: UI test round trip.
- FR-5: When an agent calls `hoop.feedback`, hoop shall return the feedback document for the
  latest revision. Check: contract test.
- FR-6: When an agent submits a new revision, the page shall show per-item changes and mark
  comments as addressed or open. Check: UI test with two revisions.
- FR-7: When the overall verdict is "approved", hoop shall freeze that revision; later submits
  create a new review linked to it. Check: submit after approval returns a new review ID.
- FR-8: `hoop wait <review_id>` shall exit when the review gets a verdict, printing the feedback.
  Check: CLI test with a verdict posted mid-wait.
- FR-9: When an agent calls `hoop.decisions` with a query, hoop shall return approved items
  matching it, with review, revision and approver. Check: search test.
- FR-10: An approved review shall be exportable as markdown to the repo (for example
  `docs/specs/<slug>.md`). Check: export matches a golden file.

## 8. Non-functional requirements

- NFR-1: Local first. One command starts the MCP server and web app on localhost; no data leaves
  the machine by default.
- NFR-2: Reviewer comments are untrusted input to the agent: feedback is returned as data, and the
  agent treats it as review input, not instructions that override the user.
- NFR-3: A 50-item review renders in under a second.
- NFR-4: The contract is versioned (`hoop/review@0`); servers accept the previous version.

## 9. Open decisions

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | Stack | TypeScript (official MCP SDK, one language front and back) · Python | TypeScript |
| D2 | Storage | SQLite file · JSON files in `~/.hoop` · repo-local `.hoop/` | SQLite in `~/.hoop`, export to repo on approval |
| D3 | MCP transport | stdio · local HTTP | stdio for Claude Code; HTTP later for remote |
| D4 | Waiting | `hoop wait` run in the background (Claude is re-invoked when it exits) · agent polls `hoop.feedback` · MCP long-poll | `hoop wait` in the background |
| D5 | Rendering | Standalone web app · MCP Apps inside Claude hosts · both | Standalone first; MCP Apps view later |
| D6 | Reviewers | Single local user · shared links · accounts | Single local user in v1 |
| D7 | Notifications | None · desktop · Slack or email | Desktop notification in v1 |

## 10. Slices (PRs, at most 10 files and 500 lines each)

```
1/7  contract     FR-2        JSON Schemas + validator + examples + tests          walking skeleton base
2/7  mcp-store    FR-1, FR-5  MCP server: submit, feedback; SQLite store
3/7  web-read     FR-3        local web app: list reviews, render one (TL;DR first)
4/7  web-review   FR-4        per-item verdicts, choices, comments, overall verdict
5/7  wait         FR-8        hoop wait CLI; devloop integration note
6/7  revisions    FR-6, FR-7  revisions, per-item diff, addressed comments, freeze
7/7  decisions    FR-9, FR-10 decision search over MCP, markdown export
```

Slices 1-4 are the walking skeleton end to end (submit, see, respond, read back); 5-7 add waiting,
revisions and the decision log.

## 11. Risks

- **Rubber-stamping moves to the browser.** Mitigate: TL;DR first, risk-sorted items, "approve
  all" only after high-risk items are opened.
- **Waiting blocks work.** Mitigate: background wait, never a blocking tool call.
- **Spec drift** between hoop and the repo. Mitigate: export on approval; the repo file is the
  source of truth after freeze.
- **Prompt injection via comments.** Mitigate: NFR-2.

## 12. Success metrics

- Time from submit to verdict.
- Share of items with per-item feedback (not just overall approve).
- Revisions per review before approval.
- Decisions looked up later via `hoop.decisions`.
