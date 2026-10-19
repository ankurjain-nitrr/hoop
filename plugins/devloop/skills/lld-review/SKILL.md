---
name: lld-review
description: Reviews a change's LLD in hoop with persona agents: a staff engineer for soundness and an engineer (L4) who checks it against today's code. It holds the LLD's standards and checks it against its PRD, HLD and the project's LLD. Use before a change's LLD goes to the requester, or for "review this LLD".
---

# LLD review

The owner is the `senior-engineer` agent. The reviewers are `staff-engineer` and `engineer-l4`. The staff engineer asks
whether it is sound and fits the HLD. The engineer (L4) checks every claim against today's code. Run the review as "Review in hoop with persona
agents" in `/devloop:project-docs` describes, and give each reviewer this skill.

## Standards for an LLD

- It describes design, not code. Its code-level detail is limited to three things:
  - New files, and what each one holds.
  - The design patterns it uses, and why.
  - The public interfaces that one layer or package calls in another, with their inputs, outputs and
    errors. Data that crosses such a boundary, such as an API field or a stored format, counts too.
- Logic inside a file needs no design review. Private helpers, function bodies, regular
  expressions, styles, line numbers and test assertions are left to code review. An LLD that reads
  like a code review is a finding.
- Each component states its responsibility, the states it moves through, and how its errors reach
  callers.
- Consistent with the HLD: same components, same interactions; anything new is a finding against
  the HLD.
- A **test plan** maps every requirement to tests at the right level (unit, integration,
  end to end), each with what it proves.
- Its diagrams are written in Mermaid: a `sequenceDiagram` for detailed interactions, and a
  `stateDiagram-v2` or `classDiagram` where a component has state or types. A diagram drawn any
  other way is a finding, unless Mermaid can't express it.
- It follows the template in `/devloop:project-docs` (`references/LLD.md`), and keeps it simple:
  empty sections are left out.

## Checks against the change request, the approved PRD and the approved HLD

- **Coverage:** Every HLD component and decision has a design, and every PRD requirement has a test.
- **Scope creep:** Nothing is built that the HLD and PRD don't call for, unless it is named.
- **Faithfulness:** The design keeps the HLD's components, boundaries and interfaces. A needed
  change to the HLD goes back to the HLD first.
- **Notes:** Each overlap decision in `NOTES.md` is respected.

## Checks against the project's LLD

- **Conflicts:** Nothing contradicts an existing component design or interface in the project's `docs/LLD.md`.
- **Silent changes:** Every change to settled behavior, an interface, a stored format or a decision
  is named, with the existing ID it changes.
- **Duplicates:** Nothing repeats an existing component design or interface under a new name. Reuse the existing one.
- **Consistency:** Names, IDs and terms match the project's documents, and new IDs don't clash.

## Checks against the code as it is today

The engineer (L4) makes these checks by reading the code. They stay at the level the LLD allows:
new files, design patterns and the public interfaces between layers and packages.
- Each new file doesn't clash with an existing one, and sits in the right layer.
- Each public interface the LLD names exists as described, or is clearly new, and its callers in
  other packages are named.
- Each claim about current behavior across a boundary is true.
- Every step can be built as written, in the order the pull request plan gives.
- Logic inside a file isn't checked here. It belongs to the code review of the pull request.
