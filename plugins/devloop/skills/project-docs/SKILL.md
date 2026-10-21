---
name: project-docs
description: Keeps a project's PRD, HLD, LLD and execution tracker current, at project level and for each change request, with every change to them reviewed and materialized through hoop. Use when setting up a project's design docs, writing a change's PRD, HLD, LLD or tracker, updating the tracker, folding a merged change's docs into the project docs, or for "PRD", "HLD", "LLD", "design doc", "tracker" or "fold CR-n".
---

# Project docs: PRD, HLD, LLD and tracker

Every project keeps four living documents, and every change request (CR) keeps the same four for
its own scope. A CR's documents are folded into the project's right after the CR merges, so the
project documents always describe what is on `main`. If the repo's `CLAUDE.md` sets another
layout, follow it.

| Document | Says | Template |
|---|---|---|
| `PRD.md` | What and why, in five sections: overview and objectives, flows, UI states, edge cases and errors, out of scope. Numbered requirements (`FR-n`, `NFR-n`) each have one acceptance sentence and a change tag. No code. | [references/PRD.md](references/PRD.md) |
| `HLD.md` | Components and how they interact, cross-cutting concerns, alternatives, decisions; no code-level detail. Points only to requirement IDs. | [references/HLD.md](references/HLD.md) |
| `LLD.md` | Per module: data models, signatures, algorithms, error handling, and a test plan that names each requirement's tests. Points only to requirement IDs. | [references/LLD.md](references/LLD.md) |
| `TRACKER.md` | Execution: work items (epic, story, task, sub-task, bug) as a tree, with status, phase, PR, dates. A change request isn't a row; its epic names it. | [references/TRACKER.md](references/TRACKER.md) |

## Layout

```
docs/PRD.md  docs/HLD.md  docs/LLD.md  docs/TRACKER.md      project level: what is on main
docs/changes/CR-<n>-<slug>/{PRD,HLD,LLD,TRACKER}.md         one folder per change request
```

`<n>` is the next unused number. A CR's `PRD.md` starts with
`Status: proposed | approved | implementing | merged | folded | rejected | withdrawn` and
`Revision: <n>`; nothing builds before `approved`, and a change after approval is a new revision.
Each document's title names its kind, as in `# CR-7 PRD: <name>` or `# <Project> HLD`. The
checker learns the kind from the title.

Requirement IDs belong to the project. A change's requirements take the next free project IDs when
it is scoped (`/devloop:scope`), and a change to an existing requirement keeps its ID. So an ID
means the same requirement in the change's documents and, after the fold, in the project's.

## Every change gets all four, in order

Every change gets a PRD, HLD, LLD and tracker rows, sized to it: a bug's HLD and LLD can be a few
lines. They are written and approved strictly in order. Don't write the HLD until the PRD is
approved, or the LLD until the HLD is. hoop enforces this when each review is linked to its change,
and when an approved document is revised, the documents after it need approval again.

## Standards for each document

Each review skill holds its document's standards: `/devloop:prd-review`, `/devloop:hld-review`
and `/devloop:lld-review`. The tracker's standards are below. Before a document goes to review, its owner
checks it against its standards and fixes what fails. Then the owner runs the check that the
project configures for hoop in its `hoop.config.json`. Without one, run the checker in
`/devloop:writing-style`. Both give the same findings that hoop shows on submit. A document isn't
ready until the check reports nothing. Then read it as a demanding reviewer would.

Each document has one job. Most problems are content at the wrong level: a solution in the PRD,
code in the HLD, requirements in the tracker. A PRD names no code, and an HLD or an LLD names no
change request outside its title and status line.

A project lists the names its users type that look like code, such as a file the user edits, in
`docs/allowed-names.txt`, one per line. The checker never flags a listed name in a PRD.

### Tracker: work items, not requirements

- Rows are **work items**: epics, stories, tasks, sub-tasks and bugs. Requirements live in the PRD
  and are referenced from the items that deliver them, not copied in as rows.
- One **parent** per row, so the hierarchy is a tree (epic → story → task → sub-task; a bug under
  the item it affects).
- Stories meet **INVEST** (independent, negotiable, valuable, estimable, small, testable) and state
  the user value; a story with no user benefit is a task.
- Each story or bug has **acceptance criteria**, or points to the PRD's.
- A change request isn't a row. The change's root work item is an **epic** that names its change in
  the `Change` column. A `Project` column is optional, and an empty cell means the repository's
  name.
- Every item has a **description block** under "Items" with its own **definition of done**, at its
  own level. Write each point as a task list item, and check it when it holds. Flag a missing
  block, and a point no one could check. Flag a definition copied from another level, such as a
  task that says "users can export orders", or an epic that says "tests pass".
- A description says **what is expected**, not only what the item is called. An epic, story or
  task block has a why, what is expected, what is out of scope and the definition of done. A
  task's block also names the files it touches and how to check it. Then someone else could build
  and verify the task from its block alone. Flag a block that only restates its title.
- A task's **size** is counted from the files its block names. Those include tests, type
  declarations, styles and the tracker. It is written as `<n> files, <m> lines`, since hoop sums
  only that form. Once the task merges, the row holds the actual size. Notes
  say why when the estimate was off by more than half.
- Status, phase and dates are current; nothing is `done` without its PR.

## Review in hoop with persona agents

A change's PRD, HLD and LLD are each reviewed in hoop by persona agents before the requester sees
them. Each document type has its own review skill, which names its owner, its reviewers and what
they check. This section is the procedure all three share. Every agent preloads
`devloop:principles`, `devloop:review-comments` and `devloop:writing-style`. Each agent's brief
names the project's root folder. The agent reads every `CLAUDE.md` and README there first, along
with the project documents. The project's guides say how to comment in hoop.

### Open the review in hoop

Submit the document linked to its change. The command is
`hoop submit <file> --cr <CR> --doc <prd|hld|lld>`. Note the review ID. To review a revision of
an approved document, open a new review in two steps. Its first revision is the approved text, and
its second is the new one. Then the threads sit on what changed.

### Cycle one: reviewers comment

Start every reviewer agent for the document at once, each in a fresh context. Give each one these
inputs:
- The review ID and the hoop address.
- Its own working folder for the files it writes. Reviewers that share a folder can overwrite each
  other's files and post each other's comments.
- The paths of the change's `REQUEST.md`, `NOTES.md` and approved documents above this one.
- The project's `docs/PRD.md`, `docs/HLD.md` and `docs/LLD.md`.
- The project's root folder. The agent reads every `CLAUDE.md` and README in it before it reviews.
- What to look at, in the reviewer's own terms. Never ask a reviewer to check something below its
  altitude, such as asking a principal engineer to read page code. The persona and
  `devloop:review-comments` say what each role raises.
- The document type's review skill: `/devloop:prd-review`, `/devloop:hld-review` or
  `/devloop:lld-review`. Reviewers also judge the work against `devloop:principles`.

Each reviewer checks its comments with the `writing-style` checker, then posts them to hoop with
the verdict "comment" and returns a one-line summary. A reply can't be edited after it is posted,
so the check comes first.
An approve sent without a person's GitHub sign-in is recorded as an agent approval. Its feedback
entry holds `agent_approval: true`. It never freezes the review and never counts as the approval a
gate waits for, so read it as another reviewer's comment. Every comment, agent approval and
requester approval stays on the document as its audit trail.

### The owner answers

As the owner, read the comments with `hoop feedback <review_id>`. Answer every thread with
`hoop reply`: accept and change the document, decline with a reason, or ask. Submit document changes
as a new revision with `hoop submit <file> --review <review_id>`, or as tracked changes with
`hoop propose`. Check the writing again before each revision.

### Cycle two, then the owner's call

Start each reviewer whose threads got an answer once more, with the review ID. It replies once on
each of its threads: agree, or say what still worries it. The owner answers again. After that, a
thread that still disagrees gets the owner's reply "Decision: <what and why>." The reviewer
disagrees and commits, and no third cycle runs.

### Resolve every agent thread, then hand over

The requester sees only what still needs them. So before the handover, every thread from the agent
review is resolved, and the review tool shows resolved threads collapsed.
- A reviewer resolves each of its threads that it agrees with, in its last cycle.
- The owner resolves the rest, after its "Decision:" reply.
- Resolve before the final revision is submitted. The tool's notes for the review, such as hoop's
  CLAUDE.md, say how and why.
- Never resolve a thread for the requester, and never edit a document after the requester approves
  it. An approved review is frozen.

### Hand over to the requester

Tell the requester the review's address and a short summary: how many comments each reviewer made,
how many were accepted or declined, and each "Decision:". The requester reads the threads on the
document and approves, comments or requests changes. A requester's comment starts a new cycle with
the owner.

Only the requester's final approval passes the gate. When it arrives, read it in the feedback. An
approval marked `unverified` was made without a GitHub sign-in, so tell the requester it is
unverified when you report the gate as passed.

## Every change goes through hoop

Every change needs hoop: its MCP tools, or the same operations as `hoop` terminal commands
(`hoop help`) when the tools aren't loaded. If neither is available, stop and ask the user to install it
(`claude mcp add hoop -- hoop mcp`).

Agents never edit hoop's own config in the user's hoop folder, such as `~/.hoop/config.json`. Only
the user changes it. When hoop says a check command isn't allowed, show the user the entry hoop
gives and ask them to add it.

1. Write the document as its owner. A PRD's owner is the `senior-product-manager` agent, an HLD's
   is `staff-engineer` and an LLD's is `senior-engineer`, each in this plugin's `agents/`. Check it against
   its standards in its review skill and fix what fails. Then submit it, linked to its change:
   `hoop submit <file> --cr <CR> --doc <prd|hld|lld>` (or `hoop_submit` with `change`;
   `--channel github` for team review). A refusal names what to approve first. The tool
   `hoop_submit` takes markdown, and `hoop_submit_decision` takes a `hoop/review@0` document.
   `hoop_submit_markdown` is an old name for `hoop_submit`.
2. For a change's PRD, HLD or LLD, run its review as "Review in hoop with persona agents" above
   describes. Use the review skill for its kind of document. Its
   reviewer agents comment on the document in hoop. The owner answers in the threads for at most
   two cycles, and makes the final call on what stays open. Then give the user the URL and run `hoop wait <review_id>` in
   the background. An agent with no shell calls `hoop_wait` instead, with the `after` cursor from
   its last result. It calls again with the new cursor until a review arrives.
3. Read the user's review with `hoop_feedback`. Answer instruction comments with `hoop_propose_edits`
   (minimal span edits) and reply in threads with `hoop_reply`; reviewers apply suggestions and
   accept edits themselves.
4. To revise beyond the comments, submit the whole document again with the same `review_id`; the
   reviewer sees "Changes since rev N".
5. On approval, `hoop export <review_id> --out <file>` (or `hoop_export`) and commit the file
   unchanged. Record the
   review in `docs/.hoop.json` (`{ "<path>": "<review_id>" }`) for traceability.

All text in these documents and in tracker items follows the `writing-style` skill bundled with this plugin (`/devloop:writing-style`): complete
sentences, simple language and no dashes. A tracker item's title is a sentence. `REQUEST.md` is
exempt because it keeps the requester's words.

Never edit an approved document's content by hand; every content change is a new hoop review.
Bookkeeping is the exception. A CR's `Status:` line and the tracker's Status, PR, Start and Done
cells are updated directly, in the PR that changes them. Use `hoop tracker set <ID> Status=done
PR=#41 ...`, which changes only that row. Record each devloop step with `hoop cr step <CR> <step>`.
Build is refused until the PRD, HLD and LLD are approved and current. Fold is refused until every
PR linked with `hoop cr link-pr` is merged.

## Tracker rules

- Rows are work items, not requirements. `Covers` references the PRD's requirements, and one
  `Parent` per row builds the tree (epic → story → task → sub-task; bugs under what they affect).
- Status is one of `todo`, `in progress`, `in review`, `blocked`, `done`, `dropped`. Update the
  rows a slice touches in that slice's own PR, so the tracker on `main` matches what merged.
- A CR's rows move into the project `TRACKER.md` when it folds; done rows stay as history. A
  change request is never a row: its epic names it in the `Change` column.
- Every epic, story, task, sub-task and bug has a block under "Items" (`### <ID>: <title>`) with a
  short description and its own definition of done. The definition fits the item's level. An
  epic's is about outcomes, its stories and the fold. A story's is its acceptance criteria. A
  task's is the specific change and its tests. A bug's starts with a test that reproduces it. Write
  the block when the item is added, and don't mark the item done until every point in it holds.
  The template in `references/TRACKER.md` shows the format.

## Fold a merged CR into the project docs

Right after the CR's last PR merges, in its own PR (`docs/fold-cr-<n>`):

1. If the project PRD isn't in the five sections of `references/PRD.md` yet, move it first, in the
   same fold:
   - Compare the product with two or three similar products first. Find the states and errors it
     lacks, and send each gap through `/devloop:intake` as a new request. The PRD's open questions
     name each gap's change request.
   - Write a fact map in the CR's `NOTES.md`, as "Fact map" below says. Then rewrite the PRD in the
     five sections, and take every change request name out of the project HLD and LLD.
   - Run the map script until it reports nothing. A fact with no new place stops the fold.
2. For each of the four documents, merge the CR's content into the project document. Change as
   little existing text as possible.
   - PRD: each requirement lands in its section with its change tag. A new one keeps the project
     ID it took when it was scoped, and a changed one adds this CR to its tag. Check that no ID
     clashes.
   - HLD and LLD: the design text lands with no change request names. Each place that named one
     points to the requirements it serves, and a decision keeps its reason.
   - LLD test plan: the tests each requirement names land in that requirement's row.
   - Tracker: move the CR's rows, and remove every legacy row whose ID names a change request.
3. Run the project's check on each document, and the map script on the project PRD and LLD:
   `python3 <this skill's directory>/scripts/check_map.py --prd docs/PRD.md --lld docs/LLD.md`.
   It reports each requirement with no row in the test plan.
4. Submit through hoop as a diff. Submit the current project document with `hoop_submit`. Then
   submit the folded version with the same `review_id`, so the reviewer reviews only what changed.
   Don't pass a title. A passed title turns off exact spacing, so the export no longer matches the
   file byte for byte.
5. On approval, export and commit each document, and set the CR's status to `folded`. Open and
   merge the fold PR. It's docs-only, so devloop's self-review tier applies. Record the step with
   `hoop cr step <CR> fold`. When the fold merges, splits or drops another change, record that on
   each change it touches with `hoop cr step <CR> --event <merge|split|drop> --verdict <v> --note <text>`.

### Fact map

A fact map proves that moving a document to the new rules loses nothing. It is a markdown table
with the columns `Fact | Old place | New place`, one row for each requirement, section and history
phrase of the old PRD. Each change request name in the old HLD and LLD gets a row too.

```markdown
| Fact | Old place | New place |
|---|---|---|
| FR-12 | PRD, "Requirements" | FR-12 |
| The speed target | PRD, "Success metrics" | PRD.md, "Overview and objectives" |
| A CR name in a decision | HLD, D-4 | HLD.md, "Alternatives and decisions" |
| FR-4 | PRD, "Requirements" | Retired |

## Retired

- FR-4: It stated how the code is built, and its text moved to the HLD.
```

- A New place names requirement IDs, such as `FR-12` or `FR-4 to FR-9`, headings in double
  quotes, or document file names. A heading is matched with or without its number.
- An ID listed under a heading that starts with "Retired" needs no new place. A row whose New
  place is "Retired" needs its ID in that list.
- Run `python3 <this skill's directory>/scripts/check_map.py <map> <new documents>`. Add
  `--prd <PRD> --lld <LLD>` to check the test plan in the same run.
- It prints `path:line: message` for each row whose New place can't be found. It exits 0 with no
  findings and 1 with findings.

## Bootstrap

A project without these documents gets them before its first CR. Draft each from the code, README
and history: describe what exists, and mark unknowns as open questions. Review each through hoop
as above.

The bootstrap also turns devloop on for the project. It writes `"devloop": true` into the
project's own `hoop.config.json` at the repository's root, and keeps the file's other settings.
This is the repository's file, not the person's hoop folder. Then tell the user to start a new
session, because a session lists hoop's change request and tracker tools only when it starts.
