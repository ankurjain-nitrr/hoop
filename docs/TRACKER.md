# hoop: tracker

This tracker lists hoop's candidate work as ideas. None is scoped until it becomes a change request,
and change requests show on the change request page, not here. Each change's work sits under an epic
that names it in the Change column. The table is the index, and each item's description and
definition of done are in its block under "Items".

| ID | Parent | Type | Title | Change | Project | Covers | Status | Phase | Depends on | PR | Size | Start | Done | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B-1 | | idea | Materialize comments on the GitHub channel. | | | | todo | | | | | | | Out of scope since the initial build. |
| B-2 | | idea | Trace requirements to code pull requests in CI. | | | | todo | | | | | | | Deferred since the initial build. |
| B-3 | | idea | Open decision pull requests from a GitHub Action. | | | | todo | | | | | | | Deferred since the initial build. |
| B-4 | | idea | Publish hoop to npm. | | | | dropped | | | | | | | Merged into B-16 by CR-21 on 2026-10-19. |
| B-5 | | bug | Export assumed one blank line after each heading. | | | | done | | | #24 | | 2026-10-13 | 2026-10-13 | Fixed by CR-2. |
| B-6 | | idea | Show tracker items as epics, stories, tasks and bugs in a tree table. | | | | done | | | | | 2026-10-13 | 2026-10-13 | Done by CR-3. |
| B-7 | | idea | Give devloop hoop interfaces, and record each change's devloop step. | | | | done | | | | | 2026-10-13 | 2026-10-13 | Done by CR-3. |
| B-8 | | idea | Approve the PRD, HLD and LLD before development starts. | | | | done | | | | | 2026-10-13 | 2026-10-13 | Done by CR-3. |
| B-9 | | idea | Add a human gate that an agent can't skip or fake. | | | | dropped | | | | | | | Merged into CR-14 by CR-21 on 2026-10-19. |
| B-10 | | idea | Report the server's version, and warn when a page is stale. | | | | dropped | | | | | | | Merged into CR-22 on 2026-10-19. |
| B-11 | | idea | Fix lost writes, colliding IDs and partial multi-file changes in the store. | | | | todo | | | | | | | First review items 2 and 6. |
| B-12 | | idea | Page through GitHub reviews and comments, show sync errors, and type errors by kind. | | | | todo | | | | | | | First review items 3 and 7. B-13 merged in. |
| B-13 | | idea | Type errors by kind, not by their wording. | | | | dropped | | | | | | | Merged into B-12 by CR-21 on 2026-10-19. |
| B-14 | | idea | Keep a section's comments when its heading is renamed or repeated. | | | | dropped | | | | | | | Merged into CR-12 by CR-21 on 2026-10-19. |
| B-15 | | idea | Compare any two revisions, and show which comments the agent addressed, answered or ignored. | | | | todo | | | | | | | Second review items 4 and 8. B-18 merged in. |
| B-16 | | idea | Publish hoop to npm, with a one-line install. | | | | todo | | | | | | | Second review item 2. B-4 merged in. |
| B-17 | | idea | Approve with notes, kept in the decision record. | | | | dropped | | | | | | | Merged into CR-14 by CR-21 on 2026-10-19. |
| B-18 | | idea | Compare any two revisions. | | | | dropped | | | | | | | Merged into B-15 by CR-21 on 2026-10-19. |
| B-19 | | idea | Delete text in one action, and edit lines in place. | | | | dropped | | | | | | | Merged into CR-25 on 2026-10-19. |
| B-20 | | idea | Document setup for other agents, and publish the review and feedback schemas. | | | | dropped | | | | | | | Merged into CR-28 on 2026-10-19. |
| B-21 | | idea | Render only what changes on the review page, and stop the server importing page code. | | | | todo | | | | | | | First review items 8 and 9. |
| B-22 | | idea | Size the process to the change, so a small fix needs fewer documents. | | | | todo | | | | | | | First review item 10. |
| E-1 | | epic | Build every queued change request as one change, landed as one pull request. | CR-31 | | | done | fold | | #104 | 196 files, 18356 lines | 2026-10-20 | 2026-10-21 | The requester chose one pull request over devloop's limit of five. The estimate was 140 files and 9000 lines. The size leaves out the vendored diagram library and the lockfile. Look-back: seven of nine tasks touched more files than estimated, by a fifth to nearly double, and six changed fewer lines. The fresh review found nine defects in the one pull request. Four were failure paths: a missing timeout, unreadable settings, a bad change record and an early refusal missing from the audit. Proposal: devloop's slice estimate counts each task's test files and documents as files, so file counts stop running low. |
| T-1 | E-1 | task | Format the code with Biome, and add the hooks, CI, comment guard and open source files. | | | FR-118, FR-119, FR-120, FR-121, FR-122, FR-123, FR-124, NFR-21 | done | | | #104 | 43 files, 707 lines | 2026-10-20 | 2026-10-20 | Biome's first format is its own commit. Actual: 43 files and 707 lines, plus the format's 73 files. The estimate was 30 files and 1200 lines. |
| T-2 | E-1 | task | List tools by project under their new names, wait through MCP, and state each submit's outcome and checks. | | | FR-58, FR-59, FR-60, FR-61, FR-62, FR-63, FR-64, FR-65, FR-66, FR-67, FR-68, FR-69, FR-70, FR-139, FR-140, FR-141 | done | | T-1 | #104 | 23 files, 1176 lines | 2026-10-20 | 2026-10-20 | Actual: 23 files and 1176 lines, with the recorded interface. The estimate was 16 files and 1100 lines. |
| T-3 | E-1 | task | Anchor by quoted words, state each scope, name every edit rule, and let reviewers delete or edit in place. | | | FR-71, FR-72, FR-73, FR-74, FR-75, FR-136 | done | | T-2 | #104 | 19 files, 532 lines | 2026-10-20 | 2026-10-20 | Actual: 19 files and 532 lines. The estimate was 10 files and 700 lines. |
| T-4 | E-1 | task | Nest sections, keep a renamed section's ID, and draw tables and diagrams. | | | FR-76, FR-77, FR-78, FR-79, FR-80, FR-134, FR-138, FR-142, NFR-19, NFR-20 | done | | T-1 | #104 | 19 files, 735 lines | 2026-10-20 | 2026-10-20 | The diagram library is one vendored file and doesn't count. Actual: 19 files and 735 lines without it. The estimate was 16 files and 1000 lines. |
| T-5 | E-1 | task | Sign in with GitHub for a final approval, record agent approvals and notes, and show the audit trail. | | | FR-81, FR-82, FR-83, FR-84, FR-85, FR-86, FR-133, FR-137, FR-143, FR-144 | done | | T-2 | #104 | 19 files, 828 lines | 2026-10-20 | 2026-10-20 | The maintainer creates the OAuth App before merge. Actual: 19 files and 828 lines. The estimate was 16 files and 1300 lines. |
| T-6 | E-1 | task | Review a plan in hoop before the agent leaves plan mode. | | | FR-87, FR-145 | done | | T-5 | #104 | 10 files, 263 lines | 2026-10-20 | 2026-10-20 | Actual: 10 files and 263 lines. The estimate was 8 files and 500 lines. |
| T-7 | E-1 | task | Show tracker blocks and projects, and list every change on its own page. | | | FR-88, FR-89, FR-90, FR-91, FR-92, FR-93, FR-94, FR-95, FR-96, FR-97, FR-98, FR-132, FR-135 | done | | T-2 | #104 | 28 files, 1439 lines | 2026-10-20 | 2026-10-20 | Actual: 28 files and 1439 lines, with the project tracker's rewrite. The estimate was 20 files and 1400 lines. |
| T-8 | E-1 | task | Publish the schemas, rewrite the README, and update devloop's skills, agents and document rules. | | | FR-99, FR-100, FR-101, FR-102, FR-103, FR-104, FR-105, FR-106, FR-107, FR-108, FR-109, FR-110, FR-111, FR-112, FR-113, FR-114, FR-115, FR-116, FR-117, FR-125, FR-126, FR-127, FR-128, FR-129, FR-130, FR-131 | done | | T-7 | #104 | 31 files, 2574 lines | 2026-10-20 | 2026-10-20 | FR-99 to FR-117 are CR-30's rules. The rewrite of the project documents and the comparison ran at the fold. Actual: 31 files and 2574 lines. The estimate was 24 files and 1300 lines. |
| T-9 | E-1 | task | Run every acceptance script end to end, with the new steps, and fix what it finds. | | | NFR-17, NFR-18 | done | | T-8 | #104 | 2 files, 110 lines | 2026-10-20 | 2026-10-20 | All five acceptance runs pass, the GitHub one in the sandbox repository. Actual: 2 files and about 110 lines. The estimate was 6 files and 500 lines. |

Types are idea, epic, story, task, sub-task and bug. Status is todo, in progress, in review,
blocked, done or dropped. `docs/FEEDBACK.md` maps every item from the three outside reviews to its
owner. The open ideas become change requests from the top. Next change request: CR-34.

## Items

### B-1: Materialize comments on the GitHub channel.

Today a reviewer's comment becomes an edit only on the local page. On GitHub, Commit suggestion
covers exact suggestions, but an instruction comment has no tracked change.

Definition of done:
- [ ] An agent's proposed edits for a GitHub comment show on the pull request as suggestions.

### B-2: Trace requirements to code pull requests in CI.

A requirement ID in a pull request should lead to the tests that prove it, so a reviewer sees what
each requirement's code is.

Definition of done:
- [ ] CI lists each requirement a pull request names, with the tests that cover it.

### B-3: Open decision pull requests from a GitHub Action.

A team without a local agent could still open decision pull requests from a workflow.

Definition of done:
- [ ] A workflow opens and updates a decision pull request from a document in the repository.

### B-4: Publish hoop to npm.

This idea moved into B-16, which also covers the one-line install.

Definition of done:
- [x] It is merged into B-16.

### B-5: Export assumed one blank line after each heading.

An exported document lost blank lines around its headings, so it differed from the source.

Definition of done:
- [x] A document exports byte for byte, with its blank lines around headings.

### B-6: Show tracker items as epics, stories, tasks and bugs in a tree table.

The tracker page and tracker reviews show items nested by their parent, with their type.

Definition of done:
- [x] The tracker page and tracker reviews show the tree.

### B-7: Give devloop hoop interfaces, and record each change's devloop step.

The devloop plugin drives each change through hoop's commands and tools, and hoop records each step.

Definition of done:
- [x] Every devloop step has a hoop command and tool, and each step is recorded.

### B-8: Approve the PRD, HLD and LLD before development starts.

The build step waits until a change's three documents are approved and current.

Definition of done:
- [x] Build is refused until the PRD, HLD and LLD are approved and current.

### B-9: Add a human gate that an agent can't skip or fake.

This idea moved into CR-14, whose GitHub sign-in marks a person's final approval.

Definition of done:
- [x] It is merged into CR-14.

### B-10: Report the server's version, and warn when a page is stale.

This idea moved into CR-22, which serves every session's pages from one current process.

Definition of done:
- [x] It is merged into CR-22.

### B-11: Fix lost writes, colliding IDs and partial multi-file changes in the store.

The store has no lock, so two writers can lose a write or reuse an ID. Decision files skip the
atomic write.

Definition of done:
- [ ] Two writers at once never lose a write or share an ID, and every file is written atomically.

### B-12: Page through GitHub reviews and comments, show sync errors, and type errors by kind.

Items past the first hundred are dropped, and a failed thread query shows every thread as open.

Definition of done:
- [ ] A pull request with more than a hundred comments syncs every one.
- [ ] A failed sync shows its error, and errors carry a kind.

### B-13: Type errors by kind, not by their wording.

This idea moved into B-12.

Definition of done:
- [x] It is merged into B-12.

### B-14: Keep a section's comments when its heading is renamed or repeated.

This idea moved into CR-12, and CR-31 builds it.

Definition of done:
- [x] It is merged into CR-12.

### B-15: Compare any two revisions, and show which comments the agent addressed, answered or ignored.

A reviewer compares only the latest revision with the one before it, and can't see which comments
a revision dealt with.

Definition of done:
- [ ] A reviewer picks any two revisions to compare.
- [ ] Each comment shows whether the agent addressed it, answered it or left it.

### B-16: Publish hoop to npm, with a one-line install.

Today hoop installs from a clone. A published package makes the install one line.

Definition of done:
- [ ] `npx hoop mcp` runs the published package, and the README shows the one-line install.

### B-17: Approve with notes, kept in the decision record.

This idea moved into CR-14, and CR-31 builds it.

Definition of done:
- [x] It is merged into CR-14.

### B-18: Compare any two revisions.

This idea moved into B-15.

Definition of done:
- [x] It is merged into B-15.

### B-19: Delete text in one action, and edit lines in place.

This idea moved into CR-25, and CR-31 builds it.

Definition of done:
- [x] It is merged into CR-25.

### B-20: Document setup for other agents, and publish the review and feedback schemas.

This idea moved into CR-28, and CR-31 builds it.

Definition of done:
- [x] It is merged into CR-28.

### B-21: Render only what changes on the review page, and stop the server importing page code.

The review page renders everything on each change, and the server imports page modules.

Definition of done:
- [ ] A change on the page renders only what it touches.
- [ ] The server imports no file from the page folder.

### B-22: Size the process to the change, so a small fix needs fewer documents.

Every change gets a PRD, HLD and LLD today, even a one-line fix.

Definition of done:
- [ ] A small change takes fewer documents, and devloop says which.

### E-1: Build every queued change request as one change, landed as one pull request.

Thirteen queued changes are merged into this one, and built together.

What is expected:
- Every requirement in the PRD passes its acceptance check.
- The change lands as one pull request, with one commit per LLD section.

Out of scope:
- Deleting a whole line as one edit.

Definition of done:
- [x] Every task under it is done.
- [x] Every acceptance script passes, with the browser required.
- [x] A fresh review finds nothing left open.
- [ ] Its PRD, HLD and LLD are folded into the project documents.

### T-1: Format the code with Biome, and add the hooks, CI, comment guard and open source files.

Every later commit is checked as it lands, so this comes first.

What is expected:
- Biome formats the code once, in its own commit.
- The hooks, CI and comment guard refuse what the PRD names.
- The contributor files exist, and devloop's practices skill checks them.

How to check:
- Script tests show each hook refusing its case.
- The practices script reports a missing file.

Definition of done:
- [x] Every check above passes, and each new test fails on the base first.

### T-2: List tools by project under their new names, wait through MCP, and state each submit's outcome and checks.

An agent should see only the tools its project uses, and know what each submit did.

What is expected:
- A project without devloop lists eight tools, and one with it lists fifteen.
- The wait tool returns a review, or says to call again with its cursor.
- Each submit states its outcome, and a check that didn't run leads with a warning.

How to check:
- Integration tests over stdio count the tools, and test each old name.
- A review posted between two waits returns at once.

Definition of done:
- [x] Every check above passes, and each new test fails on the base first.

### T-3: Anchor by quoted words, state each scope, name every edit rule, and let reviewers delete or edit in place.

Agents and reviewers should place comments and edits by the words they mean, and know the rules up front.

What is expected:
- A comment or edit can name its words in place of a line.
- Each refusal names one of the fourteen rules.
- Reviewers delete selected text, or edit a line in place, as a suggestion.

How to check:
- Unit tests cover each rule and an ambiguous quote.
- Browser tests apply a delete and an edit.

Definition of done:
- [x] Every check above passes, and each new test fails on the base first.

### T-4: Nest sections, keep a renamed section's ID, and draw tables and diagrams.

Structured documents should read as they are written, and keep their comments through a renamed heading.

What is expected:
- Five levels of sections nest, and a heading's scope covers them.
- A renamed section keeps its comments.
- Tables and diagrams draw, and a diagram can't reach the page.

How to check:
- Unit tests cover the matcher and the scope.
- Browser tests cover tables, diagrams and a hostile diagram.

Definition of done:
- [x] Every check above passes, and each new test fails on the base first.

### T-5: Sign in with GitHub for a final approval, record agent approvals and notes, and show the audit trail.

Only a signed-in person should give the final approval, and every approval should be traceable.

What is expected:
- A final approval needs a GitHub sign-in, unless the person turned it off.
- An approval without a sign-in counts as an agent's.
- Each review shows its audit trail.

How to check:
- Tests with a fake GitHub cover every sign-in state.
- A request from another port can't use the sign-in.

Definition of done:
- [x] Every check above passes, and each new test fails on the base first.

### T-6: Review a plan in hoop before the agent leaves plan mode.

A plan should be reviewed in hoop like any other document before the agent acts on it.

What is expected:
- The hook submits the plan and allows only after a final approval.
- Every failure of the hook denies the call.

How to check:
- Subprocess tests feed the hook its input for each case.

Definition of done:
- [x] Every check above passes, and each new test fails on the base first.

### T-7: Show tracker blocks and projects, and list every change on its own page.

Each tracker item should say what it is and when it is done, and changes should have their own page.

What is expected:
- Tracker items open into their blocks, with counts and flags.
- Change requests leave the tracker, and the changes page lists them with their history.
- Changes and items carry a project and a kind.

How to check:
- Unit and browser tests cover the blocks, the size flag and the filters.

Definition of done:
- [x] Every check above passes, and each new test fails on the base first.

### T-8: Publish the schemas, rewrite the README, and update devloop's skills, agents and document rules.

New users and other agents should be able to set hoop up and read its formats without the code.

What is expected:
- The schemas and the README's field tables come from the contract.
- The devloop skills and agents follow the new tools, approvals and document rules.

How to check:
- A test fails when the schemas or tables differ from the contract.
- The writing checker's tests cover each new rule.

Definition of done:
- [x] Every check above passes, and each new test fails on the base first.

### T-9: Run every acceptance script end to end, with the new steps, and fix what it finds.

The change should work end to end, as a user runs it, before it merges.

What is expected:
- The five acceptance scripts pass with the browser required.

How to check:
- Each run's output maps its steps to requirement IDs.

Definition of done:
- [ ] Every run passes, and each defect it finds has a regression test.
