# CLAUDE.md

## Vision

hoop lets people review what an agent writes the way they review code. Claude submits a document
over MCP; people comment on lines or selected words, suggest changes and answer questions on a local
page; Claude reads the review back as data. Only people review, and hoop imposes no document
template. `README.md` describes the product and `docs/DESIGN.md` how it works.

## Settled decisions

- One contract (`src/contract.ts`, `hoop/review@0` and `hoop/feedback@0`) for every document.
- Storage is JSON files, not SQLite: `node:sqlite` is still experimental in Node 22, and native
  modules break `npx` installs. Node 22.12+ is the runtime floor. Each Claude Code session keeps its
  reviews in `<claude dir>/projects/<folder>/<session-id>/.hoop/reviews/<id>/`; a process without
  one uses `~/.hoop/reviews/<id>/`. `~/.hoop/index.json` maps review IDs to session folders.
- The pages run on 127.0.0.1:4747 in one background pages process that sessions and commands start,
  and that no session owns. The API refuses a foreign Host, a foreign Origin and non-JSON writes
  (cross-site approval was a real bug).
- Approving and requesting changes need no sign-in: Claude has no tool to approve and is told never
  to, so only people approve, on the review page. hoop writes nothing into the repository.
- Anchors: `{item, line}`; line 0 is a heading (scope: its section); item `DOC` line 1 is the title,
  2 the TL;DR (scope: whole document). Thread and edit IDs embed the review ID.
- Materializing: reviewers Apply exact suggestions; Claude proposes span edits
  (`hoop_propose_edits`, `find`/`replace`) that reviewers accept as tracked changes. Text outside
  an accepted span stays byte-identical; a proposal applies only while its line reads exactly as
  when proposed; in documents, edits can't change markdown structure or empty a line.
- Markdown (`src/markdown.ts`): a line is a block whose source lines are joined with U+2028, so an
  unedited document exports byte for byte; section IDs stay stable across revisions by heading.

## Changing hoop

- An ordinary branch and pull request, in a worktree (see Gotchas). Keep each PR small, with tests
  for what it adds and a regression test for each defect it fixes.
- Before a PR: `npm run typecheck`, `npm run lint`, and the full suite with the browser (below).
  The push hook (`scripts/pre-push.mjs`) runs only the tests that name the branch's changes, without
  the browser, so don't rerun the full suite for a merge or a small fix; CI runs it and blocks merging.
- Acceptance runs: `scripts/e2e-local.ts`, `scripts/e2e-docs.ts` and `scripts/e2e-pages.ts` (two
  sessions in two repositories), on Node 22.

## Testing

- CI runs `npm test`, `npm run typecheck` and `npm run lint` on Node 22 and 24; browser tests skip
  without Chrome. This machine's default `node` is 18, below the floor, so use Node 22.
- Browser tests and full runs need Chrome: `~/.nvm/versions/node/v22.12.0/bin/node
  node_modules/tsx/dist/cli.mjs --test test/*.test.ts`, and the same node for the `scripts/e2e-*.ts`
  runs. Set `HOOP_REQUIRE_BROWSER=1` so a missing browser fails the run instead of skipping.
- `test/pages.test.ts` checks every page in both themes, at 400 pixels, from the keyboard, with
  other hosts blocked and with `axe-core`. Keep it green when a page changes.
- Tests use temp `HOOP_HOME` and `HOOP_REPO_DIR` (`test/helpers.ts` sets both for every test and
  every process it starts), act as the Claude Code session
  `test-session-0000`, and read session titles from a temp `HOOP_CLAUDE_DIR`, never `~/.claude`.
- `test/fixtures/interface.json` records the tools and `hoop help`; `HOOP_UPDATE_FIXTURE=1`
  rewrites it after a deliberate change. `npx tsx scripts/schemas.ts` regenerates `schemas/` after
  a contract change.
- `test/fixtures/docs/` holds sample markdown (tables, lists, code, nested headings, Mermaid) that
  the block tests parse.

## Gotchas

- The global `hoop` runs from the main clone's `dist/` and `web/`, so do work in a git worktree,
  never on the main clone's branch, and run `npm run build` in the main clone after a merge.
- macOS has no `timeout` (use `perl -e 'alarm N; exec @ARGV'`); this machine's git lacks
  `git stash push -- <paths>`.
- Agent tools and terminal commands both come from `OPS` in `src/ops.ts`. Add an operation there
  (name, schema, run, and its `cli` mapping), not in `mcp.ts` or `cli.ts`.
- Shared helpers live in `src/util.ts`: `HoopError`, `repoDir()`, `hoopHome()`, `currentUser()`,
  `writeAtomic()` and `slugify()`. The markdown block grammar (`TABLE_DELIM` and the
  other patterns) lives in `web/blocks.js`, shared by the parser and the page. The rules about
  whether a review can change and the thread lookup live in `src/rules.ts`. Use them; don't
  re-derive environment defaults or block parsing.
