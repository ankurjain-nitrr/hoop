#!/bin/sh
# Runs `hoop plan-review` for Claude Code's ExitPlanMode hook, and fails closed. Claude Code lets the
# tool call go ahead when a hook crashes, times out or exits with any code but 2, so every failure
# here prints its reason and exits 2: a missing hoop, a crash, output that isn't a decision, or the
# alarm, which ends the review 30 seconds before Claude Code's own ten minute timeout.
HOOP="${HOOP_BIN:-hoop}"
ALARM="${HOOP_PLAN_ALARM:-570}"

deny() {
  echo "hoop-plan: $1 The plan wasn't reviewed, so stop here and tell the user; they can run hoop plan-review themselves or turn the hook off." >&2
  exit 2
}

input=$(cat)
command -v "$HOOP" >/dev/null 2>&1 || command -v "${HOOP%% *}" >/dev/null 2>&1 || deny "hoop isn't on PATH."
command -v perl >/dev/null 2>&1 || deny "perl isn't available to time the review."
# shellcheck disable=SC2086
out=$(printf '%s' "$input" | perl -e 'alarm shift; exec @ARGV' "$ALARM" $HOOP plan-review)
code=$?
[ "$code" -eq 0 ] || deny "hoop plan-review failed (exit $code)."
case "$out" in
  *'"permissionDecision"'*) printf '%s\n' "$out" ;;
  *) deny "hoop plan-review gave no decision." ;;
esac
