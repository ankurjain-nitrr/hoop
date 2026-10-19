# <Project or change>: tracker

This tracker lists work items only. Requirements stay in the PRD, and the Covers column points to
them. The table is the index; each item's description and definition of done are in its block
under "Items".

| ID | Parent | Type | Title | Covers | Status | Phase | Depends on | PR | Size | Start | Done | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CR-1 | | epic | <One sentence that names the change>. | | in progress | prd | | | | <date> | | |
| ST-1 | CR-1 | story | As <user>, I can <do> so that <value>. | FR-1 | todo | | | | | | | |
| T-1 | ST-1 | task | <One sentence that names the outcome of the task>. | FR-1 | todo | | | | ~4 files, ~150 lines | | | |
| ST-1.1 | T-1 | sub-task | <One sentence that names the step>. | | todo | | | | | | | |
| BG-1 | ST-1 | bug | <One sentence that says what is wrong>. | FR-1 | todo | | | | | | | |

Types are epic, story, task, sub-task and bug. Status is todo, in progress, in review, blocked,
done or dropped. An epic's phase is one of intake, prd, hld, lld, plan, build, review, accept,
merge, fold or closed. Size is the estimate while the item is open, and the actual size once it
merges. Notes record what a reader needs later. For example, a task was split because it grew
from 8 files to 15, or its fresh review found 3 defects.

## Items

### CR-1: <One sentence that names the change>.

<Why: two or three sentences on the problem, who has it, and what the change delivers>.

What is expected:
- <Each outcome a user or maintainer sees when the change is done>.

Out of scope:
- <Nearby work that this change leaves out, and where it goes instead>.

Definition of done:
- Every story under it is done.
- <The success metric it moves, and how it was measured>.
- The acceptance run passes for every requirement it covers.
- Its PRD, HLD and LLD are folded into the project documents.

### ST-1: As <user>, I can <do> so that <value>.

<Why: two or three sentences on who benefits and what they can do afterwards>.

What is expected:
- <Each acceptance criterion, written as Given, when, then, or a pointer to the PRD's>.

Out of scope:
- <What this story leaves to other stories>.

Definition of done:
- Each acceptance criterion above passes in a test.
- A person can do it end to end in the running product.
- Every task under it is merged.

### T-1: <One sentence that names the outcome of the task>.

<Why: one or two sentences on what this task delivers and which requirement it serves>.

What is expected:
- <The behavior or result after the merge, as a user or the next task sees it>.
- <Each interface that changes, named as the LLD names it>.

Scope:
- In: <the files or modules it changes, with new files named. Count tests, type declarations,
  styles and this tracker too>.
- Out: <the nearby work it leaves to a named later task>.

How to check:
- <Each test it adds or changes, and what that test proves>.
- <The command or page where a person sees it work>.

Definition of done:
- The change is merged in one pull request within the size budget.
- Every check above passes, and existing tests change only where the LLD says.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### ST-1.1: <One sentence that names the step>.

<One sentence: what the step does and why>.

Definition of done:
- <The step is complete, and how that was checked>.

### BG-1: <One sentence that says what is wrong>.

<What happens, what should happen, and how to reproduce it>.

Definition of done:
- A test reproduces the bug, and it now passes.
- The cause is fixed, not only the symptom.
