# Releasing hoop

hoop is published to npm as `@ankurjain-nitrr/hoop` by `.github/workflows/release.yml`, and a
release goes live only after a maintainer approves it on npmjs.com.

## Make a release

1. In a pull request, bump `version` in `package.json` and `package-lock.json`
   (`npm version X.Y.Z --no-git-tag-version`), and merge it to `main`.
2. Tag that commit on `main` and push the tag:

   ```sh
   git fetch origin && git tag vX.Y.Z origin/main && git push origin vX.Y.Z
   ```

3. The Release workflow runs the type check, lint, the full test suite with Chrome and
   `scripts/e2e-local.ts`, checks that the tag is `v` plus the `package.json` version, and runs
   `npm stage publish`. npm authenticates the workflow through trusted publishing, so no token is
   stored anywhere.
4. On npmjs.com, open **Staged Packages**, check the staged version, and **Approve** it with
   two-factor authentication. Only then is it published.
5. To move the plugin to the new version, change `HOOP_PACKAGE` in
   `plugins/hoop/scripts/hoop.sh` and bump the plugin's version, in a pull request.

Before tagging, you can run the agent evals on your own Claude Code sign-in (they cost money and
never run in CI): `npx tsx scripts/evals/run.ts` runs every scenario three times, and
`npx tsx scripts/evals/run.ts --scenario asks-for-review --trials 1` runs one. `--model`, `--max-turns`,
`--max-usd` (for each trial, across its resumes) and `--max-trials` (for the run, 15 by default)
bound it. A trial's Claude Code state goes under `~/.claude/projects/`, and is purged when it passes. A drop in a
pass rate is worth reading in the report; it doesn't block a release.

A failed run stages nothing. Fix the cause in a new pull request and release a new version; npm
never accepts the same version twice.

## How it is set up

- The npm account `ankurjain-nitrr` has two-factor authentication on.
- The package's trusted publisher is GitHub Actions, repository `ankurjain-nitrr/hoop`, workflow
  `release.yml`, with direct publishing off, so the workflow can only stage.
- The package requires two-factor authentication and refuses tokens that bypass it.
- Version 0.1.0 was published by hand, since npm sets up a trusted publisher only for a package
  that exists.
