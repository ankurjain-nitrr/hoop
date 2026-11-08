// Which tool calls change files: the file tools, and shell commands that write, as far as a command's
// text shows. The eval checks (scripts/evals/checks.ts) and the gate on writes while a review waits
// (src/review-gate.ts) read the same rules.

/** Claude Code's tools that write or edit a file. */
export const FILE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

// A shell redirect (`>`, `>>`, `1>`, `&>`) and its target; one to `&N` or /dev/null writes no file.
const REDIRECT = /(?:\d|&)?>>?\s*(&\d+|[^\s;&|<>]+)/g;
// A shell command that writes the files it names: tee, touch, cp, mv, truncate, dd, sed or perl in
// place (`sed -i`, `sed -Ei`, `sed -e … -i`, `perl -pi`), or a script (a python or node heredoc) that
// opens a file to write or append, or calls writeFile. `rm` deliberately doesn't count: deleting a
// file isn't writing one.
const SHELL_WRITES = /\b(tee|touch|cp|mv|truncate|dd)\b|\b(sed|perl)\b[^|;&]*\s-[a-zA-Z]*i|\bopen\([^)]*['"][wa]\+?['"]|\bwriteFile(Sync)?\b|\bwrite_text\(/;

/** The files a shell command redirects into: not `&N` or /dev/null. */
const redirected = (command: string) => [...command.matchAll(REDIRECT)].flatMap(([, to]) => (to && !to.startsWith("&") && to !== "/dev/null" ? [to] : []));

/** Whether a shell command writes `file`: a redirect to it, or a writing command that names it. */
export function shellWritesFile(command: string, file: string): boolean {
  if (!command.includes(file)) return false;
  return redirected(command).some((to) => to.includes(file)) || SHELL_WRITES.test(command);
}

/** Whether a shell command writes any file, as far as its text shows. */
export const shellWrites = (command: string) => redirected(command).length > 0 || SHELL_WRITES.test(command);

/** Whether a tool call changes a file: a file tool, or a Bash command that writes. */
export const writesFiles = (tool: unknown, input: Record<string, unknown>) =>
  (typeof tool === "string" && FILE_TOOLS.includes(tool)) || (tool === "Bash" && shellWrites(String(input.command ?? "")));
