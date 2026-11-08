# Sourced by the plugin's hooks: `hoop_off NAME` is true when hoop's settings turn the part NAME off,
# with `"NAME": false` in settings.json under hoop's home (~/.hoop, or $HOOP_HOME). The person writes
# that file; hoop only reads it. A hook that is off exits at once, without starting hoop or node.
hoop_off() {
  grep -q "\"$1\" *: *false" "${HOOP_HOME:-$HOME/.hoop}/settings.json" 2>/dev/null
}
