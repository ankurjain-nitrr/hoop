# CR-8: LLD

Status: approved · Revision: 1 · PRD: approved (revision 1) · HLD: approved (revision 1)

This document says how each component in the HLD is built. Every message, audit event, file
format, tool schema and command stays exactly as it is.

## Review rules (`src/rules.ts`, new)

- `editable(store, id, opts)` returns the review's metadata, or throws the same `HoopError` as
  today. `opts.open` refuses a review that isn't open with "review <id> is <status>". `opts.github`
  holds the text to use when the review is on GitHub, because the three callers word it
  differently today. `opts.frozen` refuses an approved review with "review <id> is approved and
  frozen", as the reviewer's submit does today.
- `thread(store, id, threadId)` returns the thread's first comment, the revision it was made on,
  and every entry in the thread with its revision, or `undefined`. The local review, the apply,
  the propose and the decide paths all use it.
- `existing(store, id)` moves here from the core, with its "no review <id>" message.

## Materializer (`src/materialize.ts`, new)

- A `Materializer` class takes the store. It holds `applySuggestion`, `proposeEdits`,
  `decideEdit`, `editPosition` and the private `rebaseProposals`, moved from the core without
  changing their logic.
- The core keeps methods with the same names and signatures, and each one calls the materializer.
  So the agent tools, the commands and the local API don't change.
- After the move, the core holds submit, refresh, feedback, review, decisions and replies. It
  should be about 230 lines, under the PRD's target of 250.

## Store (`src/store.ts`, changed)

- `touch(id)` marks a review as updated. It replaces the four calls of `update(id, {})`.

## Slugs (`src/util.ts`, changed)

- `slugify(text, { max, fallback })` replaces the copies in the markdown parser (60 characters,
  fallback "document") and the change registry (40 characters, fallback "change"). Each caller
  passes its own limits, so no slug changes.

## Page helpers (`web/app.js`, changed; `web/review.js`, changed)

- `post(path, body)` sends a JSON POST with the content-type header and returns the parsed reply.
  It replaces the three copies in the review page.
- `flash(message)` sets the notice, renders it and removes it after six seconds. It replaces the
  three copies of that timer.

## Shared test setup (`test/helpers.ts`, changed; `scripts/lib.ts`, new)

- `withBrowser(fn)` starts a web server on a free port with a fresh store, and launches Chrome.
  It passes the base URL, the page and the hoop instance to the test, and closes both afterwards. The
  two browser test files use it, and each keeps its own steps and assertions.
- `scripts/lib.ts` holds the MCP tool-call helper, the step printer and the `hoop wait` helper
  that the three acceptance scripts copy today.

## GitHub responses (`src/github.ts`, changed)

- Each `gh api` endpoint that hoop reads has a zod schema for the fields hoop uses. The endpoints
  are the pull request, its reviews, its review comments, git refs and the resolved-thread query.
- `api(method, path, schema)` parses the response with the schema instead of casting it. A
  response that doesn't match throws an error that names the endpoint and the field.
- The PRD's baseline of 8 casts came from a text search that also matched comments and
  `as const`. The real count is one unchecked cast, `JSON.parse(out) as T`, which every response
  goes through. The target of zero stays.

## Errors

- No new refusals reach the agent or the reviewer. The only new error is a GitHub response that
  doesn't match its schema, which today would fail later with a less clear message.

## Test plan

| Requirement | Test | Level |
|---|---|---|
| FR-1, FR-2 | The existing tests for apply, propose, decide and the local review pass unchanged. New unit tests cover `editable` and `thread`. | unit |
| FR-3 | The existing propose, revision and browser tests pass unchanged. The core's line count is checked. | unit, browser |
| FR-4 | The existing store and change tests pass. A unit test checks both slug limits. | unit |
| FR-5 | The existing browser tests for apply, accept, reject and submit pass unchanged. | browser |
| FR-6 | Every browser test and acceptance script passes through the shared setup. | browser, acceptance |
| FR-7 | The GitHub tests with the fake `gh` pass. A new test checks that a malformed response names its field. | unit |
| NFR-1 | The full suite on Node 18 and Node 22 and every acceptance script pass. The MCP tool list and `hoop help` match the output from before CR-8. | all |
