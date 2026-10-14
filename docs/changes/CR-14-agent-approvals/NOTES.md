# CR-14: intake notes

Captured on 2026-10-14 with `hoop cr create`, from the same request as CR-15 and CR-16. The request
was split into three changes so that each stays small. The state is queued. The proposed type is
story and the kind is functional. The project is hoop.

## What it covers

- Agents give feedback only as comments on documents.
- Agents approve a document only through hoop's approval interface, as agent approvers. An agent's
  approval doesn't freeze the review. Only the requester's approval does.
- Each document keeps an audit trail of every comment, agent approval and requester approval.

## Capture check

The verdict is new. Nothing queued covers agent approvals. CR-3 built the reviews and approvals
that this extends, and it isn't reopened.

The queue order is CR-13, CR-14, CR-15, CR-16, CR-10, CR-11, CR-12, CR-6, CR-5 and CR-7, after
CR-9.

## Reordered on 2026-10-14 (CR-18)

It runs after CR-5. Its scope is unchanged.
