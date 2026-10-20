# CR-31: tracker

This tracker lists CR-31's work items. Requirements stay in `PRD.md`, and the Covers column points
to them. The table is the index, and each item's description and definition of done are in its
block under "Items".

| ID | Parent | Type | Title | Covers | Status | Phase | Depends on | PR | Size | Start | Done | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CR-31 | | epic | Build every queued change request as one change, landed as one pull request. | | in progress | build | | | 140 files, 9000 lines | 2026-10-20 | | The requester chose one pull request over devloop's limit of five. |
| T-1 | CR-31 | task | Format the code with Biome, and add the hooks, CI, comment guard and open source files. | FR-118, FR-119, FR-120, FR-121, FR-122, FR-123, FR-124, NFR-21 | done | | | | 30 files, 1200 lines | 2026-10-20 | 2026-10-20 | Biome's first format is its own commit. Actual: 43 files and 707 lines, plus the format's 73 files. |
| T-2 | CR-31 | task | List tools by project under their new names, wait through MCP, and state each submit's outcome and checks. | FR-58, FR-59, FR-60, FR-61, FR-62, FR-63, FR-64, FR-65, FR-66, FR-67, FR-68, FR-69, FR-70, FR-139, FR-140, FR-141 | done | | T-1 | | 16 files, 1100 lines | 2026-10-20 | 2026-10-20 | Actual: 23 files and 1176 lines, with the recorded interface. |
| T-3 | CR-31 | task | Anchor by quoted words, state each scope, name every edit rule, and let reviewers delete or edit in place. | FR-71, FR-72, FR-73, FR-74, FR-75, FR-136 | todo | | T-2 | | 10 files, 700 lines | | | |
| T-4 | CR-31 | task | Nest sections, keep a renamed section's ID, and draw tables and diagrams. | FR-76, FR-77, FR-78, FR-79, FR-80, FR-134, FR-138, FR-142, NFR-19, NFR-20 | todo | | T-1 | | 16 files, 1000 lines | | | The diagram library is one vendored file and doesn't count. |
| T-5 | CR-31 | task | Sign in with GitHub for a final approval, record agent approvals and notes, and show the audit trail. | FR-81, FR-82, FR-83, FR-84, FR-85, FR-86, FR-133, FR-137, FR-143, FR-144 | todo | | T-2 | | 16 files, 1300 lines | | | The maintainer creates the OAuth App before merge. |
| T-6 | CR-31 | task | Review a plan in hoop before the agent leaves plan mode. | FR-87, FR-145 | todo | | T-5 | | 8 files, 500 lines | | | |
| T-7 | CR-31 | task | Show tracker blocks and projects, and list every change on its own page. | FR-88, FR-89, FR-90, FR-91, FR-92, FR-93, FR-94, FR-95, FR-96, FR-97, FR-98, FR-132, FR-135 | todo | | T-2 | | 20 files, 1400 lines | | | |
| T-8 | CR-31 | task | Publish the schemas, rewrite the README, and update devloop's skills, agents and document rules. | FR-99, FR-125, FR-126, FR-127, FR-128, FR-129, FR-130, FR-131 | todo | | T-7 | | 24 files, 1300 lines | | | FR-99 carries CR-30's rules. |
| T-9 | CR-31 | task | Run every acceptance script end to end, with the new steps, and fix what it finds. | NFR-17, NFR-18 | todo | | T-8 | | 6 files, 500 lines | | | |

Types are epic, story, task, sub-task and bug. Status is todo, in progress, in review, blocked,
done or dropped. At the requester's choice, every task lands in one pull request, as one or more
commits each.

## Items

### CR-31: Build every queued change request as one change, landed as one pull request.

Thirteen queued changes are merged into this one, and built together.

What is expected:
- Every requirement in the PRD passes its acceptance check.
- The change lands as one pull request, with one commit per LLD section.

Out of scope:
- Deleting a whole line as one edit.

Definition of done:
- [ ] Every task under it is done.
- [ ] Every acceptance script passes, with the browser required.
- [ ] A fresh review finds nothing left open.
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
- [ ] Every check above passes, and each new test fails on the base first.

### T-2: List tools by project under their new names, wait through MCP, and state each submit's outcome and checks.

What is expected:
- A project without devloop lists eight tools, and one with it lists fifteen.
- The wait tool returns a review, or says to call again with its cursor.
- Each submit states its outcome, and a check that didn't run leads with a warning.

How to check:
- Integration tests over stdio count the tools, and test each old name.
- A review posted between two waits returns at once.

Definition of done:
- [ ] Every check above passes, and each new test fails on the base first.

### T-3: Anchor by quoted words, state each scope, name every edit rule, and let reviewers delete or edit in place.

What is expected:
- A comment or edit can name its words in place of a line.
- Each refusal names one of the fourteen rules.
- Reviewers delete selected text, or edit a line in place, as a suggestion.

How to check:
- Unit tests cover each rule and an ambiguous quote.
- Browser tests apply a delete and an edit.

Definition of done:
- [ ] Every check above passes, and each new test fails on the base first.

### T-4: Nest sections, keep a renamed section's ID, and draw tables and diagrams.

What is expected:
- Five levels of sections nest, and a heading's scope covers them.
- A renamed section keeps its comments.
- Tables and diagrams draw, and a diagram can't reach the page.

How to check:
- Unit tests cover the matcher and the scope.
- Browser tests cover tables, diagrams and a hostile diagram.

Definition of done:
- [ ] Every check above passes, and each new test fails on the base first.

### T-5: Sign in with GitHub for a final approval, record agent approvals and notes, and show the audit trail.

What is expected:
- A final approval needs a GitHub sign-in, unless the person turned it off.
- An approval without a sign-in counts as an agent's.
- Each review shows its audit trail.

How to check:
- Tests with a fake GitHub cover every sign-in state.
- A request from another port can't use the sign-in.

Definition of done:
- [ ] Every check above passes, and each new test fails on the base first.

### T-6: Review a plan in hoop before the agent leaves plan mode.

What is expected:
- The hook submits the plan and allows only after a final approval.
- Every failure of the hook denies the call.

How to check:
- Subprocess tests feed the hook its input for each case.

Definition of done:
- [ ] Every check above passes, and each new test fails on the base first.

### T-7: Show tracker blocks and projects, and list every change on its own page.

What is expected:
- Tracker items open into their blocks, with counts and flags.
- Change requests leave the tracker, and the changes page lists them with their history.
- Changes and items carry a project and a kind.

How to check:
- Unit and browser tests cover the blocks, the size flag and the filters.

Definition of done:
- [ ] Every check above passes, and each new test fails on the base first.

### T-8: Publish the schemas, rewrite the README, and update devloop's skills, agents and document rules.

What is expected:
- The schemas and the README's field tables come from the contract.
- The devloop skills and agents follow the new tools, approvals and document rules.

How to check:
- A test fails when the schemas or tables differ from the contract.
- The writing checker's tests cover each new rule.

Definition of done:
- [ ] Every check above passes, and each new test fails on the base first.

### T-9: Run every acceptance script end to end, with the new steps, and fix what it finds.

What is expected:
- The five acceptance scripts pass with the browser required.

How to check:
- Each run's output maps its steps to requirement IDs.

Definition of done:
- [ ] Every run passes, and each defect it finds has a regression test.
