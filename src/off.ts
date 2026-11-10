import { readFileSync } from "node:fs";
import { join } from "node:path";

// hoop's off list: the file `off` in hoop's home, one switch name per line, which the person writes
// and hoop only reads. A line names a switch when it holds that name alone, with spaces, tabs and a
// Windows line end around it; any other line, such as a `#` comment, names nothing. The plugin's
// hooks read it the same way (plugins/hoop/scripts/off.sh). The pages process reads `messages`
// (no messages into a session) and `mermaid` (diagrams show their source, with no library loaded).

/** Whether hoop's off list in `home` names the part `name`. */
export function isOff(home: string, name: string): boolean {
  let text: string;
  try {
    text = readFileSync(join(home, "off"), "utf8");
  } catch {
    return false;
  }
  return text.split("\n").some((line) => line.trim() === name);
}
