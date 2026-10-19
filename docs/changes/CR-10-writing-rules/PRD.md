# CR-10: Document checks on submit

Status: folded · Revision: 4 · Owner: Ankur Jain · Type: story · Request: `REQUEST.md`

## Problem

Agents write documents that break the project's writing rules, and nobody finds out until a
reviewer reads them. devloop's writing checker catches these problems, but only when an agent
remembers to run it. In CR-9 the checker's findings came back after a draft was already in review
several times, and each one cost a revision. Reviewers can't see the checker's findings at all.

## Goals and non-goals

- Goal: every markdown document submitted to hoop is checked by the project's own check command,
  when the user has allowed it for that repository.
- Goal: the agent gets the findings in the submit result, so it can fix them before a reviewer looks.
- Goal: the reviewer sees the findings, and which revision they belong to.
- Non-goal: hoop doesn't hold writing rules of its own. The project's command holds them.
- Non-goal: a finding never blocks a submission. devloop's document review stays the strict layer,
  because it refuses a document until the checker reports nothing.

## Success metrics

| Metric | Baseline | Target | How measured |
|---|---|---|---|
| Revisions per approved design document. | CR-9's PRD, HLD and LLD took 2, 3 and 7. | Fewer than CR-9's, over the next three changes. | `hoop audit` counts revisions per approved review. |
| Revisions that reach a reviewer with findings the agent wasn't told about. | Unknown | 0 | `hoop audit` records each check's outcome beside each submission. |
| Submissions that fail because a check failed. | Not applicable | 0 | `hoop audit` records each failed check, and every such submission is stored. |

## Users and scenarios

- **Agent:** It submits a PRD. The result lists two findings with their lines, so it fixes them and
  submits a new revision before asking for review.
- **Reviewer:** They open a revision that still has a finding. A panel shows the finding next to
  the line it concerns, so they don't have to spot it themselves.
- **Maintainer:** They set the command once in the repository. Each user allows it once on their own
  machine, and then every agent gets the checks.

## Requirements

- FR-1: A project shall set its check command in `hoop.config.json` at the repository root, as a
  list of arguments. hoop adds the path of a file that holds the document as the last argument.
  Acceptance: Given an allowed command, when a markdown document is submitted, then hoop runs that
  command once on that document.
- FR-2: A check shall run only when the user's own `~/.hoop/config.json` allows that exact command
  for that repository folder. A cloned repository's config can't run anything until its user allows
  it. A command that changes after a pull doesn't run until the user allows it again.
  Acceptance: Given a repository command with no matching local entry, when a document is
  submitted, then nothing runs. The result says that the check isn't allowed and how to allow it.
  Given an allowed command that later changes, then the changed command doesn't run.
- FR-3: The submit result shall gain a `checks` field. It says whether the check ran, the command
  that ran, and each finding with its source line and message. The same outcome is stored beside the
  revision.
  Acceptance: Given a document with two findings, when it is submitted, then `checks` lists both,
  with their line numbers and messages, and names the command.
- FR-4: The server shall read the command's exit code. Exit 0 means no findings, and exit 1 means
  findings. Any other code, a command that can't start, or one that takes over ten seconds means
  the check didn't run. Such a submission is still stored, and `checks` says why the check didn't run.
  Acceptance: Given a command that doesn't exist, when a document is submitted, then the review is
  stored, and `checks` says the check didn't run.
- FR-5: The server shall read findings only from output lines shaped `path:line: message`, and ignore
  other lines. Exit 1 with no such line gives one finding that holds the output's first line.
  Acceptance: Given devloop's checker output with snippet and summary lines, then only its finding
  lines become findings.
- FR-6: The review page shall show the findings of the latest checked revision in a panel, and name
  that revision. Each finding sits next to the line it concerns, when hoop can place it. A revision
  made by an applied suggestion or an accepted edit isn't checked, so the panel says so.
  Acceptance: Given a checked revision with a finding on a list item, when the reviewer opens it,
  then the panel shows the finding. Selecting the finding scrolls to that line.
- FR-7: Without a repository config, without a command in it, or for a JSON review, hoop shall check
  nothing and behave as today.
  Acceptance: Given no `hoop.config.json`, when a document is submitted, then `checks` is absent,
  and nothing runs.
- NFR-1: The command runs with an argument list and no shell, in the repository folder, with the
  same environment as hoop.
  Acceptance: a test shows that a document's text can't change the command that runs.
- NFR-2: A check runs only when an agent or a terminal command submits. No request from the page
  runs a check, and a running check doesn't hold up the server.
  Acceptance: Given a check that takes five seconds, when the reviewer loads a page meanwhile, then
  the page answers at once.

## What changes for existing users

- Project FR-1 and FR-16: the submit result gains the `checks` field. Agents that ignore it see no
  difference.
- Project NFR-10: the recorded snapshot of agent tools and commands is updated for the new field.
- A submission can take up to ten seconds longer while a check runs.
- Reviews stored before this change have no stored outcome, so their page shows no panel.

## Out of scope

- Checks on JSON reviews, which are structured and have no markdown lines.
- The GitHub channel's pages. A GitHub submission is checked, and its findings come back in the
  submit result, but no panel shows on GitHub.
- Complete sentences in tracker titles and tasks that hoop writes. devloop's writing rules already
  cover the titles that agents give hoop.
- Any new agent tool or terminal command. The existing submit tools and commands gain the result
  field only.

## Assumptions and open questions

- The command prints findings as `path:line: message` lines, as devloop's writing checker does.
- A user who allows a repository trusts that repository's command, as they trust its own scripts.
