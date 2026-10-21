#!/usr/bin/env python3
"""Lists the open source practices a repository is missing, and exits 1 when one is missing.

Usage: python3 check_practices.py [repo]   (default: the current folder)
"""
import glob, os, sys

# Each practice: its name, the paths that satisfy it (any one), and what to add.
PRACTICES = [
    ("license", ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"], "Add a LICENSE file."),
    ("readme", ["README.md", "README"], "Add a README that says what the project does and how to start."),
    ("contributing guide", ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md"],
     "Add CONTRIBUTING.md that says how to build, test and send a change."),
    ("code of conduct", ["CODE_OF_CONDUCT.md", ".github/CODE_OF_CONDUCT.md"], "Add CODE_OF_CONDUCT.md, such as the Contributor Covenant."),
    ("security policy", ["SECURITY.md", ".github/SECURITY.md"], "Add SECURITY.md that says how to report a vulnerability privately."),
    ("changelog", ["CHANGELOG.md", "CHANGES.md"], "Add CHANGELOG.md in the Keep a Changelog form."),
    ("editor settings", [".editorconfig"], "Add .editorconfig with the project's indentation and line endings."),
    ("code owners", [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"], "Add .github/CODEOWNERS that names who reviews each part."),
    ("dependency updates", [".github/dependabot.yml", ".github/dependabot.yaml", "renovate.json", ".github/renovate.json"],
     "Add .github/dependabot.yml or a Renovate config."),
    ("pull request template", [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md"],
     "Add .github/pull_request_template.md."),
    ("issue templates", [".github/ISSUE_TEMPLATE/*.yml", ".github/ISSUE_TEMPLATE/*.yaml", ".github/ISSUE_TEMPLATE/*.md"],
     "Add issue forms in .github/ISSUE_TEMPLATE/."),
    ("continuous integration", [".github/workflows/*.yml", ".github/workflows/*.yaml", ".gitlab-ci.yml", ".circleci/config.yml"],
     "Add a CI workflow that runs the checks and tests on every pull request."),
]


def missing(repo):
    """The practices `repo` lacks, as (name, advice) pairs."""
    return [(name, advice) for name, paths, advice in PRACTICES
            if not any(glob.glob(os.path.join(repo, p)) for p in paths)]


def main(argv):
    repo = argv[1] if len(argv) > 1 else "."
    gaps = missing(repo)
    for name, advice in gaps:
        print(f"missing {name}: {advice}")
    if not gaps:
        print("Every practice is in place.")
    return 1 if gaps else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
