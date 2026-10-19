#!/bin/sh
# hoop's own check command (CR-10): runs devloop's writing checker on the document hoop passes.
# The checker ships in this repository, under plugins/devloop. DEVLOOP_WRITING_CHECKER names
# another checker. Exit 0 means no findings and exit 1 means findings. Exit 2 means the check
# didn't run, so hoop says so instead of showing a crash as a finding.
here=$(cd "$(dirname "$0")/.." && pwd)
checker="${DEVLOOP_WRITING_CHECKER:-$here/plugins/devloop/skills/writing-style/scripts/check_writing.py}"
if [ ! -f "$checker" ]; then
  echo "The writing checker isn't at $checker. Set DEVLOOP_WRITING_CHECKER to its path." >&2
  exit 2
fi
if ! python3 -c "" >/dev/null 2>&1; then
  echo "python3 doesn't run on this machine, so the writing checker can't run." >&2
  exit 2
fi
out=$(python3 "$checker" "$@" 2>&1)
code=$?
printf '%s\n' "$out"
# The checker exits 1 for findings, and ends its report with a count. Python also exits 1 when it
# crashes, so exit 1 without that count means the checker failed.
if [ "$code" -eq 1 ] && ! printf '%s\n' "$out" | grep -q "finding(s)\."; then
  exit 2
fi
exit "$code"
