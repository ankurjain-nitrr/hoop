#!/bin/sh
# Claude Code's PermissionRequest hook: answers a permission prompt from hoop's pages too, while the
# person has turned that on (a line permission_prompts in hoop's on list, ~/.hoop/on, which hoop
# init writes after a yes). The terminal still asks, and the first answer wins: Allow once or Deny
# on a page becomes this hook's decision; an answer in the terminal ends it with none.
#
# Off (the default), it exits at once without starting hoop or node. It fails open to the terminal:
# a missing hoop, no pages process, a crash or the alarm print nothing, so the terminal's prompt
# decides. It never decides by itself.
input=$(cat)
grep -qxE "[[:space:]]*permission_prompts[[:space:]]*" "${HOOP_HOME:-$HOME/.hoop}/on" 2>/dev/null || exit 0

. "$(dirname "$0")/hoop.sh"
[ -n "$HOOP" ] || exit 0
command -v "$HOOP" >/dev/null 2>&1 || command -v "${HOOP%% *}" >/dev/null 2>&1 || exit 0
# Claude Code ends the hook at its 600 s timeout; hoop hands the prompt to the terminal before that.
if command -v perl >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  out=$(printf '%s' "$input" | perl -e 'alarm shift; exec @ARGV' "${HOOP_PERMISSION_ALARM:-590}" $HOOP permission-hook 2>/dev/null)
else
  # shellcheck disable=SC2086
  out=$(printf '%s' "$input" | $HOOP permission-hook 2>/dev/null)
fi
case "$out" in
  *'"hookEventName":"PermissionRequest"'*) printf '%s\n' "$out" ;;
esac
exit 0
