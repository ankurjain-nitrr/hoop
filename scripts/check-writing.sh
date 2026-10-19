#!/bin/sh
# hoop's own check command (CR-10): runs devloop's writing checker on the document hoop passes.
# DEVLOOP_WRITING_CHECKER names the checker to use. Without it, the newest installed devloop
# plugin's copy is used. Exit 0 means no findings and exit 1 means findings. Exit 2 means no
# checker was found, so hoop reports that the check didn't run.
checker="${DEVLOOP_WRITING_CHECKER:-}"
if [ -z "$checker" ]; then
  checker=$(ls -d "$HOME"/.claude/plugins/cache/*/devloop/*/skills/writing-style/scripts/check_writing.py 2>/dev/null | sort -V | tail -n 1)
fi
if [ -z "$checker" ] || [ ! -f "$checker" ]; then
  echo "devloop's writing checker isn't installed. Install the devloop plugin, or set DEVLOOP_WRITING_CHECKER." >&2
  exit 2
fi
exec python3 "$checker" "$@"
