# CR-30: notes

Captured on 2026-10-20 with `hoop cr create`. The proposed type is task. The project is hoop.

## What the request means

- A PRD states what and why. It never names code: no source or test file, function, environment
  variable, HTTP route, result field, schema or storage.
- A PRD avoids the ten things the requester listed, and follows the five sections they gave.
  Those are the overview and objectives, user interactions and flows, UI states, edge cases and
  errors, and out of scope.
- Every acceptance criterion is something a user can observe, and it is measurable.
- The tests that prove each requirement move to the LLD's test plan, keyed by requirement.
- The devloop skills hold these rules, so new PRDs follow them.
- The hoop PRD is rewritten to follow them, and no information is lost. Code detail that the
  PRD holds today moves to the HLD or the LLD.

## Capture check

The verdict is new, and it overlaps CR-29.
- Today hoop's PRD names a test in each of its 64 checks, and mentions code 92 times.
- The devloop PRD template and its PRD review don't forbid code, so new PRDs keep naming it.
- CR-29 asks that HLDs and LLDs point only to requirements, and that requirements point to change
  requests. It changes the same documents and the same skills.
- Resolution: CR-29 is merged into this change, so the PRD, HLD and LLD are rewritten once and
  reviewed once. CR-29's request stays in its own folder, in the requester's words. This change
  meets both requests.
- It runs first in the queue, because every later document depends on it.

## Open points for scoping

- How each requirement names its change requests, without filling the PRD with history.
- Whether each change's own PRD, HLD and LLD follow the rules too, or only new ones. An approved
  change document is a frozen record, so the plan is to apply the rules to new ones only.
- Whether the writing checker should flag code in a PRD, and change request names in an HLD or an
  LLD.

## Pick-up check (2026-10-20)

The verdict is proceed. Since capture, only CR-22's fold merged. It added more change tags and
test names to the project PRD, so the rewrite grows a little. The change fits in about four pull
requests.

## Scoping answers (2026-10-20)

- Every PRD follows the requester's five sections. Numbered requirements sit in the section they
  belong to, and a section that doesn't apply says "None" and why.
- A PRD names only what users type or see: commands, agent tool names, pages, settings and files
  the user edits.
- Each requirement ends with a short tag that names its change requests.
- The writing checker flags code in a PRD, and change request names in an HLD or an LLD.
- Each requirement gets one observable acceptance sentence. Test names move to the LLD.
- Internal non-functional requirements move to the HLD, and their IDs retire.
- The missing states are designed as a production review tool would have them, from comparable
  products. Those hoop lacks become new queued change requests, not part of this change.
- Documents of past changes stay as they are.

## Merged into CR-31 (2026-10-20)

The requester merged every queued change into CR-31, to be built in one go as one pull request.
This change's request stays here, in the requester's words, and CR-31 meets it.
