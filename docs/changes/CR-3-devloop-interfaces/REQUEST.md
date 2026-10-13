# CR-3: request as given

Captured as is, 2026-10-13. Classified: **epic** (several independent stories: intake, nested
reviews, phase tracking, tracker model, tracker UI, interfaces). Reason: more than one user-visible
capability, each releasable on its own.

## Messages

> the change tracker should be inform of bug / task / story / epic -> mimicking JIRA but still light
> weight. the UI of the tracker needs improvement. prefer more tabular tree like structure.

> the tracker should also track devloop transition. first build the interfaces in hoop for devloop
> to interact. prod, hld, lld should all be approved before the development starts

> all reviews should be nested. i should not be able to approve HLD before related PRD changes are
> approved. you should hold even creating HLD .. everything happens sequencially tracked via devloop
> tracker.
>
> my requests are first captured as change request -> as is which then gets translated into PRD -
> HLD -> LLD -> code changes PRs etc.

## Answers to scoping questions

- Tracker data: TRACKER.md stays the source.
- Types: epic, story, task, bug, sub-task.
- Phases: record and enforce gates; gated moves: build and fold.
- Interfaces: MCP tools and matching CLI commands.
- Mapping: "change request is my initial input appropriately scoped. which then maybe classified as
  epic, story, task or bug fix (learn and capture to help classify this better) and to devloop skill"
- Tracker UI: both a live tracker page and tracker reviews rendered as a tree table.
- Extra fields (priority, assignee, labels): not answered; assumed none beyond Type and Phase.
