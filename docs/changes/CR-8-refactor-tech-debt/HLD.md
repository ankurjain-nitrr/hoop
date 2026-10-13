# CR-8: HLD

Status: approved · Revision: 1 · PRD: approved (revision 1)

This document covers components and how they interact. The code-level design goes in the LLD,
which is written after this is approved.

## Context

Nothing changes for the people and systems around hoop. The agent still reaches hoop through its
tools or its commands, the reviewer still uses the review page, and GitHub still holds team
reviews. The change is inside hoop: some work moves between components, and repeated logic moves
into the component that owns it.

```
agent ── tools / commands ──▶ core ──┬──▶ review rules ──▶ store
                                     ├──▶ materializer ──▶ edit engine
                                     └──▶ GitHub channel ──▶ GitHub
reviewer ── browser ──▶ review page ──▶ page helpers ──▶ local API ──▶ core
tests and acceptance scripts ──▶ shared test setup ──▶ hoop
```

## Components

| Component | Responsibility | Talks to (how) |
|---|---|---|
| Core (changed) | It receives every operation and decides which component does the work. | It calls the review rules, the materializer, the GitHub channel and the store in process. |
| Review rules (new) | It answers whether a review can be changed, and finds a comment thread with its first comment. | It reads the store in process. |
| Materializer (new) | It turns accepted suggestions and proposed edits into new revisions. | It calls the review rules, the edit engine and the store in process. |
| Store (changed) | It keeps reviews as files and marks a review as updated in one way. | It reads and writes files on this machine. |
| GitHub channel (changed) | It reads GitHub responses through declared shapes. | It calls GitHub through the `gh` command. |
| Page helpers (new) | They send the review page's requests and show its notices. | They call the local API over HTTP. |
| Shared test setup (new) | It starts servers, browsers and tool clients for tests and scripts. | It runs hoop as a process or in process. |

## Key interactions

### A reviewer applies a suggestion

1. The review page asks the local API to apply a suggestion, through the page helpers.
2. The core asks the review rules whether the review can be changed and where the thread is.
3. The review rules refuse a closed review or a GitHub review, or return the thread.
4. The core hands the thread to the materializer, which writes the new revision through the store.
5. The page helpers show the result as a notice.

Failure: when the review rules refuse, the same message as today reaches the page.

### An agent proposes edits for a comment

1. The agent calls the propose tool, and the core asks the review rules for the thread.
2. The materializer checks the edits against the thread's scope and stores them as proposals.

Failure: invalid edits come back with the same field errors as today.

### A test or acceptance script runs

1. The test asks the shared setup for a server, a browser or a tool client.
2. The shared setup starts it, runs the test's steps, and stops it afterwards.

Failure: a setup error fails the test with its message, as today.

## Cross-cutting concerns

- Security and trust boundaries: the local API keeps its Host, Origin and content-type checks
  unchanged. Comment text is still treated as data.
- Privacy: nothing new leaves the machine.
- Observability: every audit event keeps its name and fields, so `hoop audit` reports the same.
- Testing strategy: the existing tests are the check. They must pass without changes to what they
  assert, before and after each refactor.
- Deployment and operation: hoop installs and runs the same way. No stored file changes format.

## Alternatives considered

- Do nothing: every queued change would edit the same repeated code, and copies would keep
  drifting apart.
- Rewrite the core from scratch: it would risk behavior changes that the PRD rules out.
- Split the core into many small parts: more parts would be harder to follow than two clear ones.

## Decisions

- D-1 (2026-10-13): The core stays the single entry point and only coordinates. Context: callers
  already depend on it. Consequences: the agent tools, commands and page call it as before.
- D-2 (2026-10-13): The review rules own every check that a review can be changed. Context: three
  copies exist today. Consequences: a new rule is added in one place.
- D-3 (2026-10-13): Each refactor lands on its own, with the full test suite passing before the
  next starts. Context: the PRD holds behavior fixed. Consequences: a failing test stops the work.

## Requirements traceability

| Requirement | Components |
|---|---|
| FR-1, FR-2 | Review rules, core |
| FR-3 | Materializer, core |
| FR-4 | Store |
| FR-5 | Page helpers |
| FR-6 | Shared test setup |
| FR-7 | GitHub channel |
| NFR-1, NFR-2 | All components |

## Risks

- A moved rule could change a message or the order of checks. The tests compare messages, and
  the acceptance scripts run end to end after each refactor.
- The shared test setup could hide a difference between tests. Each test keeps its own steps and
  assertions, and only the setup moves.
