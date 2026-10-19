# CR-22: tracker

This tracker lists CR-22's work items. Requirements stay in `PRD.md`, and the Covers column points
to them. The table is the index, and each item's description and definition of done are in its
block under "Items".

| ID | Parent | Type | Title | Covers | Status | Phase | Depends on | PR | Size | Start | Done | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CR-22 | | story | Serve every session's pages from one current background process on the usual address. | | in progress | plan | | | | 2026-10-19 | | |
| T-1 | CR-22 | task | Name each install's code, and record each live session. | FR-4, NFR-3 | in review | | | | 4 files, ~200 lines | 2026-10-19 | | |
| T-2 | CR-22 | task | Start one background pages process from any session or link, and stop it when unused. | FR-1, FR-2, FR-3, FR-10, NFR-1 | todo | | T-1 | | 9 files, ~450 lines | | | |
| T-3 | CR-22 | task | Restart the pages process into current code, and fall back when the new code can't serve. | FR-4, NFR-3 | todo | | T-2 | | 5 files, ~300 lines | | | |
| T-4 | CR-22 | task | Show each document's repository, the version and the stale banner, and never hang on Loading. | FR-4, FR-5, FR-6, FR-7, FR-8, NFR-2 | todo | | T-3 | | 10 files, ~450 lines | | | |
| T-5 | CR-22 | task | Run two sessions in two repositories end to end, as an acceptance script. | FR-1, FR-2, FR-6 | todo | | T-4 | | 2 files, ~200 lines | | | |
| T-6 | CR-22 | task | Tell the agent when the pages can't be served, after the requester approves the field. | FR-9 | blocked | | T-2 | | 4 files, ~120 lines | | | It waits for the requester's approval of the `pages` result field. |

Types are epic, story, task, sub-task and bug. Status is todo, in progress, in review, blocked,
done or dropped. Each task is one pull request, planned at 10 files and 500 lines at most.

## Items

### CR-22: Serve every session's pages from one current background process on the usual address.

Every session's links lead to one address. Today the pages there may belong to another repository,
stop with the first session, or run old code. This change moves them into one background process.

What is expected:
- Every link uses the usual address, and every page names its document's repository.
- The pages outlive any one session, restart into current code, and never hang on "Loading".

Out of scope:
- The README section on two sessions, restarts and removal, which CR-28 writes.

Definition of done:
- Every acceptance criterion in the PRD passes, FR-9 only once the requester approves it.
- The acceptance script runs two sessions in two repositories and passes.
- Its PRD, HLD and LLD are folded into the project documents.
- Its look back counts stale or wrong servers found by hand during the change, against a target of
  none.

### T-1: Name each install's code, and record each live session.

The other tasks decide what to restart into, and which repositories are open, from these two parts.

What is expected:
- An install's release and code ID come from its own files, without reading their contents.
- Each `hoop mcp` session records itself in the store's home folder, and removes its entry at exit.
- A reader skips an entry it can't read, and counts an entry as live only while its process runs.

Scope:
- In: `src/version.ts`, `src/sessions.ts` and their unit tests.
- Out: anything that starts or stops a process.

How to check:
- Unit tests cover release order, a code ID that changes with a file, and a live and a dead entry.
- A test reads an entry with a newer format, and one with unknown fields.

Definition of done:
- The pull request is merged within the size budget.
- Every check above passes, and each new test fails on the base first.
- Existing tests change only where the LLD says.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### T-2: Start one background pages process from any session or link, and stop it when unused.

This is the core of the change. After it, no session owns the pages.

What is expected:
- Before a result with a link, a session or command checks the address within a second, and starts
  the pages process when nothing answers.
- A holder that isn't hoop, another store, or an old hoop leaves every tool working.
- The pages process stops after the idle time with no live session and no open page.
- The info request reports the release, code, store and open repositories, with no folder path.
- The end to end scripts turn the starter on, and stop the pages process at the end.

Scope:
- In: `src/pages.ts`, `src/web.ts`, `src/cli.ts`, `src/mcp.ts`, `src/ops.ts`, `test/helpers.ts`,
  `scripts/lib.ts`, `test/pages-process.test.ts` and this tracker. That is 9 files.
- `scripts/lib.ts` starts `hoop mcp` for every end to end script, so it is the only script that
  changes.
- Out: the self restart and the page changes.

How to check:
- Process tests cover FR-1, FR-2, FR-3, FR-10 and NFR-1, each on a free port with a
  temporary home. Each test stops every process it started.
- The full test suite leaves no hoop process running.

Definition of done:
- The pull request is merged within the size budget.
- Every check above passes, and each new test fails on the base first.
- Existing tests change only where the LLD says.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### T-3: Restart the pages process into current code, and fall back when the new code can't serve.

This keeps the pages current after an update or a rollback, without losing drafts.

What is expected:
- The pages process restarts into the newest live release's install, or its own changed install.
- A successor that never answers is stopped, and the old process serves again with the warning.
- No request can start a restart.

Scope:
- In: `src/pages.ts`, `src/version.ts` and the install tests.
- Out: the banner on the pages.

How to check:
- An install test changes a temporary copy of hoop and sees the new code on the same address.
- An install test starts a successor that never answers, and sees the old process serve again.
- The NFR-3 test times page loads with the restart timer on and off.

Definition of done:
- The pull request is merged within the size budget.
- Every check above passes, and each new test fails on the base first.
- Existing tests change only where the LLD says.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### T-4: Show each document's repository, the version and the stale banner, and never hang on Loading.

This is the part a reviewer sees.

What is expected:
- A review page names its review's repository, and the tracker page picks an open repository.
- The menu shows the release, and every page warns while the server is out of date.
- A page whose code fails to load shows the error and the restart step.
- The tracker routes take a repository key, and no response holds a folder path.

Scope:
- In: `web/index.html`, `web/app.js`, `web/frame.js`, `web/tracker.js`, `src/web.ts`,
  `test/ui.test.ts`, `test/web.test.ts`, `test/frame.test.ts`, `test/tracker-page.test.ts` and this
  tracker. That is 10 files.
- Out: the acceptance script and the results notice.

How to check:
- Browser tests cover FR-4's drafts and FR-5 to FR-8, and a test covers NFR-2.
- The page checks pass in both themes, at phone width and from the keyboard.

Definition of done:
- The pull request is merged within the size budget.
- Every check above passes, and each new test fails on the base first.
- Existing tests change only where the LLD says.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### T-5: Run two sessions in two repositories end to end, as an acceptance script.

This is the acceptance run for the whole change, kept in the repository so it can run again.

What is expected:
- The script starts two sessions in two temporary repositories, and opens both trackers in a
  browser. Then it ends the first session, and checks that the pages still answer.

Scope:
- In: `scripts/e2e-pages.ts` and a `package.json` script entry.
- Out: everything else.

How to check:
- The script passes, and leaves no hoop process running.

Definition of done:
- The pull request is merged within the size budget, and the script passes after review fixes.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### T-6: Tell the agent when the pages can't be served, after the requester approves the field.

This adds a field to tool results, so it waits for the requester.

What is expected:
- A result with a link gains `pages`, with a status and a message, when the pages can't be served.

Scope:
- In: `src/ops.ts`, `src/mcp.ts`, `src/cli.ts` and their tests.
- Out: everything else.

How to check:
- Process tests cover an unavailable address and an old hoop.

Definition of done:
- The requester approved the field.
- The pull request is merged within the size budget, and each new test fails on the base first.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.
