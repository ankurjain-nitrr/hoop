# CR-8: intake notes

Captured 2026-10-13, during CR-3's build. State: queued. Proposed type: epic (several independent
refactors). Proposed kind: non-functional (no behavior changes; the test suite is the check).
Project: hoop.

## Survey (main plus the open CR-3 branches, about 2,600 lines of source)

Debt that CR-3's own open PRs introduced is fixed in those PRs rather than here (see "Overlap").
What CR-8 itself covers:

| # | Where | Problem | Change |
|---|---|---|---|
| R-1 | `src/hoop.ts` (400 lines) | One class does submit and channels, feedback, materializing (apply, propose, decide, rebase), decisions and replies | Move materializing (about 170 lines) to `src/materialize.ts`; `Hoop` stays the facade |
| R-2 | `src/hoop.ts` | The same guards repeat: `status !== "open"` (3×), GitHub-channel refusals (3×), finding a thread's root comment and revision (3×) | `openLocal(id, why)` and `store.thread(id, thread)` helpers |
| R-3 | `src/store.ts` | `update(id, {})` is used only to bump `updated` (4×) | `touch(id)` |
| R-4 | `src/markdown.ts`, `src/changes.ts` | Two `slugify` functions with different limits and fallbacks | One `slugify(text, max)` |
| R-5 | `web/review.js` | POST plus JSON headers (3×), toast plus timed removal (3×) | `post(path, body)` and `flash(message)` in `app.js` |
| R-6 | `scripts/e2e-*.ts` | Each script copies the MCP call and step helpers | `scripts/lib.ts` |
| R-7 | `test/ui.test.ts`, `test/tracker-page.test.ts` | Each copies the server and Chrome setup | `withBrowser` in `test/helpers.ts` |
| R-8 | `src/github.ts` | Nine type casts on `gh api` responses | Typed `api<T>` responses for the endpoints used |

Not worth changing now: `store.findThread` scans every review for GitHub thread IDs (fine at
current scale); `new Date().toISOString()` repeated inline.

## Overlap

- CR-3 (in build, PRs #27 to #31 open): CR-8 touches the same files, so it runs after CR-3 merges
  and folds. The debt CR-3 introduced is fixed inside CR-3's PRs, as review fixes:
  - Table-row parsing exists three times (`src/tracker.ts`, `web/tree.js`, `src/markdown.ts`), and
    the copies disagree (`|-|` is a tracker separator but not a markdown table). Fix: one parser
    in `src/table.ts`; the review API sends parsed tracker tables, so the browser doesn't parse.
  - `process.env.HOOP_REPO_DIR ?? process.cwd()` is repeated in 6 places. Fix: `repoDir()` with
    `HOOP_HOME` and the port in `src/config.ts`.
  - `HoopError` lives in `src/hoop.ts`, so the registry, sequencer and tracker import the core,
    making an import cycle. Fix: `src/errors.ts`.
  - The atomic write is copied 3× and the default actor (`userInfo().username`) 6×. Fix: one
    helper each.
  - T-5 (still to build) defines each operation once (name, schema, handler, description) and
    generates both the MCP tool and the terminal command from it. That removes today's
    try/result/failure boilerplate in each of the 8 tools, which T-5's 7 new tools would repeat,
    and is HLD decision D-4 (the terminal mirrors the tools one to one).
- CR-6, CR-7, CR-4 (queued): all change `src/hoop.ts`, `web/review.js` or `web/app.js`. Doing R-1,
  R-2 and R-5 first makes those changes smaller. Resolution: CR-8 runs right after CR-3, before
  CR-6.
- CR-5 (queued, documents): R-1 adds a module to the project HLD's component list; CR-8's fold
  updates it, and CR-5 then rewrites the HLD with it.

Queue order: CR-8, CR-6, CR-5, CR-7, CR-4 (all after CR-3).
