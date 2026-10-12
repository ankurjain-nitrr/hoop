# hoop: humans in the loop for agent decisions

Status: draft (rev 3): decisions resolved, slices approved, review UX settled (code-review style), requirements awaiting approval · Owner: Ankur Jain

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

## 2. Alternatives evaluated

Top 3 by closeness to the goal, plus the do-nothing baseline. ✓ yes · ◐ partly · ✗ no.

| What matters | hoop (planned) | [Plannotator](https://github.com/backnotprop/plannotator) | [gotoHuman](https://www.gotohuman.com/) | [Kiro spec mode](https://kiro.dev/blog/cli-3/) | GitHub PR on a spec file |
|---|---|---|---|---|---|
| Line comments, suggestions, threads the agent replies in | ✓ | ◐ annotations, no threads | ✗ form fields | ◐ inline comments | ✓ |
| Structured decisions (item IDs, multiple-choice questions) | ✓ | ✗ markdown | ◐ forms | ◐ EARS requirements | ✗ |
| Feedback to the agent as structured data over MCP | ✓ | ✗ hook, prose | ◐ MCP in, webhook out | ✗ internal | ◐ comments to parse |
| Works with Claude Code and other agents | ✓ | ✓ | ✓ | ✗ Kiro only | ✓ |
| Revision diff, outdated and resolved comments | ✓ | ◐ plan diff | ✗ | ◐ refine | ✓ |
| Non-blocking wait, execution on approval | ✓ | ✓ | ◐ needs a webhook receiver | ✓ | ◐ manual |
| Searchable decision log | ✓ | ◐ archive | ◐ inbox history | ◐ spec files | ◐ PR history |
| Local and free | ✓ | ✓ | ✗ hosted, [paid above 300 reviews/month](https://www.gotohuman.com/pricing) | ✗ subscription | ◐ needs a repo and PR |
| Several reviewers | ✗ v1 | ◐ share links; workspaces waitlisted | ✓ routing | n/a | ✓ |
| Available today | ✗ | ✓ | ✓ | ✓ | ✓ |

Why hoop: it is the only option that combines a code-review experience, structured decisions and
structured feedback to the agent, while staying local and free with a decision log. Where it
loses: it doesn't exist yet, v1 has no team review, and Plannotator (open source, closest) could
close the gap by adding MCP and structured questions. Mitigations: keep the JSON contract open and
agent-agnostic; keep GitHub PRs as the route for team decisions.

Also seen: MCP elicitation (flat inline forms), MCP Apps (UI inside an MCP host), HumanLayer
(tool-call approvals), LangGraph interrupts (per tool call), small MCP feedback servers
(Feedback Loop, User Feedback, ReviseMy for design review).

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
2. Claude prints the URL and runs `hoop wait <review_id>` in the background, so the session isn't blocked (D4).
3. Reviewers open the page and review it like a pull request: TL;DR first, then the proposal as
   numbered lines grouped into items. They comment on lines, suggest changes, answer questions
   inline, mark items viewed, and finish with Comment, Approve or Request changes.
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

Feedback (hoop → agent), one per submitted review:

```json
{
  "schema": "hoop/feedback@0",
  "review_id": "rv_12",
  "revision": 2,
  "verdict": "comment | approved | changes_requested",
  "summary": "Split FR-5 into its own slice",
  "comments": [
    { "thread": "th_7", "item": "FR-3", "line": 1, "body": "Use created_at, not updated_at",
      "suggestion": "When from or to are given, the system shall include only orders created in that range." }
  ],
  "answers": [{ "item": "Q-2", "choice": "b" }],
  "resolved_threads": ["th_3"],
  "viewed": ["FR-1", "FR-2"],
  "reviewer": "ankur",
  "at": "2026-10-13T10:00:00Z"
}
```

The agent replies in a thread with `hoop.reply { thread, body }` (FR-11).

## 7. Functional requirements

- FR-1: When an agent calls `hoop.submit` with a valid review document, hoop shall store it and
  return a review ID and URL. Check: contract test with valid and invalid documents.
- FR-2: When a document fails schema validation, hoop shall reject it with field-level errors.
  Check: invalid examples return errors naming the field.
- FR-3: The review page shall show the TL;DR, then the proposal as numbered lines grouped into
  items, with an outline of items and a "Viewed" toggle that collapses an item. Check: UI test on a
  30-item review.
- FR-4: A reviewer shall be able to comment on any line, attach a suggested change to the line's
  text, answer questions by choosing an option, and keep comments pending until submitting a
  review as Comment, Approve or Request changes. Check: UI test round trip produces the feedback
  document.
- FR-5: When an agent calls `hoop.feedback`, hoop shall return the feedback document for the
  latest revision. Check: contract test.
- FR-6: When an agent submits a new revision, the page shall offer a "Changes since rev N" view of
  changed lines, show earlier comments as threads, mark threads on changed lines as outdated, and
  let reviewers resolve them. Check: UI test with two revisions.
- FR-7: When the overall verdict is "approved", hoop shall freeze that revision; later submits
  create a new review linked to it. Check: submit after approval returns a new review ID.
- FR-8: `hoop wait <review_id>` shall exit when the review gets a verdict, printing the feedback.
  Check: CLI test with a verdict posted mid-wait.
- FR-9: When an agent calls `hoop.decisions` with a query, hoop shall return approved items
  matching it, with review, revision and approver. Check: search test.
- FR-10: An approved review shall be exportable as markdown to the repo (for example
  `docs/specs/<slug>.md`). Check: export matches a golden file.
- FR-11: When an agent calls `hoop.reply` with a thread ID and text, hoop shall add the reply to
  that thread on the page. Check: contract test and UI shows the reply.

## 8. Non-functional requirements

- NFR-1: Local first. One command starts the MCP server and web app on localhost; no data leaves
  the machine by default.
- NFR-2: Reviewer comments are untrusted input to the agent: feedback is returned as data, and the
  agent treats it as review input, not instructions that override the user.
- NFR-3: A 50-item review renders in under a second.
- NFR-4: The contract is versioned (`hoop/review@0`); servers accept the previous version.

## 9. Decisions

| # | Decision | Chosen | Consequence |
|---|---|---|---|
| D1 | Stack | TypeScript | Official MCP SDK; server, CLI and web app in one language; run with `npx hoop` |
| D2 | Storage | SQLite in `~/.hoop` | One store across repos; approved reviews exported to the repo as markdown (FR-10) |
| D3 | MCP transport | stdio | `claude mcp add hoop -- npx hoop mcp`; the MCP process also serves the web app on localhost; `hoop wait` reads the store directly |
| D4 | Waiting | `hoop wait` in the background | Claude is re-invoked when the verdict lands; no blocking tool call |
| D5 | Rendering | Standalone local web app | Opened from the URL Claude prints; MCP Apps view is a later option |
| D6 | Reviewers | Single local user | No accounts or sharing in v1 |
| D7 | Notifications | None | Claude prints the review link; no notification setup |

## 10. Slices (approved; PRs of at most 10 files and 500 lines)

```
1/7  contract     FR-2        JSON Schemas + validator + examples + tests          walking skeleton base
2/7  mcp-store    FR-1, FR-5  MCP server: submit, feedback; SQLite store
3/7  web-read     FR-3        local web app: list reviews, render one (TL;DR first)
4/7  web-review   FR-4, FR-11 line comments, suggestions, answers, finish review; hoop.reply
5/7  wait         FR-8        hoop wait CLI; devloop integration note
6/7  revisions    FR-6, FR-7  revisions, per-item diff, addressed comments, freeze
7/7  decisions    FR-9, FR-10 decision search over MCP, markdown export
```

Slices 1-4 are the walking skeleton end to end (submit, see, respond, read back); 5-7 add waiting,
revisions and the decision log. Review page mockup: https://claude.ai/artifact/NzAxEQLo4Bi9hhb6xhNJL8

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
