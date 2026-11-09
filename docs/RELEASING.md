# Releasing hoop

hoop is published to npm as `@ankurjain-nitrr/hoop` by `.github/workflows/release.yml`, and a
release goes live only after a maintainer approves it on npmjs.com.

## One version number

The package and the Claude Code plugin share one version number, and move together. `package.json`
holds it; `package-lock.json` and `plugins/hoop/.claude-plugin/plugin.json` carry the same number,
and the plugin runs the package of its own version through npx (`plugins/hoop/scripts/hoop.sh`).
The pages' version label reads it from the installed `package.json`.
`npm version X.Y.Z --no-git-tag-version` sets all three, through the `version` script
(`scripts/version.ts`). `npm run check:version` fails, naming each file, when they differ, and so
does `test/plugin.test.ts`, which CI runs, and the Release workflow.

The number moves only in a release's pull request. Claude Code keeps an installed plugin by its
version, so a change to the plugin's files reaches installed sessions at the next release, with the
package it was made for. The numbers began at 1.6.0, after the plugin's 1.5.10 and the package's
0.2.0: higher than both, so Claude Code sees a new plugin and npm a new package.

## Make a release

1. In a pull request, set the version with `npm version X.Y.Z --no-git-tag-version`, which sets
   `package.json`, `package-lock.json` and the plugin's `plugin.json` (see
   [One version number](#one-version-number)), turn `CHANGELOG.md`'s Unreleased section into
   `## [X.Y.Z] - <date>` (the GitHub Release takes its notes from it), and merge it to `main`.
   From that merge until the release is approved (step 5), the plugin on `main` names a package
   npm doesn't have yet, so a session without a global `hoop` that installs or updates the plugin
   then can't start hoop. Merge it only when you'll tag and approve right after.
2. On that commit, run the release check of the agent evals with `npm run eval -- --release` (see
   [Agent evals](#agent-evals)). Don't release unless it exits 0. A release needs a committed
   `evals/baseline.json`, and the check refuses to start without one, or with one that has
   uncommitted changes. It runs every scenario three times. It fails, listing each core scenario
   and why, when one didn't run, wasn't compared (not in the baseline, its script changed since),
   ran under another model, `--max-turns` or `--max-usd` than its baseline was recorded with, or
   its pass^3 fell. Then either fix the cause, or, when the change is on purpose (a check got
   stricter, a model changed), record new scores with
   `npm run eval -- --update-baseline --reason "<why>"` and merge `evals/baseline.json` in a pull
   request. Each scenario's entry keeps the reason it was last recorded with, and later reports
   show it.
3. Tag that commit on `main` and push the tag:

   ```sh
   git fetch origin && git tag vX.Y.Z origin/main && git push origin vX.Y.Z
   ```

4. The Release workflow runs the type check, lint, the full test suite with Chrome and
   `scripts/e2e-local.ts`, checks that the tag is `v` plus the `package.json` version and that the
   plugin carries the same version, and runs
   `npm stage publish`, then creates the tag's GitHub Release with that version's `CHANGELOG.md`
   section as its notes and the package tarball attached. npm authenticates the workflow through trusted publishing, so no token is
   stored anywhere.
5. On npmjs.com, open **Staged Packages**, check the staged version, and **Approve** it with
   two-factor authentication. Only then is it published.
6. Nothing else: the plugin moved with the package in step 1, and runs the package of its own
   version once it is approved.

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
script's version changed since, or when the run or the baseline has fewer than three trials of
it. A core scenario in the baseline that the run didn't run is listed as not run. Only
`--release` fails on these. The first baseline comes from a full run with
`--update-baseline --reason "first baseline"`, which needs at least three trials of each scenario.
A run that updates the baseline replaces only the scenarios it ran. Each one gets this run's date,
reason, model, budgets, hoop release and plugin commit, and the others keep their own.

`npm run eval -- --rescore evals/runs/<dir>` scores a recorded run again with the current checks
and script versions, at no cost: it reads the run's records and runs no Claude. With
`--update-baseline --reason "<why>"` it records those scores, keeping the run's recorded model,
budgets, hoop release and plugin as their provenance. It takes no `--trials`,
`--model`, `--max-turns`, `--max-usd`, `--max-trials` or `--release`, since the run is scored as it
ran. `--scenario <name>`, once per scenario, scores only those, so `--update-baseline` rewrites only
their entries and leaves the others as they were, with their dates and reasons: use it when a
change touched one scenario's checks (`npm run eval -- --rescore evals/runs/<dir> --scenario
respects-removal-and-stopping --update-baseline --reason "<why>"`). A scenario the run holds no
trials of is refused. A live run updates only the scenarios it ran, which `--scenario` picks the
same way. Only trials that ran today's prompts and steps are scored. Each run records a hash of every
scenario's setup, and a scenario whose hash changed since is left out and named. A run from before
the hash was kept is refused unless `--assume-same-setup` says the prompts and steps haven't
changed since it, which the report then says. `evals/baseline.json` began this way: the 2026-11-08
run, rescored after #444 fixed four checks, with `--assume-same-setup`, since no prompt or step had
changed since its commit.

A failed run stages nothing. Fix the cause in a new pull request and release a new version; npm
never accepts the same version twice.

## The README's capture

`docs/review-loop.png`, at the top of the README, shows the review loop: a session submits a plan,
the person comments on a line and requests changes, Claude replies and sends a revision, and the
person approves. Record it again whenever the review page changes, and commit the new file with
that change:

```sh
npx tsx scripts/readme-capture.ts
```

It needs Chrome (`HOOP_CHROME` points at it). It runs its own hoop on port 4795, with a throwaway
home, repository and Claude folder and a made-up session, so it never touches `~/.hoop`,
`~/.claude` or the pages on 4747. It writes an 800-pixel-wide animated PNG in the light theme, and
fails when the file is over 1.5 MB. `HOOP_CAPTURE_FRAMES=<folder>` also keeps each frame as a PNG,
to look over before committing.

## How it is set up

- The npm account `ankurjain-nitrr` has two-factor authentication on.
- The package's trusted publisher is GitHub Actions, repository `ankurjain-nitrr/hoop`, workflow
  `release.yml`, with direct publishing off, so the workflow can only stage.
- The package requires two-factor authentication and refuses tokens that bypass it.
- Version 0.1.0 was published by hand, since npm sets up a trusted publisher only for a package
  that exists.
