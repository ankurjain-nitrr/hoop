// Which tool calls change files: the file tools, and shell commands that write, as far as a command's
// text shows. The eval checks (scripts/evals/checks.ts) and the gate on writes while a review waits
// (src/review-gate.ts) read the same rules, so a false positive here refuses a harmless command: what
// sits inside quotes or a heredoc's body (a message, a sed script, a script's comparisons) is text,
// not a redirect or a command. Every pattern runs in linear time on any input.

/** Claude Code's tools that write or edit a file. */
export const FILE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/** A quoted string, single or double (with its escapes); an unclosed quote runs to the end. */
const QUOTED = /'[^']*(?:'|$)|"(?:[^"\\]|\\[\s\S])*(?:"|$)/g;
// A shell redirect (`>`, `>>`, `>|`, `1>`, `&>`) and its target; one to `&N` or /dev/null writes no file.
const REDIRECT = /(?:\d|&)?(?:>>|>\|?)[ \t]*(&\d+|[^\s;&|<>]+)/g;
/** A command that writes the files it names. `rm` doesn't count: deleting a file isn't writing one. */
const WRITER = /(?:^|[\s(`])(?:tee|touch|cp|mv|truncate|dd)(?=$|[\s)`])/;
/** sed or perl, and the arguments after it up to the end of its command. */
const SED_OR_PERL = /(?:^|[\s(`])(?:sed|perl)(?=\s)([^|;&\n]*)/g;
/** An in-place flag: `-i`, `-i.bak`, `-Ei`, `-pi`, `--in-place`, `--in-place=.bak`. */
const IN_PLACE = /(?:^|\s)(?:-[a-zA-Z]*i|--in-place)(?=$|[\s=.'"_])/;
/** A script (a python or node heredoc, `-c`, `-e`) that opens a file to write or append, or writes one. */
const SCRIPT_WRITES = /\bopen\([^)]{0,200}?['"][wax]\+?b?['"]|\b(?:writeFile|appendFile)(?:Sync)?\(|\bcreateWriteStream\(|\.write_(?:text|bytes)\(/;
/** A heredoc's start, `<<EOF`, `<<-'EOF'` or `<<"EOF"`, naming its end line. */
const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][\w-]{0,63})\1/;

/**
 * The command as the shell reads it for redirects and command names: each heredoc's body dropped,
 * and each quoted string's inside replaced by `_`, keeping every position, so a redirect's target
 * can be read back from the command itself.
 */
function bare(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    kept.push(line);
    const end = HEREDOC.exec(line)?.[2];
    if (!end) continue;
    // The body, up to its end line, becomes blank lines.
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== end) kept.push(" ".repeat(lines[++i]!.length));
  }
  return kept.join("\n").replace(QUOTED, (q) => q[0] + "_".repeat(Math.max(0, q.length - 2)) + (q.length > 1 ? q.at(-1) : ""));
}

/** The files a shell command redirects into: not `&N` or /dev/null, with a quoted name unquoted. */
function redirected(command: string, masked: string): string[] {
  return [...masked.matchAll(REDIRECT)].flatMap((m) => {
    const at = m.index + m[0].length - m[1]!.length;
    const to = command.slice(at, at + m[1]!.length).replace(/^(['"])(.*)\1$/, "$2");
    return to && !to.startsWith("&") && to !== "/dev/null" ? [to] : [];
  });
}

/** Whether a command, as `bare` gives it, runs sed or perl in place. */
const inPlace = (masked: string) => [...masked.matchAll(SED_OR_PERL)].some((m) => IN_PLACE.test(m[1]!));

/** Whether a command runs something that writes, besides a redirect. */
const writer = (command: string, masked: string) => WRITER.test(masked) || inPlace(masked) || SCRIPT_WRITES.test(command);

/** Whether the path `to` names `file`: the same path, or one ends with the other after a `/`. */
const samePath = (to: string, file: string) => to === file || to.endsWith(`/${file}`) || file.endsWith(`/${to}`);

/** Whether `file` appears in a command as a whole path, not as part of a longer name (`F.bak` isn't `F`). */
function names(command: string, file: string): boolean {
  for (let i = command.indexOf(file); i >= 0; i = command.indexOf(file, i + 1)) {
    const before = command[i - 1],
      after = command[i + file.length];
    if ((before === undefined || /[\s'"=/(`]/.test(before)) && (after === undefined || /[\s'";&|)`]/.test(after))) return true;
  }
  return false;
}

/** Whether a shell command writes `file`: a redirect to it, or a writing command that names it. */
export function shellWritesFile(command: string, file: string): boolean {
  if (!names(command, file)) return false;
  const masked = bare(command);
  return redirected(command, masked).some((to) => samePath(to, file)) || writer(command, masked);
}

/** Whether a shell command writes any file, as far as its text shows. */
export function shellWrites(command: string): boolean {
  const masked = bare(command);
  return redirected(command, masked).length > 0 || writer(command, masked);
}

/** Whether a tool call changes a file: a file tool, or a Bash command that writes. */
export const writesFiles = (tool: unknown, input: Record<string, unknown>) =>
  (typeof tool === "string" && FILE_TOOLS.includes(tool)) || (tool === "Bash" && shellWrites(String(input.command ?? "")));
