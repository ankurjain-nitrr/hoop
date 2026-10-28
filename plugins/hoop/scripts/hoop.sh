# Sourced by the plugin's scripts: sets HOOP to the command that runs hoop. That is $HOOP_BIN when
# set, else the `hoop` on PATH, else the hoop package through npx, so the plugin works without a
# global install. HOOP_VIA_NPX is 1 in the npx case, and empty when neither hoop nor npx is found.
#
# HOOP_PLUGIN_VERSION is this plugin's version, from its plugin.json beside the scripts, which hoop
# records with each hook's stamp, so the Work page can tell a plugin too old to stamp every turn.
#
# HOOP_PACKAGE is the npx package spec for every part of the plugin: an exact published version, so
# a new release reaches people only through a new plugin version.
HOOP_PACKAGE="@ankurjain-nitrr/hoop@0.2.0"
HOOP_PLUGIN_VERSION=$(sed -n 's/^ *"version" *: *"\([0-9A-Za-z.+-]*\)".*/\1/p' "$(dirname "$0")/../.claude-plugin/plugin.json" 2>/dev/null | head -n 1)
export HOOP_PLUGIN_VERSION
HOOP_VIA_NPX=
if [ -n "${HOOP_BIN:-}" ]; then
  HOOP="$HOOP_BIN"
elif command -v hoop >/dev/null 2>&1; then
  HOOP=hoop
elif command -v npx >/dev/null 2>&1; then
  HOOP="npx -y $HOOP_PACKAGE"
  HOOP_VIA_NPX=1
else
  HOOP=
fi
