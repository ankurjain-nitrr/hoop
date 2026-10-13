# CLAUDE.md

## Vision

hoop lets people review what an agent writes the way they review code: decisions, requirements,
plans, or any document. Claude submits a JSON document over MCP; people comment on lines or
selected text, suggest changes and answer questions; Claude reads the review back as data.
Comments can be materialized as edits that change as few words as possible. Not specific to
engineering: keep wording neutral. Current state: `docs/PRD.md`, `docs/HLD.md`, `docs/LLD.md` and
`docs/TRACKER.md`; the initial build's history is `docs/changes/CR-1-initial-build/`.

## Settled decisions (change only through the PRD, see "Changing hoop")

- One contract (`src/contract.ts`, `hoop/review@0` and `hoop/feedback@0`) over two channels: the
  local page and a GitHub PR. Both produce the same feedback document.
- Storage is JSON files in `~/.hoop/reviews/<id>/` (rev 6: not SQLite; Node 18 has no built-in
  SQLite and native modules break `npx` installs). Node 18.18+ is the runtime floor.
- `hoop mcp` (stdio) also serves the page on 127.0.0.1:4747. The API refuses a foreign Host, a
  foreign Origin and non-JSON writes (cross-site approval was a real bug).
- GitHub: merge approves, closing rejects; GitHub reviews are read-only on the local page;
  materializing is local only (GitHub's Commit suggestion covers that side).
- Anchors: `{item, line}`; line 0 is a heading (scope: its section); item `DOC` line 1 is the title,
  2 the TL;DR (scope: whole document). Thread and edit IDs embed the review ID.
- Materializing: reviewers Apply exact suggestions; Claude proposes span edits
  (`hoop_propose_edits`, `find`/`replace`) that reviewers accept as tracked changes. Text outside
  an accepted span stays byte-identical; a proposal applies only while its line reads exactly as
  when proposed; in documents, edits can't change markdown structure or empty a line.
- Markdown (`src/markdown.ts`): a line is a block whose source lines are joined with U+2028, so an
  unedited document exports byte for byte; section IDs stay stable across revisions by heading.

## Changing hoop

- Every change follows devloop (`/devloop:devloop`, 0.9.0+) as a change request in
  `docs/changes/CR-<n>-<slug>/` (next: CR-2), with its PRD, HLD, LLD and tracker reviewed and
  materialized through hoop itself (`/devloop:project-docs`), then folded into `docs/` after merge.
- Candidate work is in `docs/TRACKER.md` (`B-*` rows); none is scoped until it becomes a CR.
- Acceptance runs are `scripts/e2e-local.ts`, `scripts/e2e-docs.ts` and `scripts/e2e-github.ts` (see Testing).
- `hoop audit` shows where Claude's tool calls fail and how its edits fare; check it before changing
  tool descriptions or edit rules.

## Testing

- `npm test` and `npm run typecheck` on Node 18; browser tests skip there.
- Browser tests and full runs need Node 20+ and Chrome: use `~/.nvm/versions/node/v22.12.0/bin/node
  node_modules/tsx/dist/cli.mjs --test test/*.test.ts`, and the same node for
  `scripts/e2e-local.ts` and `scripts/e2e-docs.ts`.
- `HOOP_E2E_REPO=ankurjain-nitrr/hoop-sandbox npx tsx scripts/e2e-github.ts` runs the GitHub
  channel live; it leaves a merged decision PR in the sandbox.
- Tests use temp `HOOP_HOME` and `HOOP_REPO_DIR` (`test/helpers.ts`); without the latter an approval
  writes `decisions/` into this repo. GitHub logic is tested with `fakeGh` in `test/github.test.ts`.

## Gotchas

- Any CSS `display` overrides the `hidden` attribute; `app.css` sets `[hidden] { display: none !important; }`.
- The sticky header covers scrolled-to items; `html { scroll-padding-top }` keeps them clear.
- A PR author can't approve their own PR on GitHub, so solo GitHub reviews approve by merging.
- macOS has no `timeout` (use `perl -e 'alarm N; exec @ARGV'`); this machine's git lacks
  `git stash push -- <paths>`.
