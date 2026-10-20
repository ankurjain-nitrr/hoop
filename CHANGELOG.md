# Changelog

All notable changes to hoop are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and hoop uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Contributor files, commit hooks, Biome and CI on every pull request.

### Deprecated

- The tool `hoop_submit_markdown` and the command `hoop submit-json` are old names. Use
  `hoop_submit` and `hoop submit-decision`. Passing a decision document to `hoop_submit` is
  deprecated too. The old names go in the second minor release after this one.
