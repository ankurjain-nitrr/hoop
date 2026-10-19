---
name: slice
description: Splits a change into a map of small, reviewable pull requests that each deliver working behavior, and keeps them moving as a stack. Use when planning how a change lands as PRs, when it is too big for one PR (more than 10 files or 500 lines), or for "split this into PRs", "slice this", "stack these PRs" or restacking after a merge.
---

# Slice a change into PRs

Each PR does one thing, fits the size budget (10 files and 500 lines, lockfiles and generated files
excluded) and leaves the code working. If the repo's `CLAUDE.md` sets different limits or a
stacking tool, follow it.

## 1. Cut vertical slices

- A slice delivers at least one requirement (`FR-n`) end to end, through every layer it touches,
  with its tests. Its check from the spec passes when it merges.
- Don't cut by layer (all the models, then all the endpoints). A shared piece that several slices
  need becomes its own slice, with its own tests.
- A requirement too big for one slice splits along the first of these that works:
  - **Paths:** the main path first, then alternative and error paths.
  - **Interfaces:** one entry point first (API before UI, one client before all).
  - **Data:** a subset of the inputs, fields or types first.
  - **Rules:** the simplest business rule first, then the rest.
- Unknowns that block slicing go back to scoping (a throwaway spike there), not into a PR.

## 2. Start with a walking skeleton

For a new surface (service, endpoint, page, job, integration), slice 1 wires the thinnest path end
to end (entry point, logic, storage, response, CI green) with minimal behavior. Later slices add
behavior on top of it.

## 3. Order and map

Dependencies first, then the riskiest or most valuable slice, so problems surface early and value
lands soon. Show the map with the plan and get it approved together:

```
1/3  feat/export-skeleton  FR-1       GET /orders/export streams a CSV header   ~4 files, ~120 lines
2/3  feat/export-rows      FR-2       one row per order, escaped               ~5 files, ~260 lines
3/3  feat/export-filters   FR-3,FR-4  date and status filters, 400 on bad input ~4 files, ~200 lines
```

Before showing the map, check the breakdown and fix what fails:

- Each task's title names one outcome. A title such as "finish the page details" is a grab bag,
  so split it by outcome.
- Each task delivers or protects a requirement, and can be checked on its own once it merges. A
  task that covers more than three requirements is split, or its block says why it can't be.
- No task holds only tests at the end. A check for a non-functional requirement lands with the
  task that makes it true. A shared check harness goes first, so it guards the later tasks.
- Each task's block says what it leaves out and which task takes it, so gaps and overlaps show.
- Count each task's files by name, from the LLD's new files, the files it changes, tests, type
  declarations, styles and the tracker. Plan at most 8 files, which leaves room for review fixes.

Add the map to the change's `TRACKER.md` (`/devloop:project-docs`): a row per slice, parented to
its requirements, with its estimated size. Estimate each slice's files from the plan, and count
again before every commit (step 7 in devloop). If a slice grows past the budget while you build it, split it again along the same lines instead
of raising the budget.

## 4. Run the stack

- Slice 1 branches from `origin/main` and targets `main`; each next slice branches from the one
  below and targets it (`gh pr create --base <branch below>`). Each passes the gates on its own,
  and its fresh-session review (`/devloop:pr-review`) is resolved before the next PR opens.
- If `gh stack` is installed, use it (`gh stack submit`, `gh stack sync`). Otherwise use Git 2.38+:

  ```sh
  git config rebase.updateRefs true          # once per repo
  # after changing a lower slice, from the top branch:
  git rebase <changed branch>                # moves every branch in between too
  git push --force-with-lease origin <b1> <b2> <b3>
  ```

- When a lower slice merges, restack the rest onto main and retarget the next PR:

  ```sh
  git fetch origin
  git rebase --onto origin/main <merged-branch> <top-branch>   # also right after a squash merge
  git push --force-with-lease origin <remaining branches>
  gh pr edit <next-pr> --base main
  ```

PR titles, PR descriptions and task titles follow the `writing-style` skill bundled with this plugin (`/devloop:writing-style`): complete sentences in simple
language, with no dashes.

Each slice is a tracker task. Its definition of done (in its block under "Items", see
`/devloop:project-docs`) names the change, the tests that cover it and the review, and the PR
description repeats it as the checklist for that PR.
