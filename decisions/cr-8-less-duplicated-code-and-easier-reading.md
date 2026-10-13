# CR-8: Less duplicated code and easier reading

Status: proposed · Revision: 1 · Owner: Ankur Jain · Type: epic · Request: `REQUEST.md`

## Problem

The people and agents who change hoop have to keep several copies of the same logic in step.
The rule that a review must be open is written three times, and so is the rule that GitHub reviews
can't be edited locally. Finding a comment thread's first comment is written four times. When
copies drift apart, hoop behaves differently in different places. This already happened once:
two copies of the table rules disagreed until CR-3 merged them.

The core module is 399 lines long and does five jobs, so a small change means reading most of it.
The test and acceptance scripts each repeat their setup, which makes every new test longer than it
needs to be. Every queued change (CR-9, CR-10, CR-11, CR-6, CR-7 and CR-4) edits these same files,
so the cost grows with each one.

## Goals and non-goals

- Goal: each rule and each repeated step in hoop is written once and reused.
- Goal: a reader can find and change one job in the core without reading the others.
- Goal: hoop behaves exactly as it does today, for agents, reviewers and the terminal.
- Non-goal: new features or changed behavior. Those stay in their own change requests.
- Non-goal: a new design for the review page. CR-9 covers that.
- Non-goal: faster performance. Nothing measured is slow today.

## Success metrics

| Metric | Baseline | Target | How measured |
|---|---|---|---|
| The open-review rule is written this many times. | 3 | 1 | Code search |
| The GitHub-review refusal is written this many times. | 3 | 1 | Code search |
| The thread lookup is written this many times. | 4 | 1 | Code search |
| The core module has this many lines. | 399 | 250 or fewer | Line count |
| The slug rule is written this many times. | 2 | 1 | Code search |
| The review page repeats its request code and its notice code this many times. | 3 and 3 | 1 and 1 | Code search |
| The test setup and the script setup are written this many times. | 2 and 3 | 1 and 1 | Code search |
| The GitHub module has this many unchecked type casts. | 8 | 0 | Code search |
| This share of tests and acceptance runs passes. | All | All | Test suite and scripts |

## Users and scenarios

- **Maintainer:** An agent or a person changes how a review behaves. They find the rule in one
  place, change it there, and every caller follows.
- **Reviewer and agent:** They use hoop as before. They notice no difference in pages, tools,
  commands, messages or stored files.

## Requirements

- FR-1: Each rule about whether a review can be changed shall be written once and used
  everywhere it applies.
  Acceptance: Given the code, when it is searched for each rule, then each rule appears once.
- FR-2: Finding a comment thread, with its first comment and the revision it was made on, shall
  be written once.
  Acceptance: Given the code, when it is searched for thread lookups, then there is one.
- FR-3: The core module shall hand the work of turning comments into edits to its own module.
  Acceptance: Given the core module, then it has 250 lines or fewer and only coordinates.
- FR-4: The store shall have one way to mark a review as updated, and hoop shall have one slug rule.
  Acceptance: Given the code, then each appears once.
- FR-5: The review page shall send requests and show notices through one shared helper each.
  Acceptance: Given the review page code, then each helper is defined once and used everywhere.
- FR-6: The tests and acceptance scripts shall share their server, browser and tool-call setup.
  Acceptance: Given the test and script code, then each kind of setup is defined once.
- FR-7: GitHub responses shall be read through typed shapes, with no unchecked casts.
  Acceptance: Given the GitHub module, then it has no unchecked type casts.
- NFR-1: Behavior shall not change.
  Acceptance: every unit, integration and browser test passes unchanged, and every acceptance
  script passes. The agent tool list, tool schemas and command usage are identical to before.
- NFR-2: Each refactor shall land as its own pull request of at most 10 files and 500 lines.
  Acceptance: the tracker lists one task for each pull request, with its size.

## Out of scope

- Any change that a test would notice, including messages, file formats and page layout.
- The review page's design and the tracker's description blocks, which CR-9 and CR-11 cover.
- The performance of finding GitHub threads, which is fine at today's scale.

## Assumptions and open questions

- A test may move to a shared setup without counting as a changed test, as long as it checks the
  same things.
- The slug rule keeps both of today's length limits as options, so no stored slug changes.
