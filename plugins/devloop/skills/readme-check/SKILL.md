---
name: readme-check
description: Pre-push README gate. Checks the README's claims (versions, requirements, commands, config, API names, defaults, sample output) against the commits about to be pushed and fixes what they made stale, with minimal edits. Use before git push, before opening or updating a PR, or for "check/vet the README".
---

# README check

Before a push, make sure the README still tells the truth about the code being pushed. This is a gate
scoped to the outgoing commits, not a README rewrite: fix what they made stale, change nothing else.

## 1. Scope the push

- Base: the upstream (`git rev-parse @{u}`); with no upstream, the merge-base with the default branch
  (`git merge-base HEAD origin/HEAD`; if `origin/HEAD` is unset, run `git remote set-head origin -a`).
- Read `git log --oneline <base>..HEAD` and `git diff <base>..HEAD`. If there is nothing to push, stop.
- Uncommitted changes are not part of the push. Mention them, don't vet them.
- READMEs in scope: the root `README*`, plus any `README*` in a directory the diff touches.

## 2. List what the README could now get wrong

From the diff itself (not the commit messages), collect every changed fact a reader might rely on:

- **Values that changed:** dependency and tool versions, minimum language or runtime version, ports,
  paths, env vars, config keys, CLI flags, defaults, output formats.
- **Names that changed:** files, scripts, commands, tasks, public APIs, packages, endpoints.
- **Behavior added or removed:** features, options, supported platforms.

For each old value or name, grep the in-scope READMEs for it. Hits are almost always stale; these
are the cheapest and most reliable findings.

## 3. Check the README's claims against the code

Go through the README sections the changes touch and verify each claim against the files. If the
project's `CLAUDE.md` lists README claims to keep true (e.g. "the Setup snippet matches the build
file"), check those first.

- Install and setup snippets match the build files' versions and coordinates.
- Stated requirements match the toolchain, CI and container images.
- Every command, script, task and path it mentions still exists and is invoked as written.
- API names, signatures, options and defaults match the code; sample output matches what the code
  emits (names, labels, formats).
- Links and badges point at files and workflows that still exist.
- New behavior a user needs is mentioned; removed behavior is not.

Run a documented command only when that is cheap and safe; otherwise check it by reading.

## 4. Fix

- Make the smallest edit that makes each claim true. Keep the README's voice, structure and
  formatting; don't add sections, badges or marketing. State current behavior in the present tense;
  no "now", "previously" or "changed to" (see `/devloop:code-docs`).
- Staleness that predates this push: report it, don't fix it, unless the user asks.
- If the right wording needs a decision only the user can make (e.g. a breaking change for
  consumers), ask instead of guessing.
- Commit README fixes as their own commit on top (e.g. "Update README for <change>"). Don't amend or
  rewrite commits the user made.

## 5. Report, then push

Say either what you changed and why, or "README checked against <n> commits; no changes needed",
plus any pre-existing staleness you noticed. Then continue with the push only if the user asked for
it.

`devloop` runs this before every push. Outside devloop, a project can add to its `CLAUDE.md`:
"Before every `git push`, run `/devloop:readme-check`."
