---
name: prd-review
description: Reviews a change's PRD in hoop with persona agents: a principal product manager for the whole product and a staff engineer for buildability. It holds the PRD's standards and checks it against the change request and the project's PRD. Use before a change's PRD goes to the requester, or for "review this PRD".
---

# PRD review

The owner is the `senior-product-manager` agent. The reviewers are `principal-product-manager`, who judges the change for the
whole product, and `staff-engineer`, who checks that it can be built and measured. Run the review as "Review in hoop with persona
agents" in `/devloop:project-docs` describes, and give each reviewer this skill.

## Standards for a PRD

- It follows the template in `/devloop:project-docs` (`references/PRD.md`), and its title names
  its kind. It has five sections in order. They are overview and objectives, user interactions and
  flows, UI states and transitions, edge cases and error handling, and out of scope.
- Each section holds only what the template says it holds. A section that doesn't apply says
  "None", with one sentence on why.
- It starts from the **problem** and who has it, before any solution. An objective that describes
  the product instead of the problem is a finding.
- Each **success criterion** has a baseline, a target and how it is measured. "Faster" or "better"
  alone is a finding.
- A quality bar for the whole product sits in section 1, and one for a single flow sits with that
  flow. Each one is measurable and says how it is observed.
- Each requirement states one observable **behavior**, in the form "When <trigger>, the product
  shall <behavior>".
- Each requirement has one **acceptance sentence** that a user or an agent could observe. It is
  measurable and never names a test. Given, When and Then is only for a case one sentence can't
  state.
- Each requirement ends with its **change tag**, the change requests that changed its behavior,
  oldest first: `Changes: CR-3, CR-22`. A change that only rewords it adds nothing. The text states
  current behavior, with no history.
- Section 1 lists every current behavior the change alters or removes, with the existing
  requirement it affects. The requester approves each such change explicitly, so the system never
  degrades quietly.
- Section 5 lists what is out of scope, and closes with the assumptions and open questions.
- Every requirement can be traced to the user's request, and nothing is invented.
- It is small: the change fits in about five pull requests and rewrites no whole component.

### What a PRD never holds

A reviewer comments on each of these that a PRD holds:

1. Prescribed implementation details, such as a tech stack, a database schema or a code
   architecture.
2. Vague or subjective acceptance criteria, such as "fast", "user friendly" or "intuitive".
3. Unbounded feature sets, with no clear boundaries or non-goals.
4. Unvalidated assumptions presented as facts, with no data, feedback or research behind them.
5. Hardcoded dates and fixed commitments. Scheduling belongs in the tracker.
6. Finished visual designs that leave no room to explore the experience.
7. A missing out of scope section.
8. Unlinked dependencies, such as a requirement that relies on an unlisted system or contract.
9. Solutions without problem statements.
10. Untestable edge cases, such as "the system must never fail".

### What a PRD may name

A PRD names only the public parts that a user or an agent types, reads or sets:
- Commands, and agent tools with their inputs and results.
- Document formats, with their versions.
- Pages, controls and settings.
- Files the user edits or reads.

It never names these:
- A source or test file.
- A function.
- An internal web address.
- How data is stored.

A name users type that looks like code, such as a file they edit, is listed in the project's
`docs/allowed-names.txt`, so the checker accepts it.

## The requester's approval

The review ends with the requester's final approval. An agent approval never counts as that
approval. When the final approval is marked `unverified`, tell the requester so.

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
- **Consistency:** Names, IDs and terms match the project's documents. New requirements take the
  next free project IDs, and a changed requirement keeps its ID.
