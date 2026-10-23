# Releasing hoop

hoop is published to npm as `@ankurjain-nitrr/hoop` by `.github/workflows/release.yml`, never from
a laptop.

## Make a release

1. In a pull request, bump `version` in `package.json` and `package-lock.json`
   (`npm version X.Y.Z --no-git-tag-version`), and merge it to `main`.
2. Tag that commit on `main` and push the tag:

   ```sh
   git fetch origin && git tag vX.Y.Z origin/main && git push origin vX.Y.Z
   ```

3. The Release workflow runs the type check, lint, the full test suite with Chrome and
   `scripts/e2e-local.ts`, checks that the tag is `v` plus the `package.json` version, and then runs
   `npm publish --provenance --access public`. The npm page shows the provenance link back to the
   workflow run and commit.

A failed run publishes nothing. Fix the cause in a new pull request and release a new version; npm
never accepts the same version twice.

## First-time setup

1. On npmjs.com, use the account or organization `ankurjain-nitrr`, with two-factor
   authentication on.
2. Create a granular access token that can only publish `@ankurjain-nitrr/hoop` (or packages in the
   scope, for the very first publish), and save it as the repository secret `NPM_TOKEN`.
3. Release the first version as above.
4. On the package's settings page on npmjs.com, add a trusted publisher: GitHub Actions, repository
   `ankurjain-nitrr/hoop`, workflow `release.yml`. Later releases then authenticate through the
   workflow's `id-token` permission.
5. Delete the `NPM_TOKEN` secret, revoke the token, and remove the `NODE_AUTH_TOKEN` line from the
   workflow.
