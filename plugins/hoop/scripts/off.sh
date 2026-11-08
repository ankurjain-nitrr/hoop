# Sourced by the plugin's hooks: `hoop_off NAME` is true when hoop's off list names the part NAME. The
# list is the file `off` in hoop's home (~/.hoop, or $HOOP_HOME): one switch name per line, spaces,
# tabs and a Windows line end around it allowed; any other line, such as a `#` comment, names
# nothing. The person writes the file and hoop only reads it. A plain list, not JSON, so a shell reads
# it exactly with grep; a hook that is off exits at once, without starting hoop or node.
hoop_off() {
  grep -qxE "[[:space:]]*$1[[:space:]]*" "${HOOP_HOME:-$HOME/.hoop}/off" 2>/dev/null
}
