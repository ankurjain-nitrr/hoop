#!/bin/sh
# Runs `hoop work-hook` for Claude Code's hooks on the todo tools, the Agent tool and subagents, and
# on a permission prompt, so hoop's Work page shows each session's todos and subagents and what waits
# on the person. It never blocks or fails the tool call: it prints nothing and always exits 0, and it
# skips any other input, and a permission prompt of a session with no work, without starting hoop.
input=$(cat)
case "$input" in
  *'"hook_event_name":"PermissionRequest"'* | *'"hook_event_name": "PermissionRequest"'*)
    # The session: the first "session_id", since Claude Code writes it first.
    session=$(printf '%s' "$input" | grep -o '"session_id" *: *"[A-Za-z0-9_-]\{1,128\}"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
    [ -n "$session" ] && [ -e "${HOOP_HOME:-$HOME/.hoop}/work/$session.json" ] || exit 0
    ;;
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
