# Releasing hoop

hoop is published to npm as `@ankurjain-nitrr/hoop` by `.github/workflows/release.yml`, and a
release goes live only after a maintainer approves it on npmjs.com.

## Make a release

1. In a pull request, bump `version` in `package.json` and `package-lock.json`
   (`npm version X.Y.Z --no-git-tag-version`), turn `CHANGELOG.md`'s Unreleased section into
   `## [X.Y.Z] - <date>` (the GitHub Release takes its notes from it), and merge it to `main`.
2. On that commit, run the agent evals with `npm run eval` (see [Agent evals](#agent-evals)). Don't
   release unless it exits 0. It exits 1 when a core scenario's pass^3 fell below
   `evals/baseline.json`. Then either fix the cause, or, when the drop is on purpose (a check got
   stricter, a model changed), record new scores with
   `npm run eval -- --update-baseline --reason "<why>"` and merge `evals/baseline.json` in a pull
   request. The reason stays in the file and in each later report.
3. Tag that commit on `main` and push the tag:

   ```sh
   git fetch origin && git tag vX.Y.Z origin/main && git push origin vX.Y.Z
   ```

4. The Release workflow runs the type check, lint, the full test suite with Chrome and
   `scripts/e2e-local.ts`, checks that the tag is `v` plus the `package.json` version, and runs
   `npm stage publish`, then creates the tag's GitHub Release with that version's `CHANGELOG.md`
   section as its notes and the package tarball attached. npm authenticates the workflow through trusted publishing, so no token is
   stored anywhere.
5. On npmjs.com, open **Staged Packages**, check the staged version, and **Approve** it with
   two-factor authentication. Only then is it published.
6. To move the plugin to the new version, change `HOOP_PACKAGE` in
   `plugins/hoop/scripts/hoop.sh` and bump the plugin's version, in a pull request.

## Agent evals

The agent evals run on your own Claude Code sign-in (they cost money and never run in CI):
`npm run eval` runs every scenario three times, and
`npm run eval -- --scenario asks-for-review --trials 1` runs one. The scenarios are `asks-for-review`,
`waits-properly`, `answers-every-comment`, `uses-exact-edits`, `revises-after-changes`,
`never-approves`, `treats-recommended-answers`, `follows-work-order` and
`respects-removal-and-stopping` (see "Agent evals" in `docs/DESIGN.md`). `--model`, `--max-turns`,
`--max-usd` (for each trial, across its resumes) and `--max-trials` (for the run, 27 by default)
bound it. A trial's Claude Code state goes under `~/.claude/projects/`, and is purged when it passes.

The report gives each scenario's pass rate and pass^3, and each check's pass rate, beside the
baseline's. pass^3 is the chance that three trials in a row pass, from the run's trials (with three,
1 only when all three passed). Every scenario now is core: a fall in its pass^3 is a regression,
and the run exits 1. A pass rate more than one trial lower is a drop, which the report shows
without failing the run. A scenario isn't compared when it isn't in the baseline, when its
script's version changed since, or with fewer than three trials. The first baseline comes from a
full run with `--update-baseline --reason "first baseline"`. A run that updates the baseline
replaces only the scenarios it ran.

A failed run stages nothing. Fix the cause in a new pull request and release a new version; npm
never accepts the same version twice.

## How it is set up

- The npm account `ankurjain-nitrr` has two-factor authentication on.
- The package's trusted publisher is GitHub Actions, repository `ankurjain-nitrr/hoop`, workflow
  `release.yml`, with direct publishing off, so the workflow can only stage.
- The package requires two-factor authentication and refuses tokens that bypass it.
- Version 0.1.0 was published by hand, since npm sets up a trusted publisher only for a package
  that exists.
