---
name: scope
description: Scopes and freezes the functional requirements for a queued change with the user before any planning or code, by researching, asking wide then narrow questions, and writing them as testable requirements. Use when a queued change is picked up, whenever a feature request is short or leaves behavior undecided ("add order export", "support refunds"), or for "scope this", "requirements", "spec it out", "interview me" or "freeze the scope". Capturing and queueing a new request is `/devloop:intake`. Not for typo-level fixes or edits whose behavior is already fully specified.
---

# Scope and freeze requirements

This starts when a queued change is picked up. Capturing and queueing a request comes first, in
`/devloop:intake`.

Agree on *what* gets built before anyone decides *how*. The output is a short, frozen list of
testable requirements. If the repo has its own spec format or location (`CLAUDE.md`, `docs/specs/`,
an issue template), use it.

Scale it to the change: a one-line bug fix needs one round and three lines; a new feature needs
several rounds.

## 0. The pick-up check

The system may have moved since the request was captured. Before scoping, check the queued change
again, against everything merged since it was captured and against the other queued changes. The
outcome is one of these: proceed, shrink, merge into another change, drop, or a decision only the
requester can make. Record it in the change's history with
`hoop cr step <CR> --event pickup --verdict <outcome> --note <reasons>`, and tell the requester. A
merge or a drop also gets its own event on each change it touches. A change that would now degrade behavior the system already has goes back to the
requester before any scoping.

Check its size again too. A change that needs more than five pull requests, or rewrites most of a
component, is split into smaller changes that each ship working behavior. Record a split with
`hoop cr step <CR> --event split --verdict <v> --note <text>` on each change. When hoop flags a
change as too big and the requester keeps it whole, record that choice with
`hoop cr step <CR> --event size --verdict keep --note <reason>`.

## 1. Research before asking

Don't ask what you can look up. Read the request, linked issues, and the code, tests and docs
around the change. Check how similar features in the repo behave. Search the web when the domain
or an external API is unfamiliar. Note what you learned and what is still unknown. Every question
you ask should be one only the user can answer.

## 2. Ask: go wide first

Use the AskUserQuestion tool, or otherwise a numbered list, with up to 4 questions per round. Give
each 2 to 4 concrete options with your recommended one first, so answering is quick. Ask about decisions,
not facts you could find.

Round 1 covers the breadth, picking the dimensions that matter for this change:

- **Goal:** Ask about the problem, who has it, and what success looks like.
- **Actors and entry points:** Ask about users, roles and other systems, and whether they come
  through a UI, an API, a CLI, jobs or events.
- **Behaviors:** Ask about the main flows, and what is explicitly out of scope.
- **Data:** Ask about inputs, outputs, validation, persistence and moving existing data.
- **Edge cases and errors:** Ask about empty, duplicate and concurrent input, partial failure and
  permissions.
- **Non-functional:** Ask about performance, security, privacy, compatibility, observability and
  limits.
- **Constraints:** Ask about deadlines, dependencies and things that must not change.

## 3. Narrow down

Each later round asks only about what is still open: answers that raised new questions, options
that need a detail, conflicts between answers. Drill into one area at a time.

Stop when every requirement is testable and no open question would change what gets built. If the
user wants to move on earlier, record the remaining unknowns as explicit assumptions.

## 4. Write the requirements

Keep it to about a page:

```markdown
# <Change>: requirements

Goal: <one sentence>

## Functional
- FR-<next free ID>: When <trigger or condition>, the product shall <behavior>.
  Acceptance: <one sentence a user or an agent could observe>. Changes: CR-<n>.
- FR-<next free ID + 1>: ...

## Non-functional
- NFR-<next free ID>: <measurable constraint>. Acceptance: <how it is observed>. Changes: CR-<n>.

## Out of scope
- <explicitly excluded behavior>

## Assumptions
- <decided without the user's answer; flip it if wrong>

Status: frozen (rev 1)
```

Each requirement states one observable behavior in the present tense, not an implementation
choice; split anything with "and". Its acceptance sentence names no test. No open questions remain
in a frozen spec.

Requirement IDs belong to the project. A new requirement takes the next free project ID. Read the
project's `docs/PRD.md` and every queued change's PRD for the highest `FR` and `NFR` numbers in
use. A change to an existing requirement keeps its ID, and adds this change to its tag.

## 5. Freeze

Scope and write the PRD as the plugin's `senior-product-manager` agent would, or start that agent
to write it. A principal product manager reviews it through the document type's review skill (`/devloop:prd-review`, `/devloop:hld-review` or `/devloop:lld-review`).

Write the requirements as complete, simple sentences without dashes, following the `writing-style` skill bundled with this plugin (`/devloop:writing-style`).
The captured request in `REQUEST.md` keeps the requester's own words.

Write the requirements as the change request's PRD, `docs/changes/CR-<n>-<slug>/PRD.md`, in the
five sections of the template in `/devloop:project-docs`. Have it reviewed through hoop; approval
there is the freeze (`Status: approved`, revision 1). Commit it as the first commit of the change's
branch. Without hoop (it's required), stop and ask the user to install it.

## 6. Change control after the freeze

- New ideas, scope creep and "while we're here" changes found later are not built silently.
- Write each as a delta (`+ FR-7 ...`, `~ FR-2 ...`, `- FR-4`) with its impact on the plan and the
  PR size, and ask. Approved: update the spec and bump the revision (`rev 2`). Declined: list it as
  a follow-up.
- Implementation details (how) can change without this; behavior (what) can't.

## Hand-off

Plan lines, tests and PR descriptions refer to requirement IDs (`FR-3`), so every requirement is
covered and nothing outside them is built. In devloop, planning starts from the frozen spec.
