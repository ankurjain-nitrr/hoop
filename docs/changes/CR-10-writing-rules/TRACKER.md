# CR-10: tracker

This tracker lists CR-10's work items. Requirements stay in `PRD.md`, and the Covers column points
to them. The table is the index, and each item's description and definition of done are in its
block under "Items".

| ID | Parent | Type | Title | Covers | Status | Phase | Depends on | PR | Size | Start | Done | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CR-10 | | story | Run the project's document checks when a document is submitted, and show the findings. | | in progress | build | | | | 2026-10-14 | | |
| ST-1 | CR-10 | story | As an agent, I learn of writing problems in the result when I submit a document. | FR-1, FR-2, FR-3, FR-4, FR-5, FR-7, NFR-1, NFR-2 | in progress | | | | | 2026-10-19 | | |
| T-1 | ST-1 | task | Run an allowed check command on a document, and read its findings. | FR-1, FR-2, FR-4, FR-5, NFR-1 | done | | | #74 | 4 files, ~330 lines | 2026-10-19 | 2026-10-19 | The fresh review found 5 defects. The worst was a checker that ignored SIGTERM, which could hang the runner. |
| T-2 | ST-1 | task | Map each source line of a markdown document to its item line. | FR-6 | done | | | #75 | 3 files, ~170 lines | 2026-10-19 | 2026-10-19 | The fresh review found no code defect, only two test gaps: a loose parity check and no unclosed fence. |
| T-3 | ST-1 | task | Return, store and audit each submission's check outcome. | FR-3, FR-7, NFR-2 | done | | T-1, T-2 | #76 | 8 files, ~310 lines | 2026-10-19 | 2026-10-19 | The fresh review found that a check's message could carry folder paths to the page, and that hoop audit didn't print the counts. |
| T-5 | ST-1 | task | Check hoop's own documents with devloop's writing checker on every submit. | FR-1 | todo | | T-3 | | ~3 files, ~60 lines | | | |
| ST-2 | CR-10 | story | As a reviewer, I see the checker's findings beside the lines they concern. | FR-6 | done | | | | | 2026-10-19 | 2026-10-19 | |
| T-4 | ST-2 | task | Show the latest checked revision's findings in a panel on the review page. | FR-6 | done | | T-3 | #77 | 7 files, ~250 lines | 2026-10-19 | 2026-10-19 | The fresh review found 4 defects: no jump to tracker rows, a stuck open item, lost focus and a stale finding on the wrong line. |

Types are epic, story, task, sub-task and bug. Status is todo, in progress, in review, blocked,
done or dropped. The order is T-1, T-2, T-3, T-4 and then T-5. T-1 and T-2 are independent, so
either can go first. Each task is one pull request, planned at 8 files at most.

## Items

### CR-10: Run the project's document checks when a document is submitted, and show the findings.

Agents learn of writing problems only when they remember to run the checker, and reviewers never
see the findings. This change runs the project's own check on every submitted markdown document.

What is expected:
- An agent gets each finding, with its line, in the submit result.
- A reviewer sees the findings of the latest checked revision on the review page.
- A check runs only for a command that the user allowed, and never blocks a submission.

Out of scope:
- Checks on JSON reviews, panels on GitHub, and tracker titles that hoop writes.

Definition of done:
- Every story under it is done.
- The success metrics in the PRD can be measured with `hoop audit`.
- The acceptance run passes for every requirement it covers.
- Its PRD, HLD and LLD are folded into the project documents.

### ST-1: As an agent, I learn of writing problems in the result when I submit a document.

An agent that submits a document gets the project's check findings at once. So it can fix them
before a reviewer reads the document.

What is expected:
- FR-1 to FR-5, FR-7, NFR-1 and NFR-2 in the PRD hold, each with its acceptance criteria.

Out of scope:
- The review page, which ST-2 covers.

Definition of done:
- Each acceptance criterion above passes in a test.
- An agent can submit a document in hoop's repository and read its findings in the result.
- T-1, T-2, T-3 and T-5 are merged.

### T-1: Run an allowed check command on a document, and read its findings.

This is the check runner that the HLD names. It decides whether a check may run, runs it safely,
and turns its output into findings. Nothing calls it until T-3. It covers five requirements, because
they are the rules of one small module, and splitting them would leave a runner that isn't safe.

What is expected:
- `runCheck(repo, markdown, home)` in `src/checks.ts` returns an outcome, as the LLD describes.
- A command runs only when the user's config allows that exact command for that folder.
- With a command but no matching entry, the outcome is `not_allowed`, and it holds the entry to ask
  for.
- Exit codes 0 and 1 give findings. Other codes, a missing command and a timeout don't.
- Only `path:line: message` lines become findings.
- The command runs with `execFile` and no shell.

Scope:
- In: the new `src/checks.ts` and `test/checks.test.ts`, a recorded copy of devloop's checker
  output in `test/fixtures/`, and this tracker.
- Out: placing findings on lines, which T-2 does. Calling the runner, which T-3 does.

How to check:
- Unit tests with small fake commands cover each exit code, a missing command, a timeout, and a
  changed command.
- A unit test feeds the recorded checker output to the parser, and checks that only its finding
  lines become findings.
- A unit test submits a document whose text looks like a shell command, and checks that the command
  that runs doesn't change.

Definition of done:
- The change is merged in one pull request within the size budget.
- Every check above passes, and each new test fails on the base first.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### T-2: Map each source line of a markdown document to its item line.

A finding names a source line, but the page shows item lines. This task gives the markdown parser
the map between them, so the rule lives with the parser.

What is expected:
- `linePlaces(markdown, options)` in `src/markdown.ts` returns a map from a source line number to
  `{ index, line }`, as the LLD describes.
- A source line inside a joined line maps to that joined line. A heading or blank line has no place.

Scope:
- In: `src/markdown.ts`, `test/markdown.test.ts`, and this tracker.
- Out: mapping an index to an item ID, which T-3 does.

How to check:
- Unit tests place findings on a list item, a continuation line, a code block and a heading.
- They cover documents with and without a title.
- A test shows that the places agree with `itemLines` for every markdown file in `docs/`.

Definition of done:
- The change is merged in one pull request within the size budget.
- Every check above passes, and each new test fails on the base first.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### T-3: Return, store and audit each submission's check outcome.

This task connects the runner to a submission. It is the first time an agent sees findings, so it
also covers how the outcome is stored and measured.

What is expected:
- `hoop_submit_markdown` and `hoop submit` return `checks` when a check was attempted, on both
  channels.
- The store keeps each outcome in `checks-<revision>.json`. A `running` outcome is written first,
  with its start time.
- `GET /api/reviews/<id>` gains `checks` without the allow entry, so no folder path reaches the page.
- The audit log records each outcome, and `hoop audit` counts checks run, findings and failed checks.
- JSON reviews and repositories without a config run nothing.

Scope:
- In: `src/hoop.ts`, `src/ops.ts`, `src/store.ts`, `src/audit.ts`, `src/web.ts`,
  `test/fixtures/interface.json`, the new `test/checks-submit.test.ts`, and this tracker.
- Out: the panel, which T-4 builds.

How to check:
- An integration test submits through the agent tool and checks the result and the stored outcome.
- A test with `fakeGh` checks a GitHub submission's result.
- A test shows that the page answers while a five second check runs.
- A test shows that a running outcome older than the timeout reads as stopped.
- The interface snapshot test passes with the updated description.

Definition of done:
- The change is merged in one pull request within the size budget.
- Every check above passes, and each new test fails on the base first.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### T-5: Check hoop's own documents with devloop's writing checker on every submit.

This project is developed with devloop, so its own design documents should be checked as soon as T-3
lands. This puts the change to work on hoop's own development at once.

What is expected:
- The repository's `hoop.config.json` names a small script in the repository.
- The script finds devloop's checker on the machine and runs it, or says it can't find it.
- `CLAUDE.md` tells the maintainer the allow entry to add to their own hoop config.

Scope:
- In: `hoop.config.json`, the new `scripts/check-writing.sh`, `CLAUDE.md`, and this tracker.
- Out: any change to devloop itself.

How to check:
- Submitting a document with a known finding in hoop's repository returns that finding.
- Without devloop installed, the script exits with a code other than 0 or 1, so the check reads as
  not run.

Definition of done:
- The change is merged in one pull request within the size budget.
- Every check above passes.
- Every finding from the fresh review is fixed.
- The row's PR, actual size, dates and notes are filled in.

### ST-2: As a reviewer, I see the checker's findings beside the lines they concern.

A reviewer can see the problems the checker found without spotting each one, and can jump to the
line.

What is expected:
- FR-6 in the PRD holds, with its acceptance criteria.

Out of scope:
- Panels on GitHub.

Definition of done:
- FR-6's acceptance criteria pass in a browser test.
- A reviewer can open a checked review and jump from a finding to its line.
- T-4 is merged.

### T-4: Show the latest checked revision's findings in a panel on the review page.

The view already holds the outcome after T-3. This task shows it, and links each finding to its
line.

What is expected:
- `web/checks.js` renders the panel, as the LLD describes.
- The panel shows no findings, findings, checking now, not run with its reason, or not allowed yet.
- Selecting a placed finding opens a collapsed item and scrolls to the line.
- The panel says when the latest revision wasn't checked.

Scope:
- In: the new `web/checks.js`, `web/app.js`, `web/app.css`, `src/web.ts` for the page file list,
  `test/ui.test.ts`, and this tracker.
- Out: anything on GitHub.

How to check:
- A browser test covers each panel state and the jump to a line.
- The page checks in `test/pages.test.ts` still pass with the panel shown.

Definition of done:
- The change is merged in one pull request within the size budget.
- Every check above passes, and each new test fails on the base first.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.
