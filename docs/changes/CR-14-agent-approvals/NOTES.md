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

## Merged on 2026-10-19 (CR-21)

CR-14 absorbs B-9 and B-17. On 2026-10-19 the requester said "the final approval should be based on auth by github". So the final approval needs a GitHub sign-in that only the person can complete. A request from the machine, or the agent's own `gh` token, isn't enough. Agents still approve only as agents. An approval can carry notes, and the decision record keeps them. Each document keeps its audit trail. A plan mode hook pairs with the gate, so an agent stops until the approval exists. Today any local request can approve under any name, so this is the main trust fix. Scoping should split it into stories, and any new command or tool needs the requester's approval first.

## Usability review (2026-10-19)

CR-24 reports what an approval wrote, and CR-14 adds its notes to the same result. CR-26 adds waiting through MCP, and the plan mode hook builds on it. So both run before this change.
