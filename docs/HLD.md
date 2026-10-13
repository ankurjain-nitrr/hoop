# hoop: HLD

Status: approved · Revision: 1 · Describes `main` at v0.2.0

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
| Core | `src/hoop.ts` | Submit, review, apply, propose, decide, reply, refresh from GitHub, decisions |
| GitHub | `src/github.ts` | Decision PRs through `gh api`: open, revise, sync reviews, reply |
| MCP server | `src/mcp.ts` | Six tools over stdio; logs failed calls |
| Web | `src/web.ts`, `web/*` | JSON API and the review page (plain JS modules, no build step) |
| Wait, audit, CLI | `src/wait.ts`, `src/audit.ts`, `src/cli.ts` | `hoop wait`, the audit log and `hoop audit`, commands |

**Local channel:** the agent submits; the reviewer comments on the page; the page posts a
feedback document; the agent reads it (or `hoop wait` wakes it); revisions repeat until approval,
which writes `decisions/`.

**GitHub channel:** submitting opens a PR (`hoop/<slug>`) with the JSON and a line-numbered `.md`;
each feedback read re-syncs the PR's reviews into the store; merge approves, closing rejects.

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
- CLI: `hoop mcp`, `hoop serve`, `hoop wait <id> [--timeout s]`, `hoop audit [--since d] [--json]`.
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

## Risks

- Rubber-stamping moves to the browser: TL;DR first, risk shown per item.
- Prompt injection through comments: feedback is returned as data (NFR-2).
- The local API is reachable from web pages: Host, Origin and content-type checks (NFR-1).
- Edits drifting onto other text: proposals bind to their line's exact text.
