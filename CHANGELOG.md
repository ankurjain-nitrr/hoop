# Changelog

All notable changes to hoop are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and hoop uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Contributor files, commit hooks, Biome and CI on every pull request.
- Review owners: the Claude Code session that submits a review owns it, and only it revises, replies
  or proposes edits. Other sessions comment with `hoop_comment` (`hoop comment`); a process outside
  a session only reads.
- A per-review lock, so writes from several processes are never lost.
- Each Claude Code session keeps its reviews in its own folder,
  `~/.claude/projects/<folder>/<session-id>/.hoop/`, and `~/.hoop/index.json` lets the one page on
  port 4747 serve them all. A process without a session, or a session hoop can't find, still uses
  `~/.hoop/reviews`. The first run moves each review in `~/.hoop/reviews` whose session folder exists
  into it, copying and checking each file byte for byte before it removes the original.
- `hoop clear <review_id>` and `hoop clear --session <id>` delete reviews for good, after a
  confirmation on a terminal or with `--yes`. hoop deletes nothing by itself.

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
- The devloop plugin, which moved to its own repository. This marketplace now lists only hoop-plan.

### Changed

- A review's "Audit trail" section is now called "History".

### Deprecated

- The tool `hoop_submit_markdown` and the command `hoop submit-json` are old names. Use
  `hoop_submit` and `hoop submit-decision`. Passing a decision document to `hoop_submit` is
  deprecated too. The old names go in the second minor release after this one.
