#!/bin/sh
# Runs `hoop plan-review` for Claude Code's ExitPlanMode hook, and fails closed. Claude Code lets the
# tool call go ahead when a hook crashes, times out or exits with any code but 2, so every failure
# here prints its reason and exits 2: a missing hoop, a crash, output that isn't a decision, or the
# alarm, which ends the review 30 seconds before Claude Code's own ten minute timeout.
ALARM="${HOOP_PLAN_ALARM:-570}"

deny() {
  echo "hoop: $1 The plan wasn't reviewed, so stop here and tell the user; they can run hoop plan-review themselves or turn the hook off." >&2
  exit 2
}

input=$(cat)
start=$(date +%s)
. "$(dirname "$0")/hoop.sh"
[ -n "$HOOP" ] || deny "neither hoop nor npx is on PATH."
command -v "$HOOP" >/dev/null 2>&1 || command -v "${HOOP%% *}" >/dev/null 2>&1 || deny "$HOOP isn't on PATH."
command -v perl >/dev/null 2>&1 || deny "perl isn't available to time the review."
if [ -n "$HOOP_VIA_NPX" ]; then
  # npx fetches and builds hoop on its first run, which can take a minute; do that before the review,
  # within the same alarm, so the review's wait gets whatever time is left.
  # shellcheck disable=SC2086
  perl -e 'alarm shift; exec @ARGV' "$ALARM" $HOOP help </dev/null >/dev/null 2>&1 || deny "npx couldn't run $HOOP_PACKAGE."
fi
left=$((ALARM - ($(date +%s) - start)))
[ "$left" -gt 60 ] || deny "starting hoop left too little time to review the plan."
# hoop stops waiting for a verdict 30 seconds before the alarm, so it can still answer with the link.
HOOP_PLAN_WAIT_SECONDS="${HOOP_PLAN_WAIT_SECONDS:-$((left - 30))}"
export HOOP_PLAN_WAIT_SECONDS
# shellcheck disable=SC2086
out=$(printf '%s' "$input" | perl -e 'alarm shift; exec @ARGV' "$left" $HOOP plan-review)
code=$?
[ "$code" -eq 0 ] || deny "hoop plan-review failed (exit $code)."
case "$out" in
  *'"permissionDecision"'*) printf '%s\n' "$out" ;;
  *) deny "hoop plan-review gave no decision." ;;
esac
