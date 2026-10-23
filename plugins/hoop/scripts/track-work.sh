#!/bin/sh
# Runs `hoop work-hook` for Claude Code's hooks on the todo tools, the Agent tool and subagents, so
# hoop's Work page shows each session's todos and subagents. It never blocks or fails the tool call:
# it prints nothing and always exits 0, and it skips any other input without starting hoop.
input=$(cat)
case "$input" in
  *'"hook_event_name":"Subagent'* | *'"hook_event_name": "Subagent'*) ;;
  *'"tool_name":"Task'* | *'"tool_name": "Task'*) ;;
  *'"tool_name":"TodoWrite"'* | *'"tool_name": "TodoWrite"'*) ;;
  *'"tool_name":"Agent"'* | *'"tool_name": "Agent"'*) ;;
  *) exit 0 ;;
esac
. "$(dirname "$0")/hoop.sh"
[ -n "$HOOP" ] || exit 0
command -v "$HOOP" >/dev/null 2>&1 || command -v "${HOOP%% *}" >/dev/null 2>&1 || exit 0
# shellcheck disable=SC2086
printf '%s' "$input" | $HOOP work-hook >/dev/null 2>&1
exit 0
