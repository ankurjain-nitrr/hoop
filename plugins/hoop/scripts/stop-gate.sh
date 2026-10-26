#!/bin/sh
# Claude Code's Stop hook, run before a turn ends: hoop's Stop gate. It blocks the end of a turn once
# per cause, for feedback that came during the turn unread: a review, a quick question's answer or a
# Work change. It stays quick: it starts hoop only while the session's `.stop` file exists (a Work
# change the gate hasn't told) or one of its reviews has feedback newer than its receipts.
#
# It fails open: any error, a missing hoop, no pages process or an answer that takes more than a few
# seconds lets the turn end. It always exits 0, and never runs for a subagent's stop or for a stop the
# gate already blocked (`stop_hook_active`).
input=$(cat)
case "$input" in
  *'"hook_event_name":"Stop"'* | *'"hook_event_name": "Stop"'*) ;;
  *) exit 0 ;;
esac
case "$input" in
  *'"stop_hook_active":true'* | *'"stop_hook_active": true'*) exit 0 ;;
esac
# The session: the first "session_id", since Claude Code writes it first.
session=$(printf '%s' "$input" | grep -o '"session_id" *: *"[A-Za-z0-9_-]\{1,128\}"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$session" ] || exit 0

need=
[ -e "${HOOP_HOME:-$HOME/.hoop}/work/$session.stop" ] && need=1
if [ -z "$need" ]; then
  # The session's reviews sit in `.hoop` beside its transcript: <folder>/<session>.jsonl, <folder>/<session>/.hoop.
  transcript=$(printf '%s' "$input" | grep -o '"transcript_path" *: *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
  reviews="${transcript%.jsonl}/.hoop/reviews"
  if [ -n "$transcript" ] && [ -d "$reviews" ]; then
    for r in "$reviews"/rv_*; do
      [ -d "$r" ] || continue
      if [ -e "$r/receipts.json" ]; then
        [ -n "$(find "$r" -name 'feedback-*.json' -newer "$r/receipts.json" 2>/dev/null | head -n 1)" ] && need=1
      else
        for f in "$r"/feedback-*.json; do
          [ -e "$f" ] && need=1
          break
        done
      fi
      [ -n "$need" ] && break
    done
  fi
fi
[ -n "$need" ] || exit 0

. "$(dirname "$0")/hoop.sh"
[ -n "$HOOP" ] || exit 0
command -v "$HOOP" >/dev/null 2>&1 || command -v "${HOOP%% *}" >/dev/null 2>&1 || exit 0
# hoop gives up on the pages process after 2 s. It runs in the background, writing to a file, and a
# watchdog stops it after HOOP_STOP_WAIT seconds (4), so a slow start (npx) or a child it leaves
# behind never holds the hook past its timeout. Plain POSIX sh: no perl, no timeout.
out_file=$(mktemp 2>/dev/null) || exit 0
# shellcheck disable=SC2086
printf '%s' "$input" | $HOOP stop-gate >"$out_file" 2>/dev/null &
pid=$!
( sleep "${HOOP_STOP_WAIT:-4}"; kill "$pid" ) >/dev/null 2>&1 &
dog=$!
wait "$pid" 2>/dev/null
kill "$dog" 2>/dev/null
out=$(cat "$out_file" 2>/dev/null)
rm -f "$out_file"
case "$out" in
  *'"decision":"block"'*) printf '%s\n' "$out" ;;
esac
exit 0
