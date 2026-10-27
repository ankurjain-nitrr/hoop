#!/bin/sh
# Claude Code's TaskCompleted hook, run when a todo is marked completed: hoop's done gate. It refuses
# the completion once per link while a review the todo links to isn't approved or a pull request it
# owns isn't merged, by exiting 2 with the reason on stderr. The next completion goes ahead.
#
# It fails open: any error, a missing hoop, no pages process or an answer that takes more than a few
# seconds lets the completion go ahead. It starts hoop only for a session with a work record.
input=$(cat)
case "$input" in
  *'"hook_event_name":"TaskCompleted"'* | *'"hook_event_name": "TaskCompleted"'*) ;;
  *) exit 0 ;;
esac
# The session: the first "session_id", since Claude Code writes it first.
session=$(printf '%s' "$input" | grep -o '"session_id" *: *"[A-Za-z0-9_-]\{1,128\}"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$session" ] || exit 0
[ -e "${HOOP_HOME:-$HOME/.hoop}/work/$session.json" ] || exit 0

. "$(dirname "$0")/hoop.sh"
[ -n "$HOOP" ] || exit 0
command -v "$HOOP" >/dev/null 2>&1 || command -v "${HOOP%% *}" >/dev/null 2>&1 || exit 0
# hoop gives up on the pages process after 2 s. It runs in the background, writing to a file, and a
# watchdog stops it after HOOP_DONE_WAIT seconds (4), so a slow start (npx) never holds the hook past
# its timeout. Plain POSIX sh: no perl, no timeout.
out_file=$(mktemp 2>/dev/null) || exit 0
# Only the reason goes to stderr: the shell's notes on the jobs it kills go nowhere.
exec 3>&2 2>/dev/null
# shellcheck disable=SC2086
printf '%s' "$input" | $HOOP done-gate >"$out_file" 2>/dev/null 3>&- &
pid=$!
( sleep "${HOOP_DONE_WAIT:-4}"; kill "$pid" ) >/dev/null 2>&1 3>&- &
dog=$!
wait "$pid" 2>/dev/null
kill "$dog" 2>/dev/null
out=$(cat "$out_file" 2>/dev/null)
rm -f "$out_file"
case "$out" in
  'refuse: '*)
    printf '%s\n' "${out#refuse: }" >&3
    exit 2
    ;;
esac
exit 0
