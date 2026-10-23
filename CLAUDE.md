# CLAUDE.md

## Vision

hoop lets people review what an agent writes the way they review code. Claude submits a document
over MCP; people comment on lines or selected words, suggest changes and answer questions on a local
page; Claude reads the review back as data. Only people review, and hoop imposes no document
template. `README.md` describes the product and `docs/DESIGN.md` how it works.

## Settled decisions

- One contract (`src/contract.ts`, `hoop/review@0` and `hoop/feedback@0`) for every document.
- Storage is JSON files in `~/.hoop/reviews/<id>/`, not SQLite: Node 18 has no built-in SQLite, and
  native modules break `npx` installs. Node 18.18+ is the runtime floor.
- The pages run on 127.0.0.1:4747 in one background pages process that sessions and commands start,
  and that no session owns. The API refuses a foreign Host, a foreign Origin and non-JSON writes
  (cross-site approval was a real bug).
- Approving and requesting changes need a GitHub sign-in on the page; a comment doesn't. hoop writes
  nothing into the repository.
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
- Acceptance runs: `scripts/e2e-local.ts`, `scripts/e2e-docs.ts` and `scripts/e2e-pages.ts` (two
  sessions in two repositories), on Node 22.

## Testing

- `npm test` and `npm run typecheck` run on Node 18; browser tests skip there.
- Browser tests and full runs need Node 20+ and Chrome: `~/.nvm/versions/node/v22.12.0/bin/node
  node_modules/tsx/dist/cli.mjs --test test/*.test.ts`, and the same node for the `scripts/e2e-*.ts`
  runs. Set `HOOP_REQUIRE_BROWSER=1` so a missing browser fails the run instead of skipping.
- `test/pages.test.ts` checks every page in both themes, at 400 pixels, from the keyboard, with
  other hosts blocked and with `axe-core`. Keep it green when a page changes.
- Tests use temp `HOOP_HOME` and `HOOP_REPO_DIR` (`test/helpers.ts`).
- `test/fixtures/interface.json` records the tools and `hoop help`; `HOOP_UPDATE_FIXTURE=1`
  rewrites it after a deliberate change. `npx tsx scripts/schemas.ts` regenerates `schemas/` and the
  README's field tables after a contract change.
- `test/fixtures/docs/` holds sample markdown (tables, lists, code, nested headings, Mermaid) that
  the block tests parse.

## Gotchas

- The global `hoop` runs from the main clone's `dist/` and `web/`, so do work in a git worktree,
  never on the main clone's branch, and run `npm run build` in the main clone after a merge.
- Write U+2028 in code as the escape ` `, never as the raw character. Some editing tools turn
  the escape into the raw character, and a raw one inside a regex breaks the page module. Check
  with `grep -c $'\xe2\x80\xa8' web/*.js src/*.ts`.
- Any CSS `display` overrides the `hidden` attribute; `app.css` sets `[hidden] { display: none !important; }`.
- The sticky header covers scrolled-to items; `html { scroll-padding-top }` keeps them clear.
- macOS has no `timeout` (use `perl -e 'alarm N; exec @ARGV'`); this machine's git lacks
  `git stash push -- <paths>`.
- Merging stacked PRs: merge one, retarget the next to `main`, and only then delete the merged
  branch. GitHub closes a PR whose base branch is deleted, and it can't be reopened once its head
  is force-pushed.
- Agent tools and terminal commands both come from `OPS` in `src/ops.ts`. Add an operation there
  (name, schema, run, and its `cli` mapping), not in `mcp.ts` or `cli.ts`.
- Shared helpers live in `src/util.ts`: `HoopError`, `repoDir()`, `hoopHome()`, `currentUser()`,
  `hoopConfig()`, `writeAtomic()` and `slugify()`. The markdown block grammar (`TABLE_DELIM` and the
  other patterns) lives in `web/blocks.js`, shared by the parser and the page. The rules about
  whether a review can change and the thread lookup live in `src/rules.ts`. Use them; don't
  re-derive environment defaults or block parsing.
