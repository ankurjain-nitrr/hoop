#!/bin/sh
# Claude Code's PreToolUse hook on every tool: the Work view's gate. It stays quick: it reads the
# session's two small gate files and starts hoop only when a person's change concerns this call,
# a todo tool call while a todo change is open, or a call from an agent the gate must act on.
#
# It fails open (allows the call, silently) on any error, except for an agent a person stopped: then
# a missing hoop, a crash, a timeout or an answer that isn't a decision all refuse the call (exit 2),
# so a stopped agent never runs on silently.
input=$(cat)
# The session: the first "session_id", since Claude Code writes it first, before the tool's input.
# JSON inside strings has escaped quotes, so it can't match.
session=$(printf '%s' "$input" | grep -o '"session_id" *: *"[A-Za-z0-9_-]\{1,128\}"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$session" ] || exit 0
dir="${HOOP_HOME:-$HOME/.hoop}/work"
[ -e "$dir/$session.gate" ] || [ -e "$dir/$session.agents" ] || exit 0

stop=
by=
need=
# Every "agent_id" in the input: the top-level one is among them wherever Claude Code puts it, and
# hoop tells it from one inside the tool's input.
agents=$(printf '%s' "$input" | grep -o '"agent_id" *: *"[A-Za-z0-9_-]\{1,128\}"' | sed 's/.*"\([^"]*\)"$/\1/')
if [ -n "$agents" ] && [ -e "$dir/$session.agents" ]; then
  for agent in $agents; do
    if [ -r "$dir/$session.agents" ]; then
      line=$(grep "^$agent	" "$dir/$session.agents" | head -n 1)
    else
      line="$agent	stop	"
    fi
    [ -n "$line" ] || continue
    need=1
    case "$line" in *'	stop	'*) stop=1 by=$(printf '%s' "$line" | cut -f3) ;; esac
  done
fi
if [ -z "$need" ] && [ -e "$dir/$session.gate" ]; then
  case "$input" in
    *'"tool_name":"TaskUpdate"'* | *'"tool_name": "TaskUpdate"'* | *'"tool_name":"TodoWrite"'* | *'"tool_name": "TodoWrite"'*) need=1 ;;
  esac
fi
[ -n "$need" ] || exit 0

fail() {
  [ -n "$stop" ] || exit 0
  echo "Stopped by ${by:-a person} in hoop's Work view ($1). Don't call any more tools: end your turn now and say what you finished." >&2
  exit 2
}
. "$(dirname "$0")/hoop.sh"
[ -n "$HOOP" ] || fail "hoop isn't on PATH"
command -v "$HOOP" >/dev/null 2>&1 || command -v "${HOOP%% *}" >/dev/null 2>&1 || fail "$HOOP isn't on PATH"
# Claude Code lets the call go on when a hook times out, so hoop gets less time than the hook has.
if command -v perl >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  out=$(printf '%s' "$input" | perl -e 'alarm shift; exec @ARGV' "${HOOP_GATE_ALARM:-20}" $HOOP work-gate 2>/dev/null)
else
  # shellcheck disable=SC2086
  out=$(printf '%s' "$input" | $HOOP work-gate 2>/dev/null)
fi
code=$?
[ "$code" -eq 0 ] || fail "hoop work-gate failed"
case "$out" in
  *'"permissionDecision"'*) printf '%s\n' "$out" ;;
  '{}') ;;
  *) fail "hoop work-gate gave no decision" ;;
esac
exit 0
