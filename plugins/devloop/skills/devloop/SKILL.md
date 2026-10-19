---
name: devloop
description: Takes a code change from request to small, tested, reviewed pull requests merged as a milestone, starting from frozen requirements and a short plan agreed with the user. Every defect found on the way, and every reported bug, gets a regression test. Use for implementing a feature, fix or refactor end to end, "devloop", "plan and ship this", or when a change should land as PRs of at most 10 files and 500 lines.
---

# Devloop

From request to a merged, reviewed milestone in small, tested steps. If the repo's `CLAUDE.md` or its own skills
say otherwise (branch names, test commands, PR template), follow them. `main` below means the
default branch (`git symbolic-ref refs/remotes/origin/HEAD`; if unset, `git remote set-head origin -a`).

Everything written along the way (requirements, design documents, tracker items, plan lines,
commit messages, and PR titles and descriptions) follows the `writing-style` skill bundled with this plugin (`/devloop:writing-style`).

## 1. Intake, then scope and freeze

Every request is first captured and queued with `/devloop:intake`. When a queued change is picked
up, run the `scope` skill bundled with this plugin (`/devloop:scope`): research, ask questions from
wide to narrow, and freeze numbered requirements (`FR-1`, ...) with the user's approval. Nothing
below starts before the freeze. After it, changes to what gets built go through its change control.

## 2. Explore

Read the code, tests and docs the change touches, beyond what scoping already covered. Don't edit
anything yet. Find the test command and whether a pre-commit hook runs tests. The stack references
in [references/stacks/](references/stacks/README.md) say where to look for each language. If the
repo's stack has no file there, add one.

Preflight the environment now, not mid-slice: the runtime versions installed against what the
project and its test tools need (a browser-test library may need a newer runtime than the app),
browsers for UI tests, the CLI tools scripts call (`gh`, `timeout`, `jq`), and hoop (its MCP tools
or the `hoop` command; required for the design docs; if neither, ask the user to install hoop). Note gaps and the
workaround (an alternate runtime path, a skipped test) before planning around them.

## 2b. Design docs

Using the `project-docs` skill bundled with this plugin (`/devloop:project-docs`):

- If the project has no `docs/PRD.md`, `HLD.md`, `LLD.md` and `TRACKER.md`, bootstrap them first.
- Every change gets a PRD, HLD and LLD, sized to it, each approved through hoop before the next is
  written, and all three before planning. Each is written by its owner agent to the
  standards in its review skill. That skill (`/devloop:prd-review`, `/devloop:hld-review` or
  `/devloop:lld-review`) then runs its reviewer agents, which comment on the document in hoop before
  the user approves it. Link each review to the change (`--cr`, `--doc`) so hoop
  holds the order. Record steps with `hoop cr step` and show `hoop cr show <CR>` when reporting.

## 3. Plan: at most 10 lines

- Plan from the frozen requirements; each line names the requirement IDs it covers, and every
  requirement is covered by some line.
- Each line is one unit of behavior at a meaningful level of abstraction ("orders can be cancelled
  while unpaid"), not a file edit ("edit OrderService.java"), and ends with how it will be checked.
- Show the plan and iterate with the user until they approve it. Don't start step 4 before that.
- When asked to go deeper on a line, expand only that line into at most 10 sub-lines under the
  same rules. Keep the top level as it is.
- If the work needs more than 10 top-level lines, it is more than one change: plan the first slice
  and list the rest as follow-ups.
- Write the plan lines into the change's `TRACKER.md` as task rows under their requirements.
- Group the plan lines into PR slices with the `slice` skill bundled with this plugin
  (`/devloop:slice`): vertical slices that each deliver requirements end to end, a walking
  skeleton first for new surfaces, riskiest first, with each slice's estimated file count. Show the
  plan and the slice map together.
- Note whether the change adds a server, web UI, external input, auth, or file paths built from
  input; if so, the security checklist in step 7 applies to every slice.

## 4. Branch and baseline

```sh
git fetch origin
git switch -c <type>/<slug> origin/main    # e.g. feat/cancel-unpaid-orders
```

Never commit on `main`. Before every commit, check `git branch --show-current` is the slice's
branch; in a stack it's easy to commit onto the slice below. The change's approved docs
(`docs/changes/CR-<n>-<slug>/`) are the first commit; set its status to `implementing`. Run the full test suite on the new branch before changing anything. If it
already fails, stop and report; don't build on a red baseline.

## 5. API first

- Define or change the contract before the implementation: public signatures and types,
  interfaces, OpenAPI or schema files, CLI flags, events.
- Write tests against the contract that fail for the right reason, named or tagged by requirement
  ID where the test framework allows.
- If a public contract changes (consumers have to adapt), show the contract diff and get the user's
  approval before implementing.

## 6. Implement

Write the smallest code that makes the tests pass, one plan line at a time. Write comments and docs
by the `code-docs` skill bundled with this plugin (`/devloop:code-docs`): current code only, no
change history or narration, as short as possible. Commit per plan line or logical step; every
commit builds and passes tests. Each slice's PR updates its rows in the change's `TRACKER.md`
(status, PR, dates); any change to the change's PRD, HLD or LLD goes through hoop first. Write multi-line commit messages to a file and use `git commit -F`,
which avoids shell-quoting mistakes. After each slice, give the user a one-line status (slice n/m,
tests, what's next): they can't see the work between messages.

**Every defect gets a regression test.** This applies to a defect found by a review, a test, the
acceptance run, a probe or the user, and to a reported bug. First write a test that fails because
of the defect, and see it fail. Then fix the code and see the test pass. The test stays in the
suite, named for the behavior it protects, so the defect can't come back unnoticed. A fix without
such a test isn't done. If no automated test can reach the defect, say why in the PR and add the
closest check that can.

**A test for new behavior must fail on the base.** Run each new test against the base branch's code
before the change, and see it fail. A test that passes there doesn't prove the requirement, so
rewrite it until it does. Say in the PR that each new test fails on the base.

**Requests that arrive mid-build** (new features, "also make it…") are new scope. Record each as a
change-control delta via `/devloop:scope` and queue it for the next milestone; fold it into the
current stack only if the user says so, and then re-plan the slices.

## 7. Gates (before every commit and push)

- **Tests:** if a pre-commit hook runs the tests, let it; otherwise run them directly before each
  commit. Never use `--no-verify` or skip failing tests. Don't install hooks without asking.
  Gate on the test command's own exit status. A pipe such as `<test command> | grep pass` reports
  the last command's status, so a failing run can still commit. Save the output to a file instead.
- **Size:** check before committing, not after: each PR changes at most **10 files and 500 lines**
  (additions plus deletions):

  ```sh
  git diff --numstat <base>...HEAD -- . ':(exclude)<lockfile>' ':(exclude)<generated path>'
  ```

  Lockfiles, generated code and snapshots don't count toward the budget, but list them in the PR.
  The stack reference names them for each language.
  If a slice goes over, split it further with `/devloop:slice` rather than raising the budget.
- **Security** (when step 3 flagged it): servers check Host and Origin and refuse cross-site writes
  (a local API is reachable from any web page); every value put into HTML is escaped; IDs and
  names used in paths are validated; subprocesses get argument arrays, never shell strings;
  secrets stay out of logs, files and commits. Add a test for each.

## 8. Self-review

Read the whole branch diff with fresh eyes: anything outside the frozen requirements or the plan,
debug leftovers, a requirement without a test, contract changes the user hasn't approved. Run the diff check from
`/devloop:code-docs` and fix history, narration and redundant comments. Fix before pushing.

## 9. Push and open the PR

1. Run the `readme-check` skill bundled with this plugin (`/devloop:readme-check`) against the
   branch's commits: it checks the README's versions, requirements, commands, API names, defaults
   and sample output against the diff and fixes only what this branch made stale, in its own commit
   (which counts toward the size budget). Include its result in the PR body.
2. `git push -u origin <branch>`
3. Open it as a draft: `gh pr create --draft --base <base> --title "<summary>" --body-file <file>`.
   Use the repo's PR template if there is one; otherwise:

   ```markdown
   ## What and why
   <one short paragraph>

   ## Requirements
   FR-1, FR-2 (docs/changes/CR-<n>-<slug>/, PRD rev <n>)

   ## How to verify
   <commands or steps a reviewer can run>

   ## Risk and rollback
   <what could break and how to revert>

   ## Checks
   Tests: <command>, passing · Size: <files> files, <lines> lines · README check: <result>
   Slice <n>/<m>, depends on #<pr>   (omit for a single PR)
   ```

4. When CI passes (`gh pr checks --watch`), mark it ready: `gh pr ready`.

## 10. Fresh-context review

Run the `pr-review` skill bundled with this plugin (`/devloop:pr-review`). Scale it to risk:

- **Always:** before merging, review the whole stack (`main...<top branch>`) with a fresh-context
  reviewer, fix every finding in follow-up slices with a regression test for each (step 6), and
  re-run the tests.
- **Also per slice**, before the next one builds on it, when a slice touches security, data
  migration, a public API, or core invariants.
- **Docs-only or trivial changes:** self-review (step 8) is enough.

Multi-slice changes run as a stack through steps 6-10; branching, restacking and retargeting are in
`/devloop:slice`.

## 11. Acceptance run

Before merging, run the change end to end against real systems, as a user would: the real server or
CLI, a browser for UIs, a sandbox repo or account for external services. Map the run's steps to the
requirement IDs, keep it as a script in the repo so it can be re-run, and run it again after review
fixes. Unit tests passing is not acceptance.

## 12. Milestone: merge, record, stop

1. Merge the stack in order once reviewed and accepted (ask the user if they haven't approved
   merging). For each PR: `gh pr merge <n> --merge`, then retarget the next PR
   (`gh pr edit <next> --base main`), and only then delete the merged branch. Never pass
   `--delete-branch` while another PR is based on that branch: GitHub closes PRs whose base is
   deleted, and they can't be reopened after a force-push. Merge commits keep the stack's
   branches valid; squashing needs `/devloop:slice` restacks between merges.
2. Check `main` matches the reviewed top branch (`git diff --quiet <top> main`) and its tests pass.
   Delete the merged branches, locally and on the remote.
3. Tag a release if the project versions them and the user agrees.
4. Fold the change's docs into the project docs in their own PR, reviewed through hoop as a diff
   (`/devloop:project-docs`, "Fold"), and set the change's status to `folded`.
5. Run the `reflect` skill if installed: decisions, the why behind them, and gotchas from this
   milestone go into the repo's `CLAUDE.md`.
6. Look back on the breakdown. Compare each task's estimated size with its actual size. Count the
   fresh review's findings in each pull request. An estimate may be off by more than half, or
   reviews may find the same kind of defect twice. Then propose one change to devloop or to the
   repo's `CLAUDE.md`, and record it in the epic's Notes.
7. Report, then stop. New scope starts as a new devloop from step 1.

Report: requirements covered (and deltas approved after the freeze), plan lines done, tests and the
acceptance run with results, review findings and how each was resolved, size per PR, merged PRs,
and anything skipped and why.
