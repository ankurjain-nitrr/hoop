---
name: hld-review
description: Reviews a change's HLD in hoop with a principal engineer persona agent. It holds the HLD's standards and checks the design against the change request, its approved PRD and the project's HLD. Use before a change's HLD goes to the requester, or for "review this HLD".
---

# HLD review

The owner is the `staff-engineer` agent. The reviewer is `principal-engineer`, who asks whether it is the right design for
the organization. Run the review as "Review in hoop with persona
agents" in `/devloop:project-docs` describes, and give each reviewer this skill.

## Standards for an HLD

- It shows the system in its **context**, with its people and external systems. It shows its
  **components** and their responsibilities, at the level of C4's context and container views.
- It describes the **interactions** for each key scenario: who calls whom, in what order and with
  what, including failure paths.
- It states the **interfaces between components** by purpose and protocol, such as HTTP on
  localhost or files on disk. It doesn't give function signatures or field lists.
- It covers the **cross-cutting concerns**: security and trust boundaries, privacy, observability,
  testing strategy, deployment and operation.
- It records the **alternatives**, including doing nothing, and the **decisions** with their reasons.
- It traces every requirement to the components that meet it.
- It holds **no code-level detail**. That means no source file names, function names, data
  structures, field lists, file formats, algorithms, environment variables or command flags. Each
  one found is a finding to move into the LLD.
- Its diagrams are written in Mermaid: a `flowchart` for context, architecture and data flow, and a
  `sequenceDiagram` for each key interaction. A diagram drawn any other way is a finding, unless
  Mermaid can't express it.
- It follows the template in `/devloop:project-docs` (`references/HLD.md`), and keeps it simple:
  empty sections are left out.

## Checks against the change request and the approved PRD

- **Coverage:** Every requirement in the approved PRD maps to a component, and every component
  serves a requirement.
- **Scope creep:** No component or interface goes beyond what the PRD asks, unless it is named.
- **Faithfulness:** The design doesn't change what a requirement means. Quote the PRD where they
  differ.
- **Notes:** Each overlap decision in `NOTES.md` is respected.

## Checks against the project's HLD

- **Conflicts:** Nothing contradicts an existing component or decision in the project's `docs/HLD.md`.
- **Silent changes:** Every change to settled behavior, an interface, a stored format or a decision
  is named, with the existing ID it changes.
- **Duplicates:** Nothing repeats an existing component or decision under a new name. Reuse the existing one.
- **Consistency:** Names, IDs and terms match the project's documents, and new IDs don't clash.
