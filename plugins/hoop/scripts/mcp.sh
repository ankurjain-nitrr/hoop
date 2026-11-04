#!/bin/sh
# Starts hoop's MCP server on stdio for the plugin, with the same hoop the hooks run.
. "$(dirname "$0")/hoop.sh"
if [ -z "$HOOP" ]; then
  # On a Node.js too old, hoop.sh has said what to install.
  [ -n "$HOOP_OLD_NODE" ] && exit 1
  echo "hoop: neither hoop nor npx is on PATH; install Node 22.12 or later." >&2
  exit 1
fi
# shellcheck disable=SC2086
exec $HOOP mcp
