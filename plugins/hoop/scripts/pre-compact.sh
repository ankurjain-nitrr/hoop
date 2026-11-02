#!/bin/sh
# Claude Code's PreCompact hook, run before a compaction: hoop saves what is open for the session
# (its open reviews and quick questions, and its queue), so the SessionStart hook after the
# compaction lists them. The pages process writes the snapshot; when none answers, hoop drops it.
#
# It never blocks the compaction: any error, a missing hoop or hoop folder, or an answer that takes
# more than a few seconds prints nothing. It always exits 0.
input=$(cat)
case "$input" in
  *'"hook_event_name":"PreCompact"'* | *'"hook_event_name": "PreCompact"'*) ;;
  *) exit 0 ;;
esac
[ -d "${HOOP_HOME:-$HOME/.hoop}" ] || exit 0

. "$(dirname "$0")/hoop.sh"
[ -n "$HOOP" ] || exit 0
command -v "$HOOP" >/dev/null 2>&1 || command -v "${HOOP%% *}" >/dev/null 2>&1 || exit 0
# hoop gives up on the pages process after 2 s; a watchdog stops it after HOOP_COMPACT_WAIT seconds
# (4), so a slow start (npx) never holds the compaction. Plain POSIX sh: no perl.
# shellcheck disable=SC2086
printf '%s' "$input" | $HOOP pre-compact >/dev/null 2>&1 &
pid=$!
( sleep "${HOOP_COMPACT_WAIT:-4}"; kill "$pid" ) >/dev/null 2>&1 &
dog=$!
wait "$pid" 2>/dev/null
kill "$dog" 2>/dev/null
exit 0
