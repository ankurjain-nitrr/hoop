# JavaScript and TypeScript (Node)

## Test command

- The suite runs with `npm test`, or the `test` script in `package.json`. Use `pnpm test` or
  `yarn test` when the repo has that lockfile.
- One file runs with the test runner directly. Examples are `node --test <file>`,
  `npx vitest run <file>` and `npx jest <file>`.

## Gate

- Save the output and check the status, such as `npm test > test.log 2>&1 || exit 1`.
- Don't pipe the run into `grep` or `tail` in the same check, because the pipe reports the last
  command's status.

## Static checks

- TypeScript projects check types with `npx tsc --noEmit`.
- The linter and formatter are whatever `package.json` scripts name, such as `npm run lint`.

## Size budget

- These don't count: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, and build output such as
  `dist/` or `build/`.

## Runtime pins

- Check `.nvmrc`, `.node-version`, `engines` in `package.json`, `packageManager`, `.tool-versions`
  and the CI setup step.

## Hooks

- Look in `.husky/`, `lefthook.yml`, `.pre-commit-config.yaml` and `.git/hooks/`.

## Gotchas

- Browser test libraries often need a newer Node than the app. Find the right binary in the
  preflight, not in the middle of a slice.
- A module that a test imports from TypeScript may need a `.d.ts` declaration. Count it in the
  size estimate.
