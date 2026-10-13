# CR-8: tracker

This tracker lists CR-8's work items. Requirements stay in `PRD.md`, and the Covers column points to
them. The table is the index, and each item's description and definition of done are in its block
under "Items".

| ID | Parent | Type | Title | Covers | Status | Phase | Depends on | PR | Size | Start | Done |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CR-8 | | epic | Remove duplicated code from hoop and make it easier to read. | | in progress | plan | | | | 2026-10-13 | |
| ST-1 | CR-8 | story | As a maintainer, I change a rule in one place and every caller follows. | FR-1, FR-2, FR-3, FR-4, NFR-1 | todo | | | | | | |
| T-1 | ST-1 | task | Move the review rules and the thread lookup into one module, with one update mark and one slug rule. | FR-1, FR-2, FR-4 | todo | | | | ~7 files, ~250 lines | | |
| T-2 | ST-1 | task | Move the work of turning comments into edits out of the core into its own module. | FR-3 | todo | | T-1 | | ~3 files, ~400 lines | | |
| ST-2 | CR-8 | story | As a maintainer, I write a new page action or test without copying setup code. | FR-5, FR-6, NFR-1 | todo | | | | | | |
| T-3 | ST-2 | task | Give the review page one helper for requests and one for notices. | FR-5 | todo | | | | ~2 files, ~60 lines | | |
| T-4 | ST-2 | task | Share the server, browser and tool-call setup across the tests and scripts. | FR-6 | todo | | | | ~8 files, ~250 lines | | |
| ST-3 | CR-8 | story | As a maintainer, I can trust the shape of every GitHub response hoop reads. | FR-7, NFR-1 | todo | | | | | | |
| T-5 | ST-3 | task | Check every GitHub response against a schema instead of casting it. | FR-7 | todo | | | | ~2 files, ~150 lines | | |
| T-6 | CR-8 | task | Show that nothing changed for agents, reviewers or the terminal. | NFR-1, NFR-2 | todo | | T-1 to T-5 | | ~1 file, ~60 lines | | |

Types are epic, story, task, sub-task and bug. Status is todo, in progress, in review, blocked,
done or dropped. The order is T-1, T-2, T-3, T-4, T-5 and then T-6, each as its own pull request
of at most 10 files and 500 lines.

## Items

### CR-8: Remove duplicated code from hoop and make it easier to read.

Every rule and repeated step in hoop is written once, and the core only coordinates. Nothing
changes for agents, reviewers or the terminal. The queued changes after it get smaller because
they edit cleaner code.

Definition of done:
- Every story under it is done.
- Every success metric in the PRD meets its target, measured with the same searches.
- The acceptance check in T-6 passes on `main`.
- Its PRD, HLD and LLD are folded into the project documents.

### ST-1: As a maintainer, I change a rule in one place and every caller follows.

A person or an agent who changes how a review behaves finds each rule in one module. The core is
short enough to read in one sitting.

Definition of done:
- The open-review rule, the GitHub-review refusal and the thread lookup each appear once in the code.
- The core module has 250 lines or fewer.
- The store marks a review as updated in one way, and hoop has one slug rule.
- T-1 and T-2 are merged, and every existing test passes unchanged.

### T-1: Move the review rules and the thread lookup into one module, with one update mark and one slug rule.

The new `src/rules.ts` holds `editable`, `thread` and `existing`. The core, the store, the markdown
parser and the change registry use them, together with `store.touch` and `util.slugify`.

Definition of done:
- One pull request makes the change, as the LLD describes.
- New unit tests cover `editable`, `thread` and both slug limits.
- Every existing test passes without changes to what it asserts.
- The fresh review's findings are resolved.

### T-2: Move the work of turning comments into edits out of the core into its own module.

The new `src/materialize.ts` holds apply, propose, decide, edit positions and rebasing. The core
keeps methods with the same names, and each one calls the materializer.

Definition of done:
- One pull request moves the code without changing its logic.
- The core module has 250 lines or fewer.
- The propose, revision and browser tests pass unchanged.
- The fresh review's findings are resolved.

### ST-2: As a maintainer, I write a new page action or test without copying setup code.

The review page has one way to send a request and one way to show a notice. Tests and scripts get
their server, browser and tool client from one shared setup.

Definition of done:
- The review page defines its request helper and its notice helper once each.
- The test setup and the script setup are each defined once.
- T-3 and T-4 are merged, and every browser test and acceptance script passes.

### T-3: Give the review page one helper for requests and one for notices.

`post` and `flash` go into `web/app.js`. The review page uses them for apply, accept, reject and
submit.

Definition of done:
- One pull request adds the helpers and replaces the three copies of each.
- The browser tests for apply, accept, reject and submit pass unchanged.
- The fresh review's findings are resolved.

### T-4: Share the server, browser and tool-call setup across the tests and scripts.

`withBrowser` goes into `test/helpers.ts`, and `scripts/lib.ts` holds the tool-call, step and
wait helpers. The browser tests and the acceptance scripts use them.

Definition of done:
- One pull request adds the shared setup and moves every copy to it.
- Each test keeps its own steps and assertions.
- Every browser test and every acceptance script passes.
- The fresh review's findings are resolved.

### ST-3: As a maintainer, I can trust the shape of every GitHub response hoop reads.

A GitHub response that doesn't have the fields hoop needs fails at once, with a message that
names the endpoint and the field.

Definition of done:
- The GitHub module has no unchecked casts on responses.
- T-5 is merged, and the GitHub tests pass.

### T-5: Check every GitHub response against a schema instead of casting it.

Each endpoint that hoop reads gets a zod schema for the fields it uses, and the request helper
parses the response with it.

Definition of done:
- One pull request adds the schemas and removes the unchecked cast.
- The GitHub tests with the fake `gh` pass unchanged.
- A new test shows that a malformed response names its endpoint and field.
- The fresh review's findings are resolved.

### T-6: Show that nothing changed for agents, reviewers or the terminal.

A check compares the agent tool list, the tool schemas and the `hoop help` output with a snapshot
taken before CR-8. The full suites and the acceptance scripts run once more.

Definition of done:
- The snapshot of tools, schemas and commands matches the output from before CR-8.
- The full suite passes on Node 18 and on Node 22, browser tests included.
- Every acceptance script passes.
- The tracker shows every task with its pull request and size.
