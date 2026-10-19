# hoop

Humans in the loop: review what an agent writes the way you review code. Decisions,
requirements and plans, or any document (a policy, an essay, a proposal, a letter): Claude submits
it over MCP, you comment on lines or selected text, suggest changes and answer questions, and
Claude reads your review back as structured data. Comments can be **materialized**: applied as
edits to the document itself, changing as few words as possible. Work continues when you approve.

Requirements, design and status: [`docs/PRD.md`](docs/PRD.md), [`docs/HLD.md`](docs/HLD.md),
[`docs/LLD.md`](docs/LLD.md), [`docs/TRACKER.md`](docs/TRACKER.md).

## Any document

`hoop_submit_markdown` takes any markdown: the first `#` heading is the title, other headings start
sections, and each paragraph or list item is a line you can comment on. `hoop_export` returns the
latest revision as clean markdown with every applied change in place, and approving writes that
clean markdown to `decisions/<slug>.md`.

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
| `hoop_submit` | Stores a review document and returns its `review_id` and URL. Include `review_id` to submit a new revision, and `change` to link it to a change request (see below). |
| `hoop_feedback` | Returns `pending`, or the feedback on the latest revision. |
| `hoop_propose_edits` | Proposes span edits (`find` → `replace`) for a comment thread, as tracked changes the reviewer accepts or rejects. |
| `hoop_reply` | Replies in a reviewer's comment thread. |
| `hoop_cr_create`, `hoop_cr_classify`, `hoop_cr_step`, `hoop_cr_get`, `hoop_cr_link_pr` | Capture a change request as written, classify it, move it through its steps, show it, link its PRs. |
| `hoop_tracker_get`, `hoop_tracker_set` | Read the tracker as a tree; change one item's cells. |

Every tool is also a terminal command, for sessions without MCP. Run `hoop help` for the full list.
Commands print readable text, or JSON with `--json`, and exit 1 with the same message the tool
would return:

```sh
hoop cr create --type story --reason "one capability" < request.txt
hoop submit docs/changes/CR-1-x/PRD.md --cr CR-1 --doc prd
hoop feedback <review_id>
hoop cr step CR-1 build
hoop tracker set T-1 Status=done PR=#41
hoop export <review_id> --out PRD.md
```

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

### Changes, design documents in order, and the tracker

A change request lives in `docs/changes/CR-<n>-<slug>/`: `REQUEST.md` holds the request exactly as
given, and `change.json` holds its type, step history, linked reviews and pull requests. Submitting
with `change: { cr: "CR-3", doc: "hld" }` links a review to its change. hoop refuses an HLD
review until the change's PRD is approved, and an LLD review until the HLD is. When an earlier
document is revised and approved again, the later ones need approval again before the change can
move to build.

Each change keeps its row in `docs/TRACKER.md` up to date. http://localhost:4747/tracker shows that
tracker, or any change's `TRACKER.md`, as a tree you can expand, collapse and filter by type and
status. A tracker under review shows as the same tree, and each row takes comments.

### Audit log and improvement loop

Every submit, review, applied suggestion, proposed and decided edit and reply is appended to
`~/.hoop/audit.jsonl`, along with every failed tool call or reviewer action and its reasons
(`HOOP_AUDIT=0` turns logging off). `hoop audit [--since <days>] [--json]` summarizes it: time to
first verdict, revisions per review, how many of Claude's edits were accepted, large rewrites, and
the most common failures. Use it when improving hoop: frequent failures point at tool descriptions
or rules to sharpen; low acceptance or many large rewrites point at how edits are proposed.

Reviews are stored as JSON files in `~/.hoop/reviews/<id>/` (override with `HOOP_HOME`).

## devloop

The devloop plugin is the development loop that runs on hoop. It lives in this repository under
`plugins/devloop/`. The two are coupled: every devloop document review and approval goes through
hoop, so devloop isn't published on its own. This repository is also its Claude Code marketplace.

```sh
claude plugin marketplace add ankurjain-nitrr/hoop
claude plugin install devloop@hoop
```

A project can enable it in `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": { "hoop": { "source": { "source": "github", "repo": "ankurjain-nitrr/hoop" } } },
  "enabledPlugins": { "devloop@hoop": true }
}
```

| Skill or agent | What it does |
|---|---|
| `/devloop:devloop` | It runs a change from request to a merged milestone. The steps are intake, scope, design documents, a plan, small pull requests, reviews, acceptance and fold. |
| `/devloop:intake` | It captures a request in the requester's words, classifies it, queues it and resolves overlaps. |
| `/devloop:scope` | It scopes and freezes a queued change's requirements with the requester. |
| `/devloop:project-docs` | It keeps the project's and each change's PRD, HLD, LLD and tracker current through hoop. |
| `/devloop:prd-review`, `/devloop:hld-review`, `/devloop:lld-review` | They hold each design document's standards, owner and reviewers, and its checks. |
| `/devloop:slice` | It splits a change into small pull requests that each deliver working behavior. |
| `/devloop:pr-review` | It gets each pull request reviewed by fresh reviewers before the next one builds on it. |
| `/devloop:code-docs` | It keeps comments and docs in code about the code as it is now. |
| `/devloop:readme-check` | It is a gate before every push that keeps a README's claims true. |
| `/devloop:writing-style` | It holds the writing rules and their checker. |
| `/devloop:principles` | It holds the working principles that every choice and review is weighed against. |
| `/devloop:review-comments` | It says how to write and answer review comments, and who decides. |
| Persona agents | Six persona agents own or review the design documents in hoop. They are two product managers, a staff, a principal and a senior engineer, and an L4 engineer. |

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
npm run e2e:docs                                    # a policy doc: apply a suggestion, accept Claude's edits, export
HOOP_E2E_REPO=owner/name npm run e2e:github         # real decision PR: review, reply, revision, merge
```

`e2e:github` leaves a merged decision PR in the repo you point it at; use a sandbox repo.

`test/ui.test.ts` drives the review page in Chrome (Playwright). It needs Node 20+ and Chrome
(`HOOP_CHROME` to point at another Chromium) and is skipped otherwise.
