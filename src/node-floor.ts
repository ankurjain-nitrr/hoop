// The oldest Node.js hoop runs on, which the `hoop` command (src/bin.ts) checks before anything else
// loads. The plugin's scripts check it too, in plugins/hoop/scripts/hoop.sh, and write the same line.
// This module and src/bin.ts keep to syntax and APIs that every Node.js with ES modules has, so an
// old Node.js reaches the check instead of failing first on something newer.

/** The oldest Node.js hoop runs on, as major and minor. */
const NODE_FLOOR = [22, 12];

/** What to tell the person when `version` (as `process.versions.node` has it) is older than the floor; undefined when it isn't. */
export function nodeTooOld(version: string): string | undefined {
  const parts = String(version).replace(/^v/, "").split(".");
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (!(major >= 0) || !(minor >= 0)) return undefined;
  if (major > NODE_FLOOR[0]! || (major === NODE_FLOOR[0] && minor >= NODE_FLOOR[1]!)) return undefined;
  return (
    "hoop needs Node.js 22.12 or later, and this is Node.js " +
    parts.join(".") +
    ". Install Node.js 22 or later from https://nodejs.org (or run nvm install 22), then try again."
  );
}
