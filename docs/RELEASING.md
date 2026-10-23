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

A failed run stages nothing. Fix the cause in a new pull request and release a new version; npm
never accepts the same version twice.

## How it is set up

- The npm account `ankurjain-nitrr` has two-factor authentication on.
- The package's trusted publisher is GitHub Actions, repository `ankurjain-nitrr/hoop`, workflow
  `release.yml`, with direct publishing off, so the workflow can only stage.
- The package requires two-factor authentication and refuses tokens that bypass it.
- Version 0.1.0 was published by hand, since npm sets up a trusted publisher only for a package
  that exists.
