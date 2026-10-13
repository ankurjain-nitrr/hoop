# CR-3: LLD

Status: proposed · Revision: 1 · PRD: approved (revision 5) · HLD: approved (revision 1)

How each component in the HLD is built. Paths are relative to the repository hoop works in
(`HOOP_REPO_DIR`, default the current directory).

## Change registry (`src/changes.ts`, new)

- Responsibility: change requests, their type, steps, linked reviews and pull requests.
- Data model, per change in `docs/changes/CR-<n>-<slug>/`:
  - `REQUEST.md`: the request text, byte for byte as given (FR-1). Nothing else is written to it.
  - `change.json`, owned by hoop:
    `{ id: "CR-<n>", slug, title, type: "epic"|"story"|"task"|"bug", reason, created,
       steps: [{ step, at, by }], reviews: { prd?: string[], hld?: string[], lld?: string[] }, prs: number[] }`.
    `reviews.<doc>` lists review IDs oldest first; the last one is current.
  - Invariant: `steps` is append-only and its last entry is the current step.
- Classification record, `docs/changes/CLASSIFICATION.md`: a table with one row per correction,
  `| Date | Change | Request (first line) | Was | Now | Why |`, appended by `classify` (FR-3).
- Interface:
  - `createChange(text, { title?, type, reason, slug? }) → ChangeInfo`: next number is one more than
    the highest `CR-<n>` folder; slug from the title (or the request's first line); step `intake`;
    adds the tracker row (tracker service).
  - `classify(cr, type, reason, why?)`: updates `change.json` and the tracker row; when the type
    changes and `why` is given, appends to `CLASSIFICATION.md`.
  - `moveStep(cr, step, by)`: allowed steps, in order: `intake prd hld lld plan build review accept
    merge fold`, plus `closed` from any step. Moving to `build` calls `sequencer.ready(cr)`; moving to
    `fold` checks every linked PR with `gh pr view <n> --json state` and requires `MERGED`. Records
    the step and updates the tracker row's Phase cell.
  - `linkPr(cr, number)`, `getChange(cr)`, `listChanges()`.
- Errors: `HoopError` with field paths; refusals say what is missing and the command that fixes it
  (NFR-1), for example `HLD review rv_x is not approved; run hoop feedback rv_x`.

## Review sequencer (`src/sequence.ts`, new)

- Responsibility: the PRD → HLD → LLD order and staleness (FR-4, FR-5, FR-7).
- Linking: `submit` and `submit_markdown` accept `change: { cr, doc }`. Before a review opens, the
  sequencer checks the predecessor (`prd` for `hld`, `hld` for `lld`): its current review must be
  approved and not stale. On success the review ID is appended to `reviews.<doc>` and the step
  moves to `doc` if it is behind it.
- Staleness, computed rather than stored: a document's current approval is stale when its
  predecessor's current review was approved after it (the predecessor was revised and approved
  again), or when the predecessor's current review isn't approved. Revising an approved document
  starts a superseding review (existing behavior), which becomes the current one.
- `ready(cr) → { ok, missing: string[] }`: all three current reviews approved and none stale.
- Reviews without a `change` link are unsequenced and behave as today (NFR-2).

## Tracker service (`src/tracker.ts`, new)

- Responsibility: read and write `docs/TRACKER.md` (or a change's `TRACKER.md`) as a tree (FR-8).
- Parsing: the first markdown table whose header has `ID` and `Parent`; columns by header name, so
  existing trackers without `Type` or `Phase` still load (NFR-2). Each row keeps its original text.
- Data model: `TrackerItem { id, parent?, type?, title, status?, phase?, cells: Record<column, string>,
  line: number }`; `tree()` nests items by `parent`; an unknown parent makes an item a root.
- Interface: `readTracker(path) → { columns, items, tree }`; `setCells(path, id, cells)` rewrites only
  that row; `addItem(path, cells, after?)` inserts a row; a missing column is added to the header
  with an empty cell on every row.
- Concurrency: writes read the file, check its hash against the read the change was based on, and
  refuse if it changed underneath (HLD risk); writes are atomic (temp file and rename).

## Agent interfaces (`src/mcp.ts`, `src/cli.ts`, extended)

| Operation | Agent tool | Terminal command |
|---|---|---|
| Capture a request | `hoop_cr_create` | `hoop cr create --type <t> --reason <r> [--title <t>] < request.txt` |
| Classify | `hoop_cr_classify` | `hoop cr classify <CR> <type> --reason <r> [--why <w>]` |
| Move a step | `hoop_cr_step` | `hoop cr step <CR> <step>` |
| Show a change | `hoop_cr_get` | `hoop cr show <CR>` |
| Link a PR | `hoop_cr_link_pr` | `hoop cr link-pr <CR> <number>` |
| Read the tracker | `hoop_tracker_get` | `hoop tracker [--file <path>] [--json]` |
| Change the tracker | `hoop_tracker_set` | `hoop tracker set <ID> <column>=<value>...` |
| Submit a document | `hoop_submit`, `hoop_submit_markdown` (+ `change`) | `hoop submit <file> [--review <id>] [--cr <CR> --doc <prd\|hld\|lld>] [--channel github]` |
| Read feedback | `hoop_feedback` | `hoop feedback <review_id>` |
| Propose edits | `hoop_propose_edits` | `hoop propose <review_id> <thread> <edits.json>` |
| Reply | `hoop_reply` | `hoop reply <thread> <text>` |
| Export | `hoop_export` | `hoop export <review_id> [--out <file>]` |

Every command prints JSON with `--json` and readable text otherwise; failures exit 1 with the same
message the tool returns (FR-11).

## Web (`src/web.ts`, `web/tracker.js`, extended)

- `GET /tracker` serves the page; `GET /api/tracker[?file=<path>]` returns `readTracker` for the
  repository the server was started in. The path must stay inside the repository.
- `web/tracker.js` renders the tree table: one row per item, indented by depth, a caret to expand
  and collapse, type badges, status and phase chips, and type and status filters (FR-9).
- Review pages: when a review's document contains a tracker table, the item's lines render through
  the same tree table, and each row keeps its line anchor, so comments work as before (FR-10).

## devloop skill (skills repository, outside hoop)

- `project-docs` and `devloop` call `hoop cr create` first, classify with the guidance and the
  classification record, submit each document with `--cr/--doc` (so hoop enforces the order), move
  steps with `hoop cr step`, and update the tracker with `hoop tracker set` (FR-12).
- Every change gets a PRD, HLD and LLD, sized to it; the small-fix tier is removed.

## Errors

- Refusals: out-of-order document, stale approval, build without approvals, fold with open PRs,
  tracker changed underneath, path outside the repository. Each names the review, PR or file and the
  next command.

## Test plan

| Requirement | Test | Level |
|---|---|---|
| FR-1 | `REQUEST.md` equals the input byte for byte; numbering; tracker row at intake | unit |
| FR-2, FR-3 | reclassify updates `change.json` and the row; a correction appends to `CLASSIFICATION.md` | unit |
| FR-4 | HLD before an approved PRD is refused; after approval accepted; same for LLD | unit |
| FR-5 | a re-approved PRD makes the HLD and LLD stale and `ready` false | unit |
| FR-6, FR-7 | step history; build refused without approvals; fold refused with an open PR (fake `gh`) | unit |
| FR-8 | tracker round trip byte-identical; `setCells` changes only its cells; hash conflict refused | unit |
| FR-9, FR-10 | tree table renders, collapses and filters; a tracker review keeps commentable rows | browser |
| FR-11 | each terminal command against a temp repository | integration |
| FR-12 | devloop trigger tests; a headless run captures before writing a PRD and doesn't write an HLD early | skill |
| NFR-2 | the current project tracker and CR-1 and CR-2 load unchanged | unit |
| End to end | one change from capture through PRD, HLD, LLD, build, merge and fold | acceptance script |
