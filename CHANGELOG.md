# Changelog

All notable changes to hoop are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and hoop uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Builds: `hoop_build` (`hoop build`) starts a document the person shapes on the page, adding,
  editing, moving and removing blocks. Each change is a step with a snapshot; the build exports as
  markdown byte for byte. Generate on a section asks Claude to write it (`hoop_build_wait`,
  `hoop_build_write`); its text shows as generated, and Undo puts back what was there. Finish and
  review turns the build into a review of the whole document. The plugin's `build-document` skill
  and the MCP instructions use builds for the section-by-section step.
- A build reads as an outline: a heading holds its section, nested and indented under it, folds
  with it, and moves with it among its sibling sections; Remove on a heading asks whether its
  content goes too. A build starts from just a title, with no questions first; Suggest an outline,
  Suggest next section and Suggest subsections ask Claude for headings (`hoop_build_suggest`),
  which wait as placeholders until the person accepts them.
- One Claude Code plugin, `hoop@hoop`, holds the MCP server, the plan hook and the pull request
  hook. It runs the `hoop` on PATH, or the package through `npx` without one. `hoop init` installs
  it with `claude`, or prints the two commands with `--print`.
- Building a document together: when asked to build a document with the person, Claude asks who
  it's for, proposes an outline, then writes one section per revision. The plugin's
  `build-document` skill holds the same steps. Claude also draws flows and architectures as Mermaid.
- Contributor files, commit hooks, Biome and CI on every pull request.
- Review owners: the Claude Code session that submits a review owns it, and only it revises, replies
  or proposes edits. Other sessions comment with `hoop_comment` (`hoop comment`); a process outside
  a session only reads.
- A per-review lock, so writes from several processes are never lost.
- A read-only Work page beside Home: each Claude Code session's todos and subagents, recorded by
  background plugin hooks (`hoop work-hook`) and refreshed while the page is open.
- Steering from the Work page: comment on, edit, reorder and remove queued todos, and comment on or
  stop running agents. Changes go to the session in one message over its messaging socket, and a
  gate hook (`hoop work-gate`) refuses to start a removed or edited todo and every tool call of a
  stopped agent. The page shows each change's delivery: sent, waiting for the gate, seen or
  overridden.
- `hoop init` asks once to turn on Claude Code's todo tools (`--yes` or `--no` answers), and on yes
  sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under `env` in Claude Code's settings, keeping a backup.
- A person's review wakes the session that asked for it: the pages send it one message over its
  messaging socket naming the review, unless a wait already has it, and record whether it got
  there. The review page says whether Claude is waiting, idle or ended (with the `claude --resume`
  command to copy), and Home marks reviews Claude hasn't read yet.
- `hoop_wait` waits up to ten minutes per call in Claude Code (45 seconds elsewhere), and its pending
  result and `hoop wait` say what they wait for and where.

### Removed

- The GitHub channel: decision pull requests, merge to approve, close to reject, and GitHub reviews
  shown on the page. The GitHub sign-in stays.
- Writing `decisions/<slug>.json` and `.md` into the repository on approval, and `decision_files`
  in feedback.
- Agent approvals: an approve or a request for changes without a GitHub sign-in is now refused, so
  the `agent_approval`, `changes_requested_by_agent` and `unverified` fields are gone.
- Change requests and trackers: the `hoop cr` and `hoop tracker` commands, their tools, the
  `/changes` and `/tracker` pages, the `devloop` setting and the `--cr` and `--doc` submit options.
- Document checks on submit, `hoop allow-check` and the findings panel.
- The `channel` field of a review document and the `source` field of feedback.
- `hoop audit`, the `~/.hoop/audit.jsonl` log and `HOOP_AUDIT`. The pages process now records its
  starts, restarts and stops in `~/.hoop/pages.jsonl`.
- The devloop plugin, which moved to its own repository. This marketplace now lists only the hoop plugin.
- The old names `hoop_submit_markdown` (use `hoop_submit`) and `hoop submit-json` (use
  `hoop submit-decision`), so agents no longer pick the old tool over the new one.

### Changed

- The `hoop-plan` plugin is now the `hoop` plugin. Run `claude plugin uninstall hoop-plan@hoop`
  before installing it.
- A review's "Audit trail" section is now called "History".

### Fixed

- The review page could send an empty Comment. Submit now stays off for a comment or a request for
  changes with nothing in it, and the API refuses one (#181).

### Deprecated

- Passing a decision document to `hoop_submit`. Use `hoop_submit_decision`.
