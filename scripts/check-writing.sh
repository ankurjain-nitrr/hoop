#!/bin/sh
# hoop's own check command (CR-10): runs devloop's writing checker on the document hoop passes.
# DEVLOOP_WRITING_CHECKER names the checker to use. Without it, the newest version of devloop
# installed from its own marketplace is used. Exit 0 means no findings and exit 1 means findings.
# Exit 2 means the check didn't run, so hoop says so instead of showing a crash as a finding.
checker="${DEVLOOP_WRITING_CHECKER:-}"
if [ -z "$checker" ]; then
  checker=$(ls -d "$HOME"/.claude/plugins/cache/ankurjain-skills/devloop/*/skills/writing-style/scripts/check_writing.py 2>/dev/null | sort -V | tail -n 1)
fi
if [ -z "$checker" ] || [ ! -f "$checker" ]; then
  echo "devloop's writing checker isn't installed. Install devloop 0.22 or later, or set DEVLOOP_WRITING_CHECKER." >&2
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
