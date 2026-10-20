# CLAUDE.md

## Vision

hoop lets people review what an agent writes the way they review code: decisions, requirements,
plans, or any document. Claude submits a JSON document over MCP; people comment on lines or
selected text, suggest changes and answer questions; Claude reads the review back as data.
Comments can be materialized as edits that change as few words as possible. Not specific to
engineering: keep wording neutral. Current state: `docs/PRD.md`, `docs/HLD.md`, `docs/LLD.md` and
`docs/TRACKER.md`; the initial build's history is `docs/changes/CR-1-initial-build/`.

## devloop lives here

The devloop plugin is in `plugins/devloop/`, and this repository is its marketplace
(`.claude-plugin/marketplace.json`). devloop always runs on hoop, so the two change together. Bump
the version in `plugins/devloop/.claude-plugin/plugin.json` with every devloop change. After it
merges, run `claude plugin marketplace update hoop` and `claude plugin update devloop@hoop`.
devloop's own skills and agents stay free of hoop's internals, so they work in any project that
uses hoop.

## Settled decisions (change only through the PRD, see "Changing hoop")

- One contract (`src/contract.ts`, `hoop/review@0` and `hoop/feedback@0`) over two channels: the
  local page and a GitHub PR. Both produce the same feedback document.
- Storage is JSON files in `~/.hoop/reviews/<id>/` (rev 6: not SQLite; Node 18 has no built-in
  SQLite and native modules break `npx` installs). Node 18.18+ is the runtime floor.
- The pages run on 127.0.0.1:4747 in one background pages process that sessions and commands
  start, and that no session owns (CR-22). The API refuses a foreign Host, a foreign Origin and
  non-JSON writes (cross-site approval was a real bug).
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
- Acceptance runs are `scripts/e2e-local.ts`, `scripts/e2e-docs.ts`, `scripts/e2e-cr.ts` (a change from
  capture to fold through the commands), `scripts/e2e-pages.ts` (two sessions in two repositories)
  and `scripts/e2e-github.ts` (see Testing).
- `hoop audit` shows where Claude's tool calls fail and how its edits fare; check it before changing
  tool descriptions or edit rules.

## Testing

- `npm test` and `npm run typecheck` on Node 18; browser tests skip there.
- Browser tests and full runs need Node 20+ and Chrome: use `~/.nvm/versions/node/v22.12.0/bin/node
  node_modules/tsx/dist/cli.mjs --test test/*.test.ts`, and the same node for
  `scripts/e2e-local.ts`, `scripts/e2e-docs.ts` and `scripts/e2e-cr.ts` (which also needs a gh login).
  Set `HOOP_REQUIRE_BROWSER=1` on a full run, so a missing browser fails it instead of skipping.
- `test/pages.test.ts` checks every page in both themes, at 400 pixels, from the keyboard, with
  other hosts blocked and with `axe-core`. Keep it green when a page changes.
- `HOOP_E2E_REPO=ankurjain-nitrr/hoop-sandbox npx tsx scripts/e2e-github.ts` runs the GitHub
  channel live; it leaves a merged decision PR in the sandbox.
- Tests use temp `HOOP_HOME` and `HOOP_REPO_DIR` (`test/helpers.ts`); without the latter an approval
  writes `decisions/` into this repo. GitHub logic is tested with `fakeGh` in `test/github.test.ts`.

## Document checks on submit (CR-10)

This repository checks its own markdown documents on every submit. `hoop.config.json` runs
`scripts/check-writing.sh`, which runs devloop's writing checker on the document. The check runs
only after the maintainer allows it on their machine. To allow it, the maintainer adds this entry
to `~/.hoop/config.json`, with the repository's absolute folder:

```json
{ "checks": [{ "repo": "/absolute/path/to/hoop", "command": ["sh", "scripts/check-writing.sh"] }] }
```

Agents never add the entry themselves. When a submit says the check isn't allowed, ask the
maintainer to add it.

The check needs `python3`. It runs the writing checker in `plugins/devloop/`, from the same
checkout, so it always matches this repository's devloop. To use another checker, set
`DEVLOOP_WRITING_CHECKER` in the environment of the hoop server, such as the MCP server's entry, not
in the agent's shell. The script exits with code 2 when the checker is missing or crashes, so hoop
reports that the check didn't run.

## Reviewing documents in hoop (for agents)

Agents review a document by commenting on it in hoop, and the owner answers in the threads. This is
how devloop's reviewer and owner agents work with hoop.

- Read a review with `curl -s http://localhost:${HOOP_PORT:-4747}/api/reviews/<review_id>`. Each
  item has an `id` and `lines`. A comment's `line` is the index in `lines` plus one. Line 0 is the
  item's heading. Item `DOC` line 1 is the title, and line 2 is the TL;DR.
- Earlier comments and their thread IDs are in `feedback`, and the owner's replies are in `replies`.
- A reviewer posts comments in one request. Write a JSON file that holds `{"verdict": "comment",
  "reviewer": "<role> (agent)", "summary": "<one line>", "comments": [...]}`. Each comment holds
  `item`, `line` and `body`, and may hold a `range` (`start`, `end` and the exact `quote`) or a
  `suggestion`.
- To reply in a thread, a reviewer adds the thread's `thread` ID with its `item` and `line`.
- Send the file with `curl -s -X POST http://localhost:${HOOP_PORT:-4747}/api/reviews/<review_id>/feedback -H 'content-type: application/json' --data @<file>`.
- Agents always use the verdict "comment". Only the requester approves or requests changes.
- The owner reads comments with `hoop feedback <review_id>` and replies with
  `hoop reply <thread> "<role> (owner): <text>"`. The owner changes the document with
  `hoop submit <file> --review <review_id>`, or with a tracked change through `hoop propose`.
- The owner records a final call as a reply that starts with "Decision:".
- Every agent thread is resolved before the requester reviews. A feedback request resolves threads
  through `resolved_threads`, a list of thread IDs, and may hold no comments.
- Resolve before submitting the final revision. Feedback on the latest revision counts as a review,
  so `hoop wait` would otherwise return at once. The resolution stays on the earlier revision, and
  the threads stay resolved on the new one.
- An approved review is frozen and refuses feedback, so resolve before the requester approves.

## Gotchas

- Write U+2028 in code as the escape `\u2028`, never as the raw character. Some editing tools turn
  the escape into the raw character, and a raw one inside a regex breaks the page module. Check
  with `grep -c $'\xe2\x80\xa8' web/*.js src/*.ts`.
- Any CSS `display` overrides the `hidden` attribute; `app.css` sets `[hidden] { display: none !important; }`.
- The sticky header covers scrolled-to items; `html { scroll-padding-top }` keeps them clear.
- A PR author can't approve their own PR on GitHub, so solo GitHub reviews approve by merging.
- macOS has no `timeout` (use `perl -e 'alarm N; exec @ARGV'`); this machine's git lacks
  `git stash push -- <paths>`.
- Merging stacked PRs: merge one, retarget the next to `main`, and only then delete the merged
  branch. GitHub closes a PR whose base branch is deleted, and it can't be reopened once its
  head is force-pushed (#28, #29 and #31 had to be reopened as #32 to #34).
- Shared helpers live in `src/util.ts`: `HoopError`, `repoDir()`, `hoopHome()`, `currentUser()`,
  `writeAtomic()`, `slugify()`, and the table-row helpers `TABLE_DELIM` and `splitRow`. The rules
  about whether a review can change (open, frozen, on GitHub) and the thread lookup live in
  `src/rules.ts`. Use them; don't
  re-derive environment defaults or table parsing.
- Agent tools and terminal commands both come from `OPS` in `src/ops.ts`. Add an operation
  there (name, schema, run, and its `cli` mapping), not in `mcp.ts` or `cli.ts`.
