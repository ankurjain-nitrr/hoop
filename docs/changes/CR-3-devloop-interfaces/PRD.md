# CR-3: devloop interfaces, sequential reviews and a Jira-like tracker

Status: folded · Revision: 5 · Owner: Ankur Jain · Type: epic · Request: `REQUEST.md`

## Problem

When a change runs through devloop, the order of its steps depends on the agent remembering the
rules. An HLD can be written, and even approved, before its PRD is approved; nothing records which
step a change is at; the tracker is a flat list that mixes requirements with work and is edited by
hand; and an agent session without hoop's tools has no supported way to use hoop. The requester
can't rely on the order being followed, and can't see at a glance where each change stands.

## Goals and non-goals

- Goal: every change follows change request → PRD → HLD → LLD → code, and hoop refuses to skip a step.
- Goal: the requester sees each change's step and its work as a tree, from the change request and its classification down to the most granular breakdown.
- Goal: agents use hoop for every step through supported interfaces, with or without MCP.
- Non-goal: priority, assignee and labels (not requested).
- Non-goal: enforcing order on the GitHub review channel in this change.

## Success metrics

| Metric | Baseline | Target | How measured |
|---|---|---|---|
| Documents approved out of order | possible (no check) | 0 | attempts refused, from the audit log |
| Changes whose current step is recorded | 0 of 3 | all new changes | tracker |
| Steps an agent can't do without hoop's MCP tools | 4 (submit, feedback, export, tracker) | 0 | command coverage |

## Users and scenarios

- **Requester:** writes a change request in their own words; reviews the PRD; only then sees an HLD
  to review; only then an LLD; then follows the work on a tracker that shows it as a tree-shaped dependency chain.
- **Agent:** captures the request, classifies it, writes each document only after the one before it
  is approved, records each step, and keeps the tracker current.

## Requirements

Intake and classification
- FR-1: When the requester gives a change request, the system shall keep it exactly as written,
  give it the next change number, and show it on the tracker at the intake step.
  Acceptance: Given a request text, when it is captured, then the stored request equals the text
  and the tracker shows the change at intake.
- FR-2: Each change shall be classified as epic, story, task or bug, with a one-line reason, and the
  requester can change the classification.
  Acceptance: Given a captured change, when the requester reclassifies it, then the tracker shows
  the new type and reason.
- FR-3: Every reclassification shall be recorded with the original and corrected type and why, and
  the agent's classification guidance shall be updated from these records.
  Acceptance: Given a reclassification, then a record of it exists, and the guidance names it.

Sequential reviews
- FR-4: A change's design documents shall be written and reviewed in order: PRD, then HLD, then LLD.
  The system shall refuse to start an HLD review until the PRD is approved, and an LLD review until
  the HLD is approved.
  Acceptance: Given an unapproved PRD, when an HLD is submitted, then it is refused with a message
  naming the PRD's review.
- FR-5: When an approved document is revised, the approved documents after it shall need approval
  again before code work starts.
  Acceptance: Given approved PRD, HLD and LLD, when the PRD gets a new revision, then HLD and LLD
  show as needing re-approval and code work is refused.

Steps and gates
- FR-6: The system shall record each change's step (intake, PRD, HLD, LLD, plan, build, review,
  acceptance, merge, fold, closed) and when it moved.
  Acceptance: Given a change moved through three steps, then its history lists the three moves
  with times.
- FR-7: The system shall refuse to start building unless PRD, HLD and LLD are approved and current,
  and refuse to fold unless all the change's PRs are merged.
  Acceptance: Given an unapproved LLD, when build is requested, then it is refused naming the LLD.

Tracker
- FR-8: The tracker shall hold work items (epic, story, task, sub-task, bug) as a tree, each with a
  status and, for epics, the current step; requirements are referenced, not copied.
  Acceptance: Given a tracker with items at four levels, then each item shows under its parent.
- FR-9: The requester shall see the repository's tracker as a tree table that can be expanded,
  collapsed and filtered by type and status.
  Acceptance: Given the tracker page, when a story is collapsed, then its tasks are hidden.
- FR-10: A tracker under review shall show as the same tree table, with each item commentable.
  Acceptance: Given a tracker review, when the reviewer comments on a task, then the comment is
  anchored to that task.

Interfaces
- FR-11: Everything the agent does with hoop shall be possible both through hoop's agent tools and
  through commands in a terminal.
  Acceptance: Given a session without hoop's agent tools, then capture, submit, feedback, export,
  step changes and tracker updates all work from the terminal.

devloop
- FR-12: devloop shall follow this flow for every change: capture and classify first, write each
  document only after the previous one is approved, PRD, HLD and LLD for every change (sized to
  it), record every step, and update the tracker through hoop.
  Acceptance: Given a new request, when devloop runs, then the HLD is not written before the PRD
  is approved.

Non-functional
- NFR-1: Every refusal says what is missing and what would satisfy it.
  Acceptance: each refusal in FR-4, FR-5 and FR-7 names the document or PR and the next action.
- NFR-2: Trackers and changes created before this change still load.
  Acceptance: the current project tracker and CR-1 and CR-2 load without edits.

## Out of scope

- Priority, assignee and labels.
- Gates on steps other than build and fold, beyond the PRD, HLD, LLD order.
- Order enforcement on the GitHub review channel.

## Assumptions and open questions

- A bug still gets an HLD and LLD, scaled down to a few lines.
- How the tracker stores items and steps is decided in the HLD and LLD.
