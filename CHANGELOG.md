# Changelog

All notable changes to hoop are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and hoop uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Contributor files, commit hooks, Biome and CI on every pull request.

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

### Deprecated

- The tool `hoop_submit_markdown` and the command `hoop submit-json` are old names. Use
  `hoop_submit` and `hoop submit-decision`. Passing a decision document to `hoop_submit` is
  deprecated too. The old names go in the second minor release after this one.
