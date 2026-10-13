# hoop: LLD

Status: approved · Revision: 2 · Describes `main` (CR-2 folded)

## Contract (`src/contract.ts`)

- Responsibility: the shape of everything exchanged; validation with field paths.
- Data model: `ReviewDoc` (zod), `Item`, `Choice`, `Feedback`, `Comment` (`item`, `line >= 0`,
  optional `range {start, end, quote}`, `body` or `suggestion`), `Range`.
- Interface: `validateReview(input)`, `validateFeedback(input, doc?)` return `{ok, value}` or
  `{ok: false, errors: [{path, message}]}`; `itemLines(item)` gives an item's lines (non-empty body
  lines, then question choices as `a) label`, then `Check: …`); `anchorText(doc, item, line)`;
  `scopeOf(anchor)` and `inScope(scope, target)`; `DOC` is reserved.
- Errors: duplicate IDs, questions without choices, unknown dependencies, anchors that don't exist,
  a range whose quote doesn't match.

## Edit engine (`src/edit.ts`)

- Responsibility: change exactly one span in exactly one field.
- Interface: `locate(doc, {item, line, find, replace, start?})` (at `start`, or the single
  occurrence); `applyEdit(doc, edit)` returns a new document; `wordStats(find, replace, line)`;
  `narrow(text, replacement)` shrinks a whole-line suggestion to the differing words.
- Behavior: `setter` maps an anchor to its field (title, TL;DR, heading, the n-th non-empty body line
  keeping its indentation, a choice's label, the check); the result is re-read and compared.
- Errors (`EditError` with a field): not found, ambiguous, line breaks in `replace`, emptying a line,
  editing an option's letter, changing a document line's markdown block markers, editing a TL;DR
  copied from the first paragraph.

## Markdown (`src/markdown.ts`)

- Interface: `parseMarkdown(md, {title, tldr, slug, channel, review_id})`, `exportMarkdown(doc)`,
  `keepIds(prior, next)`, `JOIN` (U+2028).
- Behavior: first `#` heading is the title; ATX and setext headings start sections (`level`);
  blocks are paragraphs, list items with continuations, quote lines, table rows, fenced and indented
  code, thematic breaks, each one line with source lines joined by U+2028; blank lines between
  blocks and around headings kept as empty body lines (not commentable, so anchors don't move);
  intro is section `S-0` at level 0; TL;DR defaults to the first paragraph (`tldr_auto`). With
  `spacing: "exact"` (a document with a `#` title), export writes headings and bodies verbatim;
  without it, one blank line around headings.

## Store (`src/store.ts`)

- Data model: `ReviewMeta` (id, slug, title, channel, status open/approved/closed, revisions,
  repo_dir, github PrRef, supersedes, decision_files, pr_answers), `Reply`, `Proposal` (id, thread,
  revision, item, line, find, replace, start, line_text, words, status), `Applied`.
- Interface: `create`, `addRevision`, `update`, `meta`, `revision`, `feedback`, `allFeedback`,
  `addFeedback` (assigns `th_<review>_<n>` thread IDs), `setFeedback`, `replies`, `addReply`,
  `proposals`, `writeProposals`, `applied`, `addApplied`, `findThread`, `list`.
- Behavior: atomic writes (temp file and rename); review IDs validated before building paths.

## Core (`src/hoop.ts`)

- Interface: `submit`, `submitAny` (GitHub channel), `feedback`, `feedbackAny` (refreshes GitHub),
  `review` (validates new comments against the current revision; replies keep their anchor),
  `applySuggestion`, `proposeEdits`, `editPosition`, `decideEdit`, `reply`, `replyAny`, `refresh`,
  `writeDecision`.
- Behavior: documents keep section IDs across revisions (`keepIds`); approval freezes and writes
  decisions (clean markdown for `kind: "doc"`); accepted spans rebase other proposals on the line;
  every action is audited.
- Errors: `HoopError(message, fieldErrors)`; approved, closed and GitHub reviews refuse local edits.

## GitHub (`src/github.ts`)

- Interface: `GitHub(gh)` with `open(dir, doc)`, `revise(ref, doc, n)`, `sync(ref, id, revisions)`,
  `reply(ref, rootCommentId, body)`; `PrRef` keeps `commits` (sha to revision) and `own_comments`.
- Behavior: commits through the git trees API (the checkout is untouched); maps comment lines through
  the rendered line map of the revision they were made on; resolved threads via GraphQL.

## MCP, web, wait, audit, CLI

- `src/mcp.ts`: six tools; `failure()` returns errors as tool errors and audits them.
- `src/web.ts`: route table behind Host, Origin and JSON checks; `reviewView` adds item lines,
  history per revision, replies, applied edits and proposal positions. `web/app.js` renders;
  `review.js` adds comments, threads, Apply, tracked-change cards and Finish; `select.js` handles
  selection (ignoring inserted text) and decorations.
- `src/wait.ts`: polls the store (and GitHub every 15 s) until a new review, approval or close.
- `src/audit.ts`: `audit(event, data)` appends; `readAudit`, `summarize` for `hoop audit`.

## Test plan

| Requirement | Test | Level |
|---|---|---|
| FR-1, FR-5 | `test/mcp.test.ts` | integration (real stdio server) |
| FR-2, FR-19 | `test/contract.test.ts` | unit |
| FR-3, FR-4, FR-4a, FR-6, FR-18, FR-19, FR-21 | `test/ui.test.ts` | browser (Node 20+, Chrome) |
| FR-6, FR-7, FR-10, FR-18 | `test/revisions.test.ts` | unit |
| FR-8 | `test/wait.test.ts` | integration (CLI) |
| FR-11, NFR-1 | `test/web.test.ts` | integration (HTTP) |
| FR-12 to FR-15 | `test/github.test.ts` (fake `gh`), `scripts/e2e-github.ts` | unit, live |
| FR-16, FR-17 | `test/markdown.test.ts`, `scripts/e2e-docs.ts` | unit, e2e |
| FR-20, FR-21 | `test/propose.test.ts` | unit |
| FR-22 | `test/edit.test.ts` (200 random edits) | property |
| FR-23, FR-24 | `test/audit.test.ts` | unit |
| End to end | `scripts/e2e-local.ts`, `scripts/e2e-docs.ts`, `scripts/e2e-github.ts` | acceptance |
