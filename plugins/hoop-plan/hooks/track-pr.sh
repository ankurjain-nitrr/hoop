#!/bin/sh
# Runs `hoop pr-hook` after each Bash call in Claude Code, so hoop's Home lists the pull requests a
# session opens with `gh pr create`. It never blocks or fails the tool call: it prints nothing and
# always exits 0, and it skips any command that doesn't mention `gh pr create` without starting hoop.
HOOP="${HOOP_BIN:-hoop}"
input=$(cat)
case "$input" in
  *'gh pr create'*) ;;
  *) exit 0 ;;
esac
command -v "$HOOP" >/dev/null 2>&1 || command -v "${HOOP%% *}" >/dev/null 2>&1 || exit 0
# shellcheck disable=SC2086
printf '%s' "$input" | $HOOP pr-hook >/dev/null 2>&1
exit 0
