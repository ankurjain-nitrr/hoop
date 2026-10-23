# hoop

Humans in the loop: review what an agent writes the way you review code.

An agent such as Claude submits a document to hoop: a plan, a set of requirements, a decision, a
policy, an essay or a letter. You read it on a local page, comment on lines or selected words,
suggest changes and answer questions. The agent reads your review back as data, revises, and goes
on only after you approve. Comments can be **materialized**: turned into edits to the document
that change as few words as possible.

> **Status: before 1.0.** Some surfaces may still change. See [Stability](#stability).

Requirements, design and status: [`docs/PRD.md`](docs/PRD.md), [`docs/HLD.md`](docs/HLD.md),
[`docs/LLD.md`](docs/LLD.md).

## Install

You need Node 18.18 or later. The package isn't on npm yet, so install it from source:

```sh
git clone https://github.com/ankurjain-nitrr/hoop && cd hoop
npm install && npm link          # builds dist/ and puts `hoop` on your PATH
claude mcp add hoop -- hoop mcp
```

Claude Code now has hoop's tools. Start Claude Code in your project folder, since hoop treats the
folder it starts in as the repository. To use another agent, see
[Setup for other agents](#setup-for-other-agents).

### Review plans before Claude Code acts (optional)

The hoop-plan plugin reviews each plan in hoop before Claude Code leaves plan mode. A hook runs
before `ExitPlanMode` and opens the plan as a review. The agent goes on only after your final
approval, and gets your comments otherwise. If the review ends without a verdict, the agent stops
and is told the review's link. The hook fails closed: when `hoop` is missing, crashes or gives no
decision, the agent stops too. It needs `hoop` and `perl` on your PATH.

```sh
claude plugin marketplace add ankurjain-nitrr/hoop
claude plugin install hoop-plan@hoop
```

### Remove

```sh
claude mcp remove hoop                 # Claude Code no longer starts hoop
claude plugin uninstall hoop-plan@hoop # if you installed the plan hook
claude plugin uninstall devloop@hoop   # if you installed devloop
npm rm -g hoop                         # removes the `hoop` command that npm link added
rm -rf ~/.hoop                         # deletes every stored review, the audit log and your settings
```

The background pages process stops by itself after an hour with no session and no open page.

## A review, from the reviewer's side

1. The agent submits a document and gives you a link, such as
   `http://localhost:4747/r/<review_id>`. Open it.
2. Read the document. Its outline on the side is a tree of its sections, which you can expand and
   collapse. Tables show as tables, and Mermaid diagrams are drawn.
3. Comment on a line, or select words and comment on just those. A comment on a heading covers its
   whole section. A comment on the title or the TL;DR covers the whole document.
4. Suggest an exact change. You can select words and delete them in one action, or edit a line in
   place. Each becomes a suggestion with **Apply**, which changes only that text in a new revision.
5. Answer the document's questions by picking an option.
6. Submit your review with a verdict: comment, request changes or approve. Requesting changes and
   approving need a GitHub sign-in; a comment doesn't.
7. The agent reads your review and answers. It may reply in your threads, revise the document, or
   propose edits that show as tracked changes with **Accept** and **Reject**. A new revision shows
   what changed since the last one, and marks comments whose line changed as outdated.
8. When the document is right, approve it. The first time, the page asks you to sign in with
   GitHub: it shows a code, and you confirm it on GitHub. The sign-in lasts eight hours in that
   browser. Approving freezes the review.

Each review page also shows its audit trail: every comment, request for changes and approval, with
who and when.

## Glossary

| Term | Meaning |
|---|---|
| Review | One document under review, with all its revisions, comments and verdicts. It has a review ID. |
| Revision | One version of a review's document. Each new submit with the same review ID adds a revision. |
| Item | One part of a document, such as a requirement or a section. Each has an ID, such as `FR-3`. |
| Item types | What an item is: `requirement`, `slice`, `step`, `question`, `option`, `note` or `section`. A markdown document's sections are `section` items. |
| TL;DR | One or two sentences at the top that tell the reviewer what the document is about. In a markdown document it defaults to the first paragraph. |
| Check | On an item: how a test or a reviewer checks it. |
| Risk | The agent's estimate of an item's risk: `low`, `medium` or `high`. |
| Depends on | The IDs of the items that an item needs first. |
| Thread | A comment and its replies. Each has a thread ID that names its review. |
| Verdict | What a review says overall: `comment`, `changes_requested` or `approved`. |
| Materialize | Turn a comment into edits to the document itself. A reviewer applies an exact suggestion, or accepts an edit the agent proposed. Text outside the edited words stays the same. |
| Approval | An approve from a signed-in person on the page. It freezes the review. |
| Supersedes | A submit against an approved review starts a new review that supersedes the old one. The old review's feedback names the new one in `superseded_by`. |

## Use

### Which submit to use

- `hoop_submit` (`hoop submit <file.md>`) takes any markdown. The first `#` heading is the title,
  other headings start sections, and each paragraph or list item is a line to comment on.
- `hoop_submit_decision` (`hoop submit-decision <file.json>`) takes a structured decision document
  in the `hoop/review@0` format, with requirements, options and questions. See
  [`examples/order-export.json`](examples/order-export.json).

Each submit result says its `outcome`: `created`, `revised` or `superseded`. It names
`next_review_id`, the review to use next, and carries a `cursor` for waiting.

### Waiting for a review

An agent waits for your review in one of two ways:

- `hoop_wait` holds for up to 45 seconds. Pass `after`, the `cursor` from the last submit, feedback
  or wait result, so a review that came in since returns at once. When none comes in time, it
  returns `status: "pending"` with `again: true`, and the agent calls it again. This works for an
  agent with no shell.
- `hoop wait <review_id>` runs in the background until a review arrives, or until its `--timeout`.
  It prints the same JSON as `hoop_feedback`. It exits 0 on a review and 3 on a timeout.

Work goes on only after an approved verdict.

### Comments and edits

A comment points at an item and a line. It may also name the exact words it covers. On the page
that is a `range`, and an agent may send `words` in place of a line. Feedback shows each comment's
`scope`: its line, its section with every section nested in it, or the whole document.

Some comments ask for a change in words, such as making a range inclusive. For those, the agent
calls `hoop_propose_edits` with span edits. Each edit replaces one exact `find` with `replace`. An
edit may leave out `item` and `line`. Then `find` picks the one line in the comment's scope where it
occurs. An edit that breaks one of fourteen rules is refused, and each refusal names the rule. For
example, `find` must occur exactly once in its line, and an edit never removes a whole line. An
edit applies only while its line reads exactly as when it was proposed. Edits that replace more
than half of a line's words are flagged as large rewrites.

### Revisions and approval

Submit again with the same review ID to add a revision. The page then shows "Changes since rev N".
A renamed section keeps its comments when it stays at the same level, under the same parent and in
the same place.

Approving or requesting changes needs the person's GitHub sign-in in that browser. Without it, the
server refuses the verdict with "Sign in with GitHub to approve" (or "to request changes"). A
comment needs no sign-in, so an agent can comment through the same API. The approval freezes the
review, and hoop writes nothing into the repository. An approval can carry notes, which its feedback
keeps.

You control the sign-in in your own `~/.hoop/config.json`. No repository can change it.

```json
{ "signin": false }
```

With `"signin": false`, approving and requesting changes work without GitHub. To use your own GitHub OAuth App for the sign-in, set
`"github_client_id": "<client id>"`. The sign-in asks GitHub only for your login, and stores no token. If
the page says the sign-in isn't set up, set one of these two. See [`SECURITY.md`](SECURITY.md).

### The pages

All pages run on `http://localhost:4747` (set `HOOP_PORT` to change it). Every page shares one
frame that names the repository.

- `/` lists the reviews by status, and filters them by project.
- `/r/<review_id>` shows one review.

Mermaid diagrams draw in a sandboxed frame from a copy of Mermaid that ships with hoop. A diagram
can't run script in the page or load anything from another host.

### Two sessions or two repositories

One background pages process serves every session on the machine. A session or command starts it
when nothing answers on the port, and no session owns it. Each page names its repository, so
reviews from two repositories stay apart. When another program holds the port, hoop doesn't start
the pages, and the result carries `pages` with a message that says why. After you update hoop, the
pages process restarts into the new code within a few seconds. `hoop serve` serves the pages in
the foreground instead, and doesn't restart itself.

### Audit log

Every submit, review, applied suggestion, proposed and decided edit, reply and failed call goes
into `~/.hoop/audit.jsonl` (`HOOP_AUDIT=0` turns it off). `hoop audit [--since <days>] [--json]`
summarizes it: the time to first verdict, revisions per review, how the agent's edits fare, and
the most common failures.

## devloop

The devloop plugin is a development loop that runs on hoop. It takes a change from request to
merged pull requests, with its design documents reviewed in hoop. It lives in this repository under
`plugins/devloop/`, and this repository is its Claude Code marketplace.

```sh
claude plugin marketplace add ankurjain-nitrr/hoop
claude plugin install devloop@hoop
```

To update it later, run `claude plugin marketplace update hoop` and then
`claude plugin update devloop@hoop`. A project can enable it in `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": { "hoop": { "source": { "source": "github", "repo": "ankurjain-nitrr/hoop" } } },
  "enabledPlugins": { "devloop@hoop": true }
}
```

### Skills and agents

| Skill or agent | What it does |
|---|---|
| `/devloop:devloop` | Runs a change from request to a merged milestone: intake, scope, design documents, a plan, small pull requests, reviews, acceptance and fold. |
| `/devloop:intake` | Captures a request in the requester's words, classifies it, queues it and resolves overlaps. |
| `/devloop:scope` | Scopes and freezes a queued change's requirements with the requester. |
| `/devloop:project-docs` | Keeps a project's design documents current through hoop. |
| `/devloop:prd-review`, `/devloop:hld-review`, `/devloop:lld-review` | Hold each design document's standards, owner, reviewers and checks. |
| `/devloop:slice` | Splits a change into small pull requests that each deliver working behavior. |
| `/devloop:pr-review` | Gets each pull request reviewed by fresh reviewers before the next one builds on it. |
| `/devloop:code-docs` | Keeps comments and docs in code about the code as it is now. |
| `/devloop:readme-check` | A gate before every push that keeps a README's claims true. |
| `/devloop:oss-practices` | Checks a repository for the practices an open source project keeps. |
| `/devloop:writing-style` | Holds the writing rules and their checker. |
| `/devloop:principles` | Holds the working principles that every choice and review is weighed against. |
| `/devloop:review-comments` | Says how to write and answer review comments, and who decides. |
| Persona agents | Six agents own or review the design documents in hoop: two product managers, a principal, a staff and a senior engineer, and an L4 engineer. |

## Reference

### Tools and commands

Every agent tool has a terminal command, for sessions without MCP. Commands print readable text,
or JSON with `--json`. On failure they exit 1 with the same message the tool would return. Run
`hoop help` for the full list.

| Tool | Command | Does |
|---|---|---|
| `hoop_submit` | `hoop submit <file.md> [--review <id>]` | Submits a markdown document, or a new revision of one. |
| `hoop_submit_decision` | `hoop submit-decision <file.json>` | Submits a `hoop/review@0` decision document. |
| `hoop_feedback` | `hoop feedback <review_id>` | Returns `pending`, or the feedback on the latest revision. |
| `hoop_wait` | `hoop wait <review_id> [--timeout <seconds>]` | The tool holds up to 45 seconds and says to call again. The command runs until a review arrives or its timeout. |
| `hoop_propose_edits` | `hoop propose <review_id> <thread> <edits.json>` | Proposes span edits for a comment, as tracked changes. |
| `hoop_reply` | `hoop reply <thread> <text>` | Replies in a comment thread. |
| `hoop_export` | `hoop export <review_id> [--out <file>]` | Returns the latest revision as clean markdown, with every applied change in place. |

hoop offers eight tools: the seven above, and the old name `hoop_submit_markdown`. The old names
`hoop_submit_markdown` and `hoop submit-json` still work and return a notice with the new name.

Commands with no tool:

- `hoop mcp` starts the MCP server on stdio, and makes sure the pages are served.
- `hoop serve` serves the pages in the foreground.
- `hoop plan-review` is the hook command that the hoop-plan plugin runs.
- `hoop audit [--since <days>] [--json]` summarizes the audit log.

### Formats

A review document uses the `hoop/review@0` format, and a review's feedback uses `hoop/feedback@0`.
Both are published as JSON Schema: [`schemas/review.schema.json`](schemas/review.schema.json) and
[`schemas/feedback.schema.json`](schemas/feedback.schema.json). The tables below come from the same
source.

An item's lines to comment on are its body lines, then its choices for a question, then its check.
Line 0 is the item's heading, and a comment there covers its section. Item `DOC` line 1 is the
title and line 2 the TL;DR, and comments there cover the whole document.

A review document:

<!-- fields:review -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema` | `"hoop/review@0"` | yes | The format and its version. |
| `review_id` | string or null | no | Set to revise an existing review. |
| `revision` | integer | no | Set by hoop: the revision number. |
| `kind` | `requirements`, `slice_map`, `plan`, `questions`, `decision`, `doc` | yes | What the document is; doc for any markdown document. |
| `slug` | string | yes | A short name for the document, such as order-export. |
| `title` | string | yes | The document's title. |
| `tldr` | string | yes | One or two sentences for the reviewer. |
| `context` | object | no | Where the document comes from: a repository, a branch and links. |
| `items` | list of object | yes | The document's items, in order. |
| `asks` | `approve_all`, `per_item`, `choose` | no | What the agent asks the reviewer to do. |
| `tldr_auto` | boolean | no | True when the TL;DR was copied from the first paragraph: edit that paragraph, not the TL;DR. |
| `spacing` | `"exact"` | no | With exact, blank lines around headings are kept in section bodies and exported as they are. |
<!-- /fields:review -->

An item:

<!-- fields:item -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | The item's ID, such as FR-3; unique in the document. |
| `type` | `requirement`, `slice`, `step`, `question`, `option`, `note`, `section` | yes | What the item is. |
| `title` | string | yes | The item's heading. |
| `body` | string | no | The item's text; each non-empty line is one line to comment on. |
| `check` | string | no | How a test or a reviewer checks the item. |
| `choices` | list of object | no | A question's options. |
| `risk` | `low`, `medium`, `high` | no | The agent's estimate of the item's risk. |
| `depends_on` | list of string | no | IDs of items this one needs first. |
| `level` | integer | no | A document section's heading level; 0 for text before the first heading. |
<!-- /fields:item -->

Feedback:

<!-- fields:feedback -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema` | `"hoop/feedback@0"` | yes | The format and its version. |
| `review_id` | string | yes | The review this feedback is on. |
| `revision` | integer | yes | The revision it was given on. |
| `verdict` | `comment`, `approved`, `changes_requested` | yes | The reviewer's verdict; approving or requesting changes on the page needs a GitHub sign-in. |
| `summary` | string | no | An overall comment, or an approval's notes. |
| `comments` | list of object | no | Comments and replies. |
| `answers` | list of object | no | Answers to questions: each question's ID and the chosen option, or the reviewer's own words. |
| `resolved_threads` | list of string | no | Threads this feedback resolves. |
| `viewed` | list of string | no | Items the reviewer marked as viewed. |
| `reviewer` | string | yes | Who gave it, as they named themselves. |
| `at` | string | yes | When, as an ISO 8601 time. |
| `signed_in` | object | no | The person's GitHub login, when the verdict came with their sign-in in the browser. |
<!-- /fields:feedback -->

A comment:

<!-- fields:comment -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `thread` | string | no | The thread a reply belongs to; leave out for a new comment. |
| `item` | string | yes | The item's ID, or DOC for the title and TL;DR. |
| `line` | integer | yes | The line, from 1; 0 is the item's heading, and DOC line 1 is the title and 2 the TL;DR. |
| `range` | object | no | The words the comment is about, inside the line. |
| `body` | string | no | The comment's text. |
| `suggestion` | string | no | Replacement text for the range, or for the whole line. |
<!-- /fields:comment -->

### Side effects

Here is everything hoop writes or starts:

- Every submit and review is stored in `~/.hoop/reviews/<id>/`.
- Every action is appended to `~/.hoop/audit.jsonl`, unless `HOOP_AUDIT=0` is set.
- The hoop-plan hook keeps each session's plan review in `~/.hoop/plans/<session>.json`.
- Each running session keeps a record in `~/.hoop/sessions/` while it runs.
- hoop writes nothing into your repositories.
- A session or command starts the background pages process on `127.0.0.1:4747` when nothing
  answers there.

Four settings come from the environment. `HOOP_HOME` moves `~/.hoop`. `HOOP_REPO_DIR` sets the
repository a review comes from, which is the current folder by default. `HOOP_PORT` sets the port, and `HOOP_AUDIT=0`
turns off the audit log.

### Setup for other agents

The `hoop mcp` command is an MCP server on stdio, so any MCP client can use it. Most clients take a JSON entry like
this one:

```json
{
  "mcpServers": {
    "hoop": { "command": "hoop", "args": ["mcp"], "env": { "HOOP_REPO_DIR": "/absolute/path/to/your/repo" } }
  }
}
```

`HOOP_REPO_DIR` tells hoop which repository the documents belong to. Leave it out when the client
starts servers in the project folder. An agent without MCP can run the commands in the table above
instead.

### Stability

This project is before 1.0, so some surfaces may still break. They are tool names and arguments,
commands and flags, the stored files in `~/.hoop`, and the pages. The `hoop/review@0` and `hoop/feedback@0`
formats are versioned. Added fields keep the version, and a breaking change gets a new one. An old
tool or command name keeps working, with a notice, for two minor releases after it is renamed.
Every breaking change and every removal is announced in [`CHANGELOG.md`](CHANGELOG.md).

## Develop

See [`CONTRIBUTING.md`](CONTRIBUTING.md) to build hoop, run its tests and send a change. Report a
vulnerability as [`SECURITY.md`](SECURITY.md) says.

## License

The hoop project and its devloop and hoop-plan plugins are licensed under the Apache License,
Version 2.0. See [`LICENSE`](LICENSE).
