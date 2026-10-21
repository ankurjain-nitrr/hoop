---
name: oss-practices
description: Checks a repository for the practices an open source project keeps (license, README, contributing guide, code of conduct, security policy, changelog, editor settings, code owners, dependency updates, issue and pull request templates, CI), reports each one missing, and keeps them current in every change devloop drives. Use when setting up or auditing a repository, before a project's first release, or for "open source practices", "OSS checklist" or "is this repo ready to publish".
---

# Open source practices

A project that others can use and change keeps a small set of files. This skill finds the missing
ones, adds them, and keeps them true as the project changes.

## 1. Check

Run the checker from the repository's root:

```sh
python3 "${CLAUDE_PLUGIN_ROOT}/skills/oss-practices/scripts/check_practices.py" .
```

It prints one line for each missing practice, with what to add, and exits 1 when one is missing.

## 2. Add what is missing

Write each file for this project, not as a template left unfilled.

- **Contributing guide:** how to build, test and send a change, with the real commands.
- **Code of conduct:** the Contributor Covenant, with a private way to report.
- **Security policy:** a private way to report, the supported versions, and what the project does
  and doesn't protect.
- **Changelog:** the Keep a Changelog form, with an Unreleased section.
- **CI:** the type check, linter and tests on every supported runtime, on every pull request.
- Never put a person's email address in a file without their consent. Prefer GitHub's private
  advisories and the code owners file.

Ask before adding a license: the choice is the owner's.

## 3. Keep them current

In every change devloop drives:

- Add the change's user-visible effects to the changelog's Unreleased section.
- Update the contributing guide when a build or test command changes.
- Update the security policy when the change touches what the project protects.
- Run the checker before the pull request, and say its result in the description.
