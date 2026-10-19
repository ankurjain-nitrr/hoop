---
name: intake
description: Captures a new request as a change request in the requester's own words, classifies it, queues it, and resolves its overlaps with the other queued requests. It also captures bug reports. Use whenever the user gives a new request, change request or bug report ("capture this", "queue it", "new CR", "file this bug"), even mid-way through other work.
---

# Intake

Every request becomes a change request before any work on it starts.

Capture every request as a change request, in the requester's own words, and **queue** it. Use
`hoop cr create` (or `hoop_cr_create`). It writes `docs/changes/CR-<n>-<slug>/REQUEST.md` byte for
byte and adds the change to the tracker, as `/devloop:project-docs` describes.

Classify it as epic, story, task or bug, with a one-line reason. Read
`docs/changes/CLASSIFICATION.md` first. When the requester corrects a type, record it with
`hoop cr classify <CR> <type> --reason ... --why ...`, so later classifications learn from it.

A request that arrives while another change is in progress is queued, not folded in, unless the
requester says so.

## The capture check

The requester judges a request against the system as it is today. They can't see what is already
queued, or what the system will be when the request is built. So each new request gets a capture
check before it is queued, against two things:
- Every **queued** request: the same behavior, the same documents or files, conflicting goals, or
  one depending on another.
- The **system as it is now**: the project's PRD, HLD and LLD, and the code where they don't say.

The check gives one verdict, with its reasons. The verdicts are new, already done, partly done,
duplicate of CR-n, and conflict with CR-n. Resolve each overlap by merging, ordering, splitting or
dropping a duplicate. Record the verdict and the resolution on the change in hoop, as a revision with
comments. Until hoop supports that, record them in both changes' notes. Tell the requester what was
decided, so they can change it. In-progress changes aren't reopened. Note any dependency on them instead.

## Keep each change small

A change request must stay small enough to land in a handful of pull requests. A request that would
need more than five pull requests, or rewrite most of a component, is split before it is queued.
Each part ships working behavior on its own, and the parts are queued in order. No change request
may come near to rewriting the whole application.

A bug report is captured the same way, with type bug. Its definition of done starts with a test
that reproduces the bug and fails before the fix.
