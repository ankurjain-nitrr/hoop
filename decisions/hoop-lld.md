# hoop: LLD

Status: approved · Revision: 7 · Describes `main` (CR-2, CR-3, CR-8, CR-9, CR-10 and CR-13 folded)

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
- Since CR-8, `applySuggestion`, `proposeEdits`, `editPosition` and `decideEdit` delegate to the
  materializer, and every refusal comes from the review rules.

## Review rules (`src/rules.ts`, CR-8)

- `editable(store, id, { open, frozen, github })` returns the review or throws. Each caller passes
  its own wording for a GitHub review. `thread(store, id, threadId)` returns the first comment, its
  revision and every entry. `threadIds` and `existing` sit alongside them.
- `reviewStatus(store, meta)` gives a review's status key (CR-9). The keys are awaiting_review,
  commented, changes_requested, approved and closed. A GitHub review that is approved but not
  merged is awaiting_review, with a note.

## Materializer (`src/materialize.ts`, CR-8)

- The `Materializer` holds apply, propose, decide, edit positions and the rebase of other proposals
  on a line. It uses the review rules, the edit engine and the store.

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

## Pages and line rendering (`web/*`, CR-9)

- `web/blocks.js` holds the line rules. `blockKinds(rawLines)` gives each body line a block,
  `{ kind, indent }`. The kinds are paragraph, list, quote, code, break and table, and a kind the
  pages don't know shows as written. It replays the parser's open block between lines.
  `pieceMarker(piece)` gives the structure markers that an edit must keep. The parser, `itemBlocks` in `src/contract.ts` and the edit engine
  import it, and so do the pages.
- `web/inline.js` renders a line. `renderLine(text, decorations, block)` puts every shown source
  character in a span that records its offset. `widen` grows a selection to whole formatted runs,
  `findTyped` matches typed words in the shown text, and `sourceOffset` maps a DOM position back.
  Only escaped text and a fixed set of tags reach the page, and links open only http and https.
- `web/frame.js`, `web/status.js`, `web/icons.js` and `web/esc.js` hold the frame, the status
  labels, the icons and escaping.
- API: each review in `GET /api/reviews` and the view in `GET /api/reviews/<id>` gain
  `status_key`, `status_note` when there is one, and `repo`, which is `{ name, key }`. Neither
  response carries a folder path. Each item gains `blocks`, the view gains `history_blocks`, and
  `GET /api/info` gives the served folder's identity. `repoIdentity` in `src/util.ts` builds it.
- Tests: `test/pages.test.ts` checks every page in both themes, at 400 pixels, from the keyboard,
  offline and with `axe-core`. `HOOP_REQUIRE_BROWSER=1` turns a skipped browser into a failure.

## Document checks (`src/checks.ts`, `web/checks.js`, CR-10)

- `runCheck(repo, markdown, home)` returns an outcome
  `{ ran, reason?, message?, command?, allow?, findings, ms?, started? }`, or nothing when the
  repository sets no command. A finding is `{ line?, message, place? }`, and a place is
  `{ item, line }`.
- Configs: `hoop.config.json` holds `{ "check": [arguments] }`. The hoop folder's `config.json`
  holds `{ "checks": [{ "repo", "command" }] }`. An entry matches an absolute folder, by real path,
  with the same argument list.
- It writes the document to a temporary file and runs the command with that path as the last
  argument. It uses `spawn` with no shell, in the repository folder. After ten seconds it stops the
  process group. It never throws.
- Reasons are `not_allowed`, `failed`, `timeout`, `running` and `stopped`. A `not_allowed` outcome
  holds the allow entry for the agent.
- `linePlaces(markdown, options)` in `src/markdown.ts` maps each source line to an item's position
  and its `itemLines` line, both from 0. The core maps the position to the stored revision's ID.
- `submitAny(input, { source })` takes `source`, which is `{ markdown, options }`, from the
  `submit_markdown` operation. The core stores a `running` outcome, then the final one, with the
  store's `saveCheck`, in `checks-<revision>.json`. It audits only the final one. `latestCheck`
  finds the newest stored outcome. `hoop audit` counts checks run, findings and checks that didn't
  run.
- The `hoop_submit_markdown` description says the result may hold `checks`, and the interface
  snapshot was updated for it.
- The view's `checks` drops the allow entry and shows a fixed message for each reason. A `running`
  outcome older than the timeout reads as `stopped`.
- `web/checks.js` renders the panel. `goToLine` in `web/app.js` jumps to a finding's line. It opens
  a collapsed item, switches a tracker table to its lines, and moves focus to the line. A finding
  from an older revision shows that revision's line and offers no jump.
- This repository runs `scripts/check-writing.sh`, which runs devloop's writing checker.

## Conversations and hidden comments (`web/review.js`, CR-13)

- A resolved conversation renders as a `details` element with a summary row. `state.openThreads`
  keeps the ones the reviewer opened, through a `toggle` listener that captures the event.
- A local thread is resolved while no entry is newer than the review that resolved it. A GitHub
  thread follows the sync's resolved list. That list comes from the latest review on the latest
  revision, so after a newer revision with no review, GitHub threads show in full.
- `state.commentsHidden` sets a `comments-hidden` class on the page root on every render.
  `data-comment="hide"` elements disappear in that mode, and `data-comment="plain"` elements keep
  their words without styling. `web/inline.js` marks highlights and Claude's struck text `plain`,
  and Claude's inserted text `hide`. Any later renderer follows the same rule. It marks `hide` on what
  only shows a comment, and `plain` on what wraps the document's own words. The hide control isn't offered while the comment box or the finish
  panel is open, and opening either one ends the mode.

## Change registry (`src/changes.ts`, CR-3)

- Data model: `docs/changes/CR-<n>-<slug>/REQUEST.md` (the request, byte for byte, written once)
  and `change.json` `{ id, slug, title, type, reason, created, steps: [{step, at, by}], reviews:
  {prd?, hld?, lld?: string[]}, prs: number[] }`. `steps` is append-only; the last is current.
- Interface: `create(text, {type, reason, title?, slug?, by?})` reserves the next number with an
  exclusive folder create; `classify(cr, type, reason, {why?})` logs a corrected type to
  `CLASSIFICATION.md` before saving; `moveStep(cr, step)` allows only the next step or `closed`,
  asks the gate hook, and for fold checks every linked PR with `gh pr view` (injectable);
  `linkPr`, `addReview`, `get`, `list`. Folders without `change.json` read as type `unknown`.

## Review sequencer (`src/sequence.ts`, CR-3)

- A review is linked to `{cr, doc, repo}` in `ReviewMeta.change`; a revision inherits the link and
  can't be relinked. `approved_at` is set on approval (the merge time on GitHub).
- `state(cr)`: each document's current review, status, approval time and staleness (stale when
  the document before isn't approved, is stale, or was approved later). `blockers(cr, doc)` before
  a review opens; `ready(cr)` for build. `gatedChanges(store, repo)` wires the build gate and keeps
  the change's row in `docs/TRACKER.md` (failures are audited, not thrown).

## Tracker service (`src/tracker.ts`, CR-3)

- The first table whose header has ID and Parent; columns by name. `readTracker(path)` gives
  `{columns, items, tree, hash}`; `setCells` and `addItem` rewrite only their row (a missing column
  is added on every row), keep each line's ending, refuse a stale `base` hash, and write
  atomically through symlinks. `trackerTables(lines)` serves review pages; `insideRepo` confines
  paths to the repository.

## Operations and CLI (`src/ops.ts`, `src/cli.ts`, CR-3)

- `OPS`: `{name, title, description, input (zod), run(hoop, input, {actor}), cli: {command, usage,
  parse}}`. MCP registers `hoop_<name>`; the CLI matches the longest command words, takes the
  `--name <value>` flags in the usage line (unknown flags refused), validates with the same schema,
  prints text or `--json`, and exits 1 with field errors. The CLI acts on the git repository root.

## Tracker pages (`web/tree.js`, `web/tracker.js`, CR-3)

- `renderTree(key, columns, rows)`: depth-first rows with carets, type badges, status and phase
  chips, filters that keep ancestors; rows with comments or edits stay visible. Review pages render
  each item's `tables` (from the API) as trees with each row's line anchor and threads.

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
| FR-25, FR-26, FR-28 | `test/changes.test.ts` | unit |
| FR-27, FR-28, NFR-8 | `test/sequence.test.ts` | unit (through `Hoop`) |
| FR-29, NFR-9 | `test/tracker.test.ts` | unit |
| FR-30 | `test/tracker-page.test.ts` | integration (HTTP), browser |
| FR-31 | `test/cli.test.ts` | integration (CLI subprocess) |
| NFR-10 | `test/rules.test.ts`, `test/interface.test.ts` | unit, integration |
| FR-32, FR-34 | `test/frame.test.ts`, `test/web.test.ts` | unit, integration (HTTP), browser |
| FR-33 | `test/status.test.ts`, `test/ui.test.ts` | unit, browser |
| FR-35 to FR-37 | `test/inline.test.ts`, `test/blocks.test.ts`, `test/web.test.ts`, `test/ui.test.ts`, `test/tracker-page.test.ts` | unit, integration (HTTP), browser |
| FR-38 to FR-40, NFR-12 | `test/ui.test.ts` | browser |
| NFR-11 | `test/pages.test.ts` | browser |
| FR-41, FR-43, NFR-13 | `test/checks.test.ts` | unit |
| FR-24, FR-41, FR-42, NFR-13 | `test/checks-submit.test.ts`, `test/markdown.test.ts` | unit, integration (MCP, HTTP) |
| FR-44 | `test/ui.test.ts` | browser |
| FR-45 to FR-47 | `test/ui.test.ts`, `test/pages.test.ts` | browser |
| End to end | `scripts/e2e-local.ts`, `scripts/e2e-docs.ts`, `scripts/e2e-cr.ts`, `scripts/e2e-github.ts` | acceptance |
