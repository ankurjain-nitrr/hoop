# hoop: HLD

Status: approved · Revision: 5 · Describes `main` (CR-2, CR-3, CR-8 and CR-9 folded)

## Context

hoop is a Node.js (TypeScript) package with one process per agent session: `hoop mcp` speaks MCP
over stdio to the agent and serves the review page on 127.0.0.1. Reviews live as JSON files on the
machine; team reviews live in a GitHub PR on the reviewed repository.

```
agent ──MCP stdio──▶ hoop mcp ─┬─ Hoop (core) ── Store (~/.hoop/reviews/<id>/*.json)
                               │        │  └──── audit (~/.hoop/audit.jsonl)
                               │        └─ GitHub (gh api) ── decision PR (team channel)
                               └─ web server (127.0.0.1:4747) ── review page (browser)
hoop wait / hoop audit / hoop serve ── same Store, separate processes
```

## Design

| Component | File | Responsibility |
|---|---|---|
| Contract | `src/contract.ts` | Schemas for review and feedback documents, anchors and scopes, validation |
| Edit engine | `src/edit.ts` | Locate a span, write it into the one field it came from, word stats |
| Markdown | `src/markdown.ts` | Any markdown to a review document and back; stable section IDs |
| Rendering | `src/render.ts` | Line-numbered `.md` for GitHub review, PR description checkboxes |
| Store | `src/store.ts` | Reviews, revisions, feedback, replies, proposals, applied edits as JSON files |
| Core | `src/hoop.ts` | It receives every operation and coordinates the components below. |
| Review rules | `src/rules.ts` | It decides whether a review can change, and finds a comment thread (CR-8). It gives each review its status key (CR-9). |
| Materializer | `src/materialize.ts` | It turns suggestions and accepted edits into new revisions (CR-8). |
| GitHub | `src/github.ts` | Decision PRs through `gh api`: open, revise, sync reviews, reply |
| MCP server | `src/mcp.ts` | Six tools over stdio; logs failed calls |
| Web | `src/web.ts`, `web/*` | JSON API and the review page (plain JS modules, no build step) |
| Page frame and status set | `web/frame.js`, `web/status.js`, `web/icons.js` | Every page shares one frame and one label, color and icon per status (CR-9). |
| Line kinds | `web/blocks.js` | One rule decides each line's kind, for the parser, the edit engine and the pages (CR-9). |
| Line renderer | `web/inline.js` | It shows lines as formatted text and maps every shown character back to the source (CR-9). |
| Operations | `src/ops.ts` | Every operation defined once; the MCP server and the CLI both come from it |
| Change registry | `src/changes.ts` | Change requests as written, type, step history, linked reviews and PRs; fold gate |
| Review sequencer | `src/sequence.ts` | PRD → HLD → LLD order, staleness, build gate; keeps each change's tracker row |
| Tracker service | `src/tracker.ts` | Markdown trackers as trees; row-only writes with a conflict check |
| Wait, audit, CLI | `src/wait.ts`, `src/audit.ts`, `src/cli.ts` | `hoop wait`, the audit log and `hoop audit`, commands |
| Shared helpers | `src/util.ts` | Errors, environment defaults, atomic writes, table rows, and each folder's repository identity (CR-9) |

**Local channel:** the agent submits; the reviewer comments on the page; the page posts a
feedback document; the agent reads it (or `hoop wait` wakes it); revisions repeat until approval,
which writes `decisions/`.

**GitHub channel:** submitting opens a PR (`hoop/<slug>`) with the JSON and a line-numbered `.md`;
each feedback read re-syncs the PR's reviews into the store; merge approves, closing rejects.

**Changes:** the agent captures a request (`hoop cr create`), which lands in the repository with a
tracker row. Each design document is submitted linked to its change; the sequencer refuses one
whose predecessor isn't approved and current. Step moves go through the registry, which asks the
sequencer before build and `gh` before fold, and updates the change's tracker row.

**Materializing:** reviewer suggestions apply directly; the agent's proposals wait as tracked
changes until accepted. Both go through the edit engine, so only the span changes, and each
application is a new revision recorded in `applied.json`.

## Interfaces and contracts

- MCP tools: `hoop_submit`, `hoop_submit_markdown`, `hoop_feedback`, `hoop_propose_edits`,
  `hoop_reply`, `hoop_export`.
- Documents: `hoop/review@0` (kind, channel, slug, title, tldr, items with id, type, title, body,
  check, choices, risk, depends_on, level) and `hoop/feedback@0` (verdict, comments anchored by
  item, line and optional range, answers, resolved threads, viewed, reviewer, source).
- Anchors: item lines from 1; line 0 is a heading; item `DOC` lines 1 and 2 are title and TL;DR.
- HTTP (127.0.0.1 only): `GET /`, `GET /r/<id>`, `GET /api/reviews`, `GET /api/reviews/<id>`,
  `POST /api/reviews/<id>/feedback`, `POST /api/reviews/<id>/apply`, `POST /api/reviews/<id>/edits/<edit>`.
- Files: `~/.hoop/reviews/<id>/{review,rev-N,feedback-N,replies,proposals,applied}.json`,
  `~/.hoop/audit.jsonl`, `<repo>/decisions/<slug>.{json,md}`.
- MCP tools added by CR-3: `hoop_cr_create`, `hoop_cr_classify`, `hoop_cr_step`, `hoop_cr_get`,
  `hoop_cr_link_pr`, `hoop_tracker_get`, `hoop_tracker_set`; `hoop_submit` and
  `hoop_submit_markdown` take `change: {cr, doc}`.
- CLI: `hoop mcp`, `hoop serve`, `hoop wait <id> [--timeout s]`, `hoop audit [--since d] [--json]`,
  and one command per tool (`hoop help`).
- HTTP added by CR-3: `GET /tracker`, `GET /api/trackers`, `GET /api/tracker?file=`.
- HTTP added by CR-9: `GET /api/info` gives the served folder's repository identity. Each review
  gains `status_key`, `status_note` and `repo`, and each item in a review's view gains `blocks`.
- Files added by CR-3: `<repo>/docs/changes/CR-<n>-<slug>/{REQUEST.md, change.json}`,
  `<repo>/docs/changes/CLASSIFICATION.md`, `<repo>/docs/TRACKER.md`.
- Environment: `HOOP_HOME`, `HOOP_PORT`, `HOOP_REPO_DIR`, `HOOP_AUDIT`, `HOOP_CHROME` (tests).

## Alternatives considered

- SQLite store: needs a native module or Node 22+; JSON files are enough without search.
- A wrapper review agent: the code-review plugin already uses fresh-context subagents.
- GitHub-only: loses partial-text comments and a fast solo loop; kept GitHub for team review.
- A separate headless review process: subagents and CI review are simpler.

## Decisions

- D-1: One contract over two channels (local page, GitHub PR), same feedback document. Why: one path
  for the agent; teams keep GitHub.
- D-2: JSON files in `~/.hoop` (was SQLite). Why: Node 18, no native modules, nothing to query.
- D-3: stdio MCP process also serves the page. Why: one command to set up.
- D-4: Background `hoop wait` instead of a blocking tool call. Why: the session stays responsive.
- D-5: Merge approves and closing rejects on GitHub. Why: authors can't approve their own PRs;
  branch protection enforces team approvals.
- D-6: Decisions as code in `decisions/`. Why: git is the log; no search tool.
- D-7: Comments anchor to whole lines or selected text locally, whole lines on GitHub.
- D-8: Materializing: reviewers apply exact suggestions; the agent proposes span edits accepted as
  tracked changes; enforced minimal rephrasing (byte-identical outside spans).
- D-9: Headings scope their section; title and TL;DR scope the document.
- D-10: A document line keeps its exact source text (U+2028 joins), so export is byte-identical;
  sections keep IDs by heading across revisions.
- D-11: Every action and failure goes to an audit log for the improvement loop.
- D-12 (CR-2): Documents parsed from a `#` title keep blank lines in section bodies and are marked
  `spacing: "exact"`; documents without the marker (stored before CR-2, or untitled) keep the
  one-blank-line layout. Why: byte-identical export without breaking stored reviews.

- D-13 (CR-3): The repository is the source of truth for changes and trackers; hoop's store keeps
  reviews. Why: visible and diffable in the repository.
- D-14 (CR-3): Gates live in hoop, not in the skill, so any agent is held to them.
- D-15 (CR-3): Staleness is computed from approval times, not stored.
- D-16 (CR-3): Terminal commands mirror the agent tools one to one, from one operations table.
- D-17 (CR-3): Classification corrections are recorded in the repository and read by devloop.
- D-18 (CR-8): The core stays the single entry point and only coordinates. The review rules own
  every check that a review can change.
- D-19 (CR-9): The pages format each line themselves and keep a map to source offsets, so comments
  anchor to source text on formatted lines.
- D-20 (CR-9): The server decides each line's kind once, in one shared module, and the edit engine
  uses it too.
- D-21 (CR-9): The server gives each review a status key and a repository identity. The pages only
  name each status, and they never read file paths.
- D-22 (CR-9): Icons are inline SVG and fonts come from the system, so the pages fetch nothing.
- D-23 (CR-9): An automatic TL;DR shows once, as the first paragraph. A document with its own
  TL;DR still shows it first, and D-9 still holds.

## Risks

- Rubber-stamping moves to the browser: a summary first (a document's own TL;DR, or its first
  paragraph under D-23), and risk shown per item.
- A document could inject markup into the page. The renderer builds markup only from escaped text
  and a fixed set of tags, and links open only http and https addresses (CR-9).
- A selection maps to the wrong source text on a formatted line. Unit tests check the source map,
  and browser tests check selections inside code, bold text and links (CR-9).
- Prompt injection through comments: feedback is returned as data (NFR-2).
- The local API is reachable from web pages: Host, Origin and content-type checks (NFR-1).
- Edits drifting onto other text: proposals bind to their line's exact text.
- Hand edits to a tracker while hoop writes it: row-only writes refuse a file that changed since it
  was read.
- Approvals in the same millisecond compare as equal, so the later document isn't marked stale.
