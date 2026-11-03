#!/bin/sh
# Claude Code's SessionStart hook, run when a session starts, resumes, clears or compacts: hoop adds
# a short note to Claude's context with the session's queued todos, unread feedback and reviews that
# wait on Claude's answer. It reads hoop's files and never starts the pages process. A new session
# starts hoop only when hoop already keeps something for it; a resume, clear or compaction always does.
#
# It fails open: any error, a missing hoop or hoop folder, or an answer that takes more than a few
# seconds prints nothing. It always exits 0.
input=$(cat)
case "$input" in
  *'"hook_event_name":"SessionStart"'* | *'"hook_event_name": "SessionStart"'*) ;;
  *) exit 0 ;;
esac
# The session: the first "session_id", since Claude Code writes it first.
session=$(printf '%s' "$input" | grep -o '"session_id" *: *"[A-Za-z0-9_-]\{1,128\}"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$session" ] || exit 0
home="${HOOP_HOME:-$HOME/.hoop}"
[ -d "$home" ] || exit 0
case "$input" in
  *'"source":"startup"'* | *'"source": "startup"'*)
    # The session's reviews sit in `.hoop` beside its transcript: <folder>/<session>.jsonl, <folder>/<session>/.hoop.
    transcript=$(printf '%s' "$input" | grep -o '"transcript_path" *: *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
    [ -e "$home/work/$session.json" ] || { [ -n "$transcript" ] && [ -d "${transcript%.jsonl}/.hoop/reviews" ]; } || exit 0
    ;;
esac

. "$(dirname "$0")/hoop.sh"
[ -n "$HOOP" ] || exit 0
command -v "$HOOP" >/dev/null 2>&1 || command -v "${HOOP%% *}" >/dev/null 2>&1 || exit 0
# hoop runs in the background, writing to a file, and a watchdog stops it after HOOP_START_WAIT
# seconds (4), so a slow start (npx) never holds the session's start. Plain POSIX sh: no perl.
out_file=$(mktemp 2>/dev/null) || exit 0
# Claude Code reads stdout alone: the shell's notes on the jobs it kills go nowhere.
exec 2>/dev/null
# shellcheck disable=SC2086
printf '%s' "$input" | $HOOP session-start >"$out_file" 2>/dev/null &
pid=$!
( sleep "${HOOP_START_WAIT:-4}"; kill "$pid" ) >/dev/null 2>&1 &
dog=$!
wait "$pid" 2>/dev/null
kill "$dog" 2>/dev/null
out=$(cat "$out_file" 2>/dev/null)
rm -f "$out_file"
case "$out" in
  *'"additionalContext"'*) printf '%s\n' "$out" ;;
esac
exit 0
