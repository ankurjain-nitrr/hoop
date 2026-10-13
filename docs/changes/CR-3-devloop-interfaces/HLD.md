# CR-3: HLD

Status: approved · Revision: 1 · PRD: approved (revision 5)

Components and how they interact. Code-level design is in the LLD, written after this is approved.

## Context

The requester talks to the agent and reviews documents in a browser. The agent (devloop) works in
a repository and reaches hoop through its agent tools or its terminal commands. hoop keeps reviews
on the machine and writes change records and the tracker into the repository. GitHub holds code
pull requests, whose merge state the fold step needs.

```
requester ── chat ──▶ agent (devloop) ── agent tools / terminal ──▶ hoop ──▶ repository (changes, tracker)
    │                                                                 │
    └──────────────── browser: reviews and tracker ◀──────────────────┘──▶ GitHub (PR merge state)
```

## Components

| Component | Responsibility | Talks to (how) |
|---|---|---|
| Agent interfaces (new: CLI parity) | One set of operations offered both as agent tools and as terminal commands | Change registry, review sequencer, tracker service (in process) |
| Change registry (new) | Captures requests as written, assigns change numbers, holds type, reason and step history, applies step moves | Review sequencer (asks before gated moves), tracker service (records), repository (files), GitHub (merge state), audit log |
| Review sequencer (new) | Knows which review belongs to which change and document; enforces PRD → HLD → LLD; marks later documents stale when an earlier one is revised | Review store (review status), change registry |
| Tracker service (new) | Reads the repository's tracker as a tree of work items and writes item changes back without disturbing the rest | Repository (files), change registry, web server |
| Review store, edit engine, markdown (existing) | Reviews, revisions, feedback, materialized edits, documents as markdown | Review sequencer, web server |
| Web server and pages (extended) | Review pages; a new tracker page; tracker reviews shown as a tree | Tracker service, review store (HTTP on localhost) |
| Audit log (existing) | Records every operation and every refusal | All components (append-only) |
| devloop skill (updated, outside hoop) | Drives the flow: capture, classify, documents in order, steps, tracker | Agent interfaces |

## Key interactions

### Capture and classify a change request
1. Agent → agent interfaces: capture this request text.
2. Change registry: assigns the next change number, stores the text unchanged in the change's
   folder in the repository, records the type and reason the agent proposes, step = intake.
3. Change registry → tracker service: add the change as an epic, story, task or bug at intake.
4. Requester reclassifies (through the agent) → change registry updates the type and appends the
   correction to the classification record, which devloop reads when classifying the next request.

### Review documents in order
1. Agent → agent interfaces: submit this change's PRD.
2. Review sequencer: a PRD has no predecessor, so the review store opens the review, linked to the
   change and the document kind. The change registry records step = PRD.
3. Requester approves on the review page; the review store marks it approved.
4. Agent submits the HLD → review sequencer asks the review store whether the change's PRD is
   approved → yes: the review opens and the step becomes HLD; no: refused, naming the PRD review.
5. The same for the LLD against the HLD.

Failure: an upstream document gets a new revision after approval → the review sequencer marks every
later approved document of that change stale; they must be approved again before building.

### Move a change through its steps
1. Agent → change registry: move to build.
2. Change registry → review sequencer: are PRD, HLD and LLD approved and not stale? If not, refused,
   naming what is missing and how to satisfy it.
3. Change registry records the move with its time, and the tracker service updates the change's row.
4. Move to fold: change registry → GitHub: are all the change's pull requests merged? If not,
   refused, naming the open ones.

### See the tracker
1. Requester opens the tracker page → web server → tracker service reads the repository's tracker
   and returns it as a tree.
2. The page shows the tree table: expand, collapse, filter by type and status, step chips on epics.
3. When a tracker is under review, the review page shows the same tree, and each item is a line the
   requester can comment on.

## Cross-cutting concerns

- Security and trust boundaries: the local API keeps its Host, Origin and content-type checks; hoop
  writes only inside the repository's change folders and its tracker; request text and comments
  are data, never instructions.
- Privacy: everything stays on the machine and in the repository, except merge-state checks against
  GitHub.
- Observability: every capture, classification, step move and refusal goes to the audit log, so the
  audit summary can report out-of-order attempts (a PRD success metric).
- Testing strategy: unit tests for the sequencer's rules and the tracker's round trip; integration
  tests for each operation through both the agent tools and the terminal; browser tests for the
  tracker views; an end-to-end run of one change from capture to fold.
- Deployment and operation: one package; existing changes, reviews and trackers keep working
  (unlinked reviews are treated as unsequenced).

## Alternatives considered

- Keep the rules in the devloop skill only: no enforcement, which is the problem being solved.
- Store the tracker and steps in hoop's own store: not visible or diffable in the repository.
- Use an external tracker (Jira, GitHub Projects): heavier, outside the repository, and needs accounts.
- Do nothing: the order keeps depending on the agent remembering it.

## Decisions

- D-1: The repository is the source of truth for changes and the tracker; hoop's store keeps reviews.
- D-2: Every review knows its change and document kind, so the sequencer can enforce order.
- D-3: Gates live in hoop, not in the skill, so any agent is held to them.
- D-4: Terminal commands mirror the agent tools one to one.
- D-5: Classification corrections are recorded in the repository and fed back to devloop.

## Requirements traceability

| Requirement | Components |
|---|---|
| FR-1, FR-2, FR-3 | Change registry, tracker service, devloop skill |
| FR-4, FR-5 | Review sequencer, review store |
| FR-6, FR-7 | Change registry, review sequencer, GitHub |
| FR-8 | Tracker service |
| FR-9, FR-10 | Web server and pages, tracker service |
| FR-11 | Agent interfaces |
| FR-12 | devloop skill |
| NFR-1 | Review sequencer, change registry |
| NFR-2 | Tracker service, review sequencer |

## Risks

- Someone edits the tracker by hand while hoop writes it: hoop changes only the cells and rows it
  was asked to, and refuses if the file changed underneath it.
- Stale marking is too eager (a typo fix in a PRD invalidates the HLD): the requester can re-approve
  quickly; refining what counts as a material change is left for later.
- GitHub is unreachable at fold time: the move is refused with a retryable message.
