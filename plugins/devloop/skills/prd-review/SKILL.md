---
name: prd-review
description: Reviews a change's PRD in hoop with persona agents: a principal product manager for the whole product and a staff engineer for buildability. It holds the PRD's standards and checks it against the change request and the project's PRD. Use before a change's PRD goes to the requester, or for "review this PRD".
---

# PRD review

The owner is the `senior-product-manager` agent. The reviewers are `principal-product-manager`, who judges the change for the
whole product, and `staff-engineer`, who checks that it can be built and measured. Run the review as "Review in hoop with persona
agents" in `/devloop:project-docs` describes, and give each reviewer this skill.

## Standards for a PRD

- It starts from the **problem** and who has it, before any solution. A goal that describes the
  product instead of the problem is a finding.
- Its **goals and non-goals** are explicit, and it lists what is out of scope.
- Each **success metric** has a baseline, a target and how it is measured. "Faster" or "better"
  alone is a finding.
- Each requirement states one observable **behavior**, in the form "When <trigger>, the
  system shall <behavior>". It has **acceptance criteria** a tester could run, such as Given,
  When and Then.
- A test file name is not an acceptance criterion.
- It holds no **implementation**: no tool or function names, file paths, schemas, libraries or
  storage choices. Those belong in the HLD or LLD. User-facing names, such as a command or a page,
  are fine.
- Its **non-functional requirements** are measurable and say how they are checked. An unmeasured
  target says so.
- Every requirement can be traced to the user's request, and nothing is invented.
- It lists every current behavior it changes or removes, with the existing requirement it affects.
  The requester approves each such change explicitly, so the system never degrades quietly.
- It is small: the change fits in about five pull requests and rewrites no whole component.

## Checks against the change request

- **Coverage:** Every ask in `REQUEST.md` has a requirement with an acceptance test, or is named as
  out of scope.
- **Scope creep:** Nothing is added that the request didn't ask for, unless it is named as an
  assumption for the requester to confirm.
- **Faithfulness:** No ask is narrowed, widened or reworded so that it means something else. Quote
  the request where they differ.
- **Notes:** Each overlap decision in `NOTES.md` is respected, such as work moved to another change.

## Checks against the project's PRD

- **Conflicts:** Nothing contradicts an existing requirement in the project's `docs/PRD.md`.
- **Silent changes:** Every change to settled behavior, an interface, a stored format or a decision
  is named, with the existing ID it changes.
- **Duplicates:** Nothing repeats an existing requirement under a new name. Reuse the existing one.
- **Consistency:** Names, IDs and terms match the project's documents, and new IDs don't clash.
