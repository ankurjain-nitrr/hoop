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

# The `hoop` on PATH and npx both run on the `node` on PATH. Older than hoop's floor
# (src/node-floor.ts, which writes the same line), the script says what to install, once, on
# stderr, and HOOP is empty, as when hoop isn't found; HOOP_OLD_NODE is then 1. $HOOP_BIN names its
# own command, so it isn't checked, and neither is a PATH with no node.
HOOP_OLD_NODE=
if [ -z "${HOOP_BIN:-}" ] && [ -n "$HOOP" ]; then
  node_version=$(node -p process.versions.node 2>/dev/null)
  node_major=${node_version%%.*}
  node_minor=${node_version#*.}
  node_minor=${node_minor%%.*}
  case "$node_major.$node_minor" in
    *[!0-9.]* | .* | *.) ;;
    *)
      if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 12 ]; }; then
        echo "hoop needs Node.js 22.12 or later, and this is Node.js $node_version. Install Node.js 22 or later from https://nodejs.org (or run nvm install 22), then try again." >&2
        HOOP=
        HOOP_VIA_NPX=
        HOOP_OLD_NODE=1
      fi
      ;;
  esac
fi
