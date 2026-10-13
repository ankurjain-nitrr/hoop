# hoop: humans in the loop for agent decisions

Status: frozen (rev 8) · rev 6 delta: D2 storage changed from SQLite to JSON files · rev 7 delta: any document, comments that materialize as edits (FR-16 to FR-22) · Owner: Ankur Jain

## TL;DR

Coding agents now make many decisions that need a human: requirements, how work is sliced into
PRs, plans, trade-offs. Code review has a good interface (diffs, line comments, approvals). Every
other decision is reviewed as a wall of text in a terminal. hoop gives those decisions the same
treatment: Claude submits a decision as a structured JSON document over MCP, hoop renders it as a
reviewable page, people approve, choose or comment per item, and Claude reads the feedback back
over MCP. Execution starts only when the plan is approved.

Two channels, one contract: **local** (a localhost review page, for your own fast loop) and
**GitHub** (a PR, for team decisions, using GitHub's own review comments, suggestions, required
reviewers and notifications). Claude gets the same feedback document from either. Approved
decisions are committed to the repo under `decisions/`, so git is the decision log.

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

### Team decisions on GitHub

| hoop concept | GitHub piece that carries it |
|---|---|
| Review document | A PR adding `decisions/<slug>.json` (the contract) and a generated `decisions/<slug>.md` to read |
| Revision | A new commit on the same PR; GitHub diffs it and marks old comments outdated |
| Line comments and suggestions | Review comments and suggested changes on the `.md` lines |
| Questions with options | Checkboxes in the PR description |
| Required reviewers | CODEOWNERS on `decisions/` and branch protection, if the repo sets them |
| Freeze | PR approved and merged |
| Decision log | `decisions/` in git |

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
- Hosting other people's data: the local channel runs on localhost; the GitHub channel uses the
  team's own repository.
- A GitHub Action, and tracing requirements to code PRs (candidates for later).

## 4. Users

- **Driver:** the developer working with Claude; reviews most decisions.
- **Reviewer:** a teammate, lead or PM asked to weigh in on a specific decision, on GitHub.
- **Agent:** Claude (or any MCP client) that submits decisions and reads feedback.

## 5. Flow

1. Claude reaches a decision point (for example devloop's `scope` freeze or `slice` map) and calls
   `hoop.submit` with a review document. hoop returns a review ID and URL.
2. Claude prints the URL and runs `hoop wait <review_id>` in the background, so the session isn't blocked (D4).
3. Reviewers open the page and review it like a pull request: TL;DR first, then the proposal as
   numbered lines grouped into items. They drag over any words to comment on just that text (or
   comment on a whole line), suggest replacement text, answer questions inline, mark items viewed,
   and finish with Comment, Approve or Request changes.
4. Claude calls `hoop.feedback`, gets structured verdicts, and revises. A new revision is submitted
   against the same review; the page shows per-item diffs and which comments it addressed.
5. When the overall verdict is "approved", the review is frozen and Claude proceeds (execution
   starts on plan approval).
6. On approval the decision is written to `decisions/<slug>.json` and `.md` in the repo (local
   channel: Claude commits it; GitHub channel: the PR merges).
7. Later, any session or teammate reads `decisions/` (Claude greps it) to see what was approved
   and why.

With `channel: "github"`, step 1 opens a PR instead of a local page, steps 3-5 happen in GitHub's
review UI, and hoop syncs the review into the same feedback document.

## 6. JSON contract (v0)

Review document (agent → hoop):

```json
{
  "schema": "hoop/review@0",
  "review_id": null,
  "revision": 1,
  "kind": "requirements | slice_map | plan | questions | decision | doc",
  "channel": "local | github",
  "slug": "order-export-requirements",
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
    { "thread": "th_7", "item": "FR-3", "line": 1,
      "range": { "start": 63, "end": 70, "quote": "updated" },
      "body": "Use created_at, not updated_at", "suggestion": "created" }
  ],
  "answers": [{ "item": "Q-2", "choice": "b" }],
  "resolved_threads": ["th_3"],
  "viewed": ["FR-1", "FR-2"],
  "reviewer": "ankur",
  "at": "2026-10-13T10:00:00Z",
  "source": { "channel": "github", "pr": 42, "review_id": 991, "comment_ids": [7001] }
}
```

On GitHub, comments arrive on lines of the generated `.md`. Every line of an item starts with its
ID (`FR-3 ·`), so hoop maps a comment's line back to the item and line in the contract.
`range` (character offsets and the quoted text) is set when the comment covers part of a line; a
suggestion then replaces only that text. GitHub comments cover whole lines, so they have no
`range`.

The agent replies in a thread with `hoop.reply { thread, body }` (FR-11).

## 7. Functional requirements

- FR-1: When an agent calls `hoop.submit` with a valid review document, hoop shall store it and
  return a review ID and URL. Check: contract test with valid and invalid documents.
- FR-2: When a document fails schema validation, hoop shall reject it with field-level errors.
  Check: invalid examples return errors naming the field.
- FR-3: The review page shall show the TL;DR, then the proposal as numbered lines grouped into
  items, with an outline of items and a "Viewed" toggle that collapses an item. Check: UI test on a
  30-item review.
- FR-4: A reviewer shall be able to comment on a whole line or on any selected part of a line
  (by dragging over the text), attach suggested replacement text, answer questions by choosing an
  option, and keep comments pending until submitting a review as Comment, Approve or Request
  changes. Check: UI round trip produces the feedback document, including `range` for a
  partial-text comment.
- FR-4a: Text with a comment on it shall stay highlighted on the page, and selecting text by
  keyboard (Shift with arrow keys) shall work as well as by mouse. Check: UI test with both.
- FR-5: When an agent calls `hoop.feedback`, hoop shall return the feedback document for the
  latest revision. Check: contract test.
- FR-6: When an agent submits a new revision, the page shall offer a "Changes since rev N" view of
  changed lines, show earlier comments as threads, mark threads on changed lines as outdated, and
  let reviewers resolve them. Check: UI test with two revisions.
- FR-7: When the overall verdict is "approved", hoop shall freeze that revision; later submits
  create a new review linked to it. Check: submit after approval returns a new review ID.
- FR-8: `hoop wait <review_id>` shall exit when the review gets a verdict, printing the feedback.
  Check: CLI test with a verdict posted mid-wait.
- FR-10: When a local review is approved, hoop shall write `decisions/<slug>.json` and the
  rendered `decisions/<slug>.md` to the repo for Claude to commit. Check: files match golden files.
- FR-11: When an agent calls `hoop.reply` with a thread ID and text, hoop shall add the reply to
  that thread (on the page, or as a reply to the GitHub review comment). Check: contract test; the
  reply appears on the page and on a test PR.
- FR-12: When an agent submits with `channel: "github"`, hoop shall create branch
  `hoop/<slug>`, commit `decisions/<slug>.json` and the rendered `.md`, and open a PR whose
  description has the TL;DR and one checkbox per question option; it returns the PR URL.
  Check: test against a sandbox repo.
- FR-13: When an agent calls `hoop.feedback` for a GitHub review, hoop shall build the feedback
  document from the PR: line comments and suggestions (mapped to item and line), ticked
  checkboxes as answers, resolved threads, and the review state (Approved, Changes requested,
  Commented). Check: fixture PR responses map to the expected feedback document.
- FR-14: When an agent submits a new revision of a GitHub review, hoop shall push it as a new
  commit to the same PR and regenerate the `.md`. Check: sandbox PR shows two commits and
  outdated comments.
- FR-15: A GitHub review counts as approved when its PR is merged; required reviewers, where the
  repo sets them, are enforced by GitHub before merge. `hoop wait` works for both channels.
  Check: wait exits when a sandbox PR is merged.

### Rev 7: any document, and comments that become edits

hoop is not only for engineering decisions: any document (a policy, an essay, a proposal, a plan)
can be reviewed. Review comments can be **materialized**: turned into edits of the document
itself, with as little rephrasing as possible.

- FR-16: `hoop_submit_markdown` shall turn any markdown document into a review: sections split by
  heading, lines by paragraph or list item. The page uses neutral wording. Check: parse tests on
  headings, lists and documents without sections.
- FR-17: `hoop_export` shall return the latest revision as clean markdown in the original
  structure (no item IDs); approving a document writes that clean markdown. Check: round-trip test.
- FR-18: A reviewer shall be able to **Apply** an exact suggestion; it replaces just that text in
  a new revision and the thread is marked applied. Check: API and UI tests.
- FR-19: A comment on an item heading shall cover that section; a comment on the title or TL;DR
  shall cover the whole document. Check: contract and UI tests.
- FR-20: `hoop_propose_edits` shall take span replacements (`find`, `replace`) tied to a thread;
  each `find` must occur exactly once in its target line and lie within the thread's scope,
  otherwise the call is rejected with field errors. Check: contract tests.
- FR-21: Proposed edits shall show inline as tracked changes (deletion and insertion) with Accept
  and Reject; accepting applies only that span in a new revision; `hoop_feedback` reports each
  edit's status. Check: UI test.
- FR-22: Text outside accepted spans shall stay byte-identical across revisions; each edit shows
  the words it changes, and an edit that replaces more than half of its line's words is flagged as
  a large rewrite. Check: property test on the edit engine.

Decisions: both the reviewer (exact suggestions) and Claude (instruction comments) can
materialize; Claude's edits are tracked changes the reviewer accepts; heading comments cover their
section and title/TL;DR comments the document; minimal rephrasing is enforced, not advised.
Materializing on the GitHub channel is out of scope for rev 7 (GitHub's "Commit suggestion"
already edits the rendered `.md`, which hoop reads as feedback).

Slices: `anchors` (FR-19), `apply` (FR-18, FR-22), `propose` (FR-20), `tracked` (FR-21),
`docs` (FR-16, FR-17).

### Rev 8: audit log for the improvement loop

- FR-23: hoop shall append every submit, review, applied suggestion, proposed and decided edit,
  reply, and every failed tool call or reviewer action (with its field errors) to
  `~/.hoop/audit.jsonl`; logging never fails an action, and `HOOP_AUDIT=0` turns it off.
- FR-24: `hoop audit` shall summarize the log: reviews, approvals, median time to first verdict,
  revisions per review, suggestions applied, edits proposed, accepted and rejected, large
  rewrites, and the most common failure reasons. Check: tests over a scripted review.

## 8. Non-functional requirements

- NFR-1: Local first. One command starts the MCP server and web app on localhost; no data leaves
  the machine by default.
- NFR-2: Reviewer comments are untrusted input to the agent: feedback is returned as data, and the
  agent treats it as review input, not instructions that override the user.
- NFR-3: A 50-item review renders in under a second.
- NFR-4: The contract is versioned (`hoop/review@0`); servers accept the previous version.
- NFR-5: The GitHub channel uses the `gh` CLI's existing login; hoop stores no GitHub tokens.
- NFR-6: The rendered `.md` is deterministic: the same JSON always renders the same lines.

## 9. Decisions

| # | Decision | Chosen | Consequence |
|---|---|---|---|
| D1 | Stack | TypeScript | Official MCP SDK; server, CLI and web app in one language; run with `npx hoop` |
| D2 | Storage | JSON files in `~/.hoop` (rev 6; was SQLite) | `~/.hoop/reviews/<id>/`: one file per revision, feedback and replies; no dependencies, works on Node 18+; approved reviews written to `decisions/` (FR-10) |
| D3 | MCP transport | stdio | `claude mcp add hoop -- npx hoop mcp`; the MCP process also serves the web app on localhost; `hoop wait` reads the store directly |
| D4 | Waiting | `hoop wait` in the background | Claude is re-invoked when the verdict lands; no blocking tool call |
| D5 | Rendering | Standalone local web app | Opened from the URL Claude prints; MCP Apps view is a later option |
| D6 | Reviewers | Local: single user. Team: GitHub PRs | No hoop accounts; GitHub handles access, required reviewers and notifications |
| D7 | Notifications | None (local); GitHub's own (team) | Claude prints the review or PR link |
| D8 | Decision log | Decisions as code in `decisions/` | Git is the log; Claude and teammates read or grep it, so no search tool is needed |
| D10 | Comment anchor | Whole line or selected text (local); whole line (GitHub) | Partial-text comments need the local page; GitHub's own UI is line-based |
| D9 | Answers on GitHub | Checkboxes in the PR description | Reviewers tick an option; hoop reads the ticks on sync |

## 10. Slices (PRs of at most 10 files and 500 lines)

```
1/9  contract        FR-2               JSON Schemas + validator + examples + tests; deterministic .md renderer
2/9  mcp-store       FR-1, FR-5         MCP server: submit, feedback; JSON file store
3/9  web-read        FR-3               local web app: list reviews, render one (TL;DR first)
4/9  web-comments    FR-4 (lines), FR-11 line comments, suggestions, answers, finish review; hoop.reply
5/9  web-selection   FR-4 (ranges), FR-4a drag-select partial text, range anchors, highlights, keyboard selection
6/9  wait            FR-8               hoop wait CLI; devloop integration note
7/9  revisions       FR-6, FR-7, FR-10  revisions, per-item diff, outdated threads, freeze, write decisions/
8/9  github-submit   FR-12, FR-14       open and update the decision PR (branch, files, description checkboxes)
9/9  github-sync     FR-13, FR-15       PR review into the feedback document; merge = approval; hoop wait
```

Slices 1-4 are the walking skeleton end to end (submit, see, respond, read back); 5 adds
partial-text comments as its own slice so the review UI stays within the size budget; 6-7 add
waiting, revisions and decisions as code; 8-9 add the GitHub channel. Simplified in rev 5: no
decision-search tool (grep `decisions/`), and merge is the GitHub approval signal. Review page mockup: https://claude.ai/artifact/NzAxEQLo4Bi9hhb6xhNJL8

## 11. Risks

- **Rubber-stamping moves to the browser.** Mitigate: TL;DR first, risk-sorted items, "approve
  all" only after high-risk items are opened.
- **Waiting blocks work.** Mitigate: background wait, never a blocking tool call.
- **Spec drift** between hoop and the repo. Mitigate: export on approval; the repo file is the
  source of truth after freeze.
- **Prompt injection via comments.** Mitigate: NFR-2. On GitHub, anyone who can comment on the PR
  can write feedback; treat it as untrusted the same way.
- **A suggestion committed in GitHub edits the generated `.md`, not the JSON.** Mitigate: the `.md`
  header says it is generated; hoop reads an applied suggestion as feedback, and the next revision
  regenerates the `.md` from updated JSON.
- **Checkboxes need write access to edit the PR description.** Mitigate: reviewers without it
  answer in a comment; hoop reports unanswered questions in the feedback.

## 12. Success metrics

- Time from submit to verdict.
- Share of items with per-item feedback (not just overall approve).
- Revisions per review before approval.
- Decisions in `decisions/` referenced by later sessions and code PRs.
