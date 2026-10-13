# hoop

Humans in the loop: review an agent's decisions (requirements, PR slicing, plans) the way you
review code. Claude submits a decision as a JSON document over MCP, you comment on lines or
selected text, suggest changes and answer questions, and Claude reads your review back as
structured feedback. Work starts when you approve.

Requirements and design: [`docs/PRD.md`](docs/PRD.md).

## Contract

A review document (`hoop/review@0`) has a `slug`, `title`, `tldr` and `items`. Each item has an
`id` (`FR-1`, `Q-1`), a `type`, a `title`, and optional `body`, `check`, `choices`, `risk` and
`depends_on`. See [`examples/order-export.json`](examples/order-export.json).

An item's commentable lines are its body lines, then its choices (for questions), then its check.
Feedback (`hoop/feedback@0`) points at an item and line, optionally a character `range` within
the line. Line `0` is the item's heading, and a comment there covers the whole section; item `DOC`
line `1` is the title and line `2` the TL;DR, and comments there cover the whole document.

## Use with Claude Code

hoop isn't on npm yet; install it from source (Node 18.18+):

```sh
git clone https://github.com/ankurjain-nitrr/hoop && cd hoop
npm install && npm link          # builds dist/ and puts `hoop` on your PATH
claude mcp add hoop -- hoop mcp
```

| Tool | Does |
|---|---|
| `hoop_submit` | Stores a review document and returns its `review_id` and URL. Include `review_id` to submit a new revision. |
| `hoop_feedback` | Returns `pending`, or the feedback on the latest revision. |
| `hoop_propose_edits` | Proposes span edits (`find` → `replace`) for a comment thread, as tracked changes the reviewer accepts or rejects. |
| `hoop_reply` | Replies in a reviewer's comment thread. |

`hoop mcp` also serves the review pages on http://localhost:4747 (override with `HOOP_PORT`); the
URL `hoop_submit` returns opens the review. `hoop serve` serves the pages without MCP.

### Waiting without blocking

After `hoop_submit`, Claude runs `hoop wait <review_id>` in the background (Bash with
`run_in_background`). It exits when you submit a review, or right away if the review is already
approved, and prints the same JSON as `hoop_feedback`; Claude is re-invoked with it. Work starts
only on an approved verdict.

### Materializing comments

A suggestion (exact replacement text, on a line or on selected text) has **Apply suggestion** on
the page: it replaces just that span in a new revision and the thread shows "Applied in rev N".
Nothing outside the span changes, character for character. `hoop_feedback` lists what was applied.

For an instruction ("make the bounds inclusive"), Claude calls `hoop_propose_edits` with exact
span replacements. Each `find` must occur once in its line, and edits must stay in the comment's
scope: its line, its section for a heading comment, the whole document for a title or TL;DR
comment. Edits that replace more than half of a line's words are flagged as large rewrites.
On the page each edit shows inline as a tracked change (struck-through and inserted text) with
**Accept** and **Reject**; accepting applies just that span in a new revision. `hoop_feedback`
reports each edit's status as `edits`.

### Revisions and approval

Submit again with the same `review_id` for a new revision: the page gets a "Changes since rev N"
tab, and comments whose line changed are marked outdated. Approving freezes the review and writes
`decisions/<slug>.json` and `decisions/<slug>.md` into the repo it was submitted from (override
with `HOOP_REPO_DIR`) for Claude to commit; `hoop_feedback` lists them as `decision_files`.
Submitting against an approved review starts a new review that `supersedes` it.

### Team decisions on GitHub

With `"channel": "github"`, `hoop_submit` opens a PR in the repo Claude is working in (using your
`gh` login): branch `hoop/<slug>` with `decisions/<slug>.json` and the rendered
`decisions/<slug>.md`, and a description with the TL;DR and one checkbox per question option.
Teammates review the `.md` like code: line comments, suggestions, replies, ticked checkboxes.
`hoop_feedback` reads them back into the same feedback document, `hoop_reply` answers in a thread,
and a new revision is a new commit on the same PR. **Merging the PR approves the decision**
(GitHub enforces any required reviewers first); `hoop wait` polls the PR every 15 s.

Reviews are stored as JSON files in `~/.hoop/reviews/<id>/` (override with `HOOP_HOME`).

## Develop

Requires Node 18.18 or newer.

```sh
npm install
npm test
npm run typecheck
```

End-to-end runs (Node 20+):

```sh
npm run e2e:local                                   # hoop mcp + review page in Chrome + hoop wait + approval
HOOP_E2E_REPO=owner/name npm run e2e:github         # real decision PR: review, reply, revision, merge
```

`e2e:github` leaves a merged decision PR in the repo you point it at; use a sandbox repo.

`test/ui.test.ts` drives the review page in Chrome (Playwright). It needs Node 20+ and Chrome
(`HOOP_CHROME` to point at another Chromium) and is skipped otherwise.
