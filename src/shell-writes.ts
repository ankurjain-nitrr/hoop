// Which tool calls change files: the file tools, and shell commands that write, as far as a command's
// text shows. The eval checks (scripts/evals/checks.ts) and the gate on writes while a review waits
// (src/review-gate.ts) read the same rules, so a false positive here refuses a harmless command: what
// sits inside quotes or a heredoc's body (a message, a sed script, a script's comparisons) is text,
// not a redirect or a command, unless a shell runs it (`bash -c '…'`, `sh <<EOF`), when it is read
// as a command too. Every step runs in linear time on any input.

/** Claude Code's tools that write or edit a file. */
export const FILE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

// A shell redirect (`>`, `>>`, `>|`, `1>`, `&>`) and its target; one to `&N` or /dev/null writes no file.
const REDIRECT = /(?:\d|&)?(?:>>|>\|?)[ \t]*(&\d+|[^\s;&|<>]+)/g;
/** What may come right before a command's name: the start, a space, an operator, or a path's `/`. */
const START = "(?:^|[\\s(`|;&/\\\\])";
/** A command that writes the files it names. `rm` doesn't count: deleting a file isn't writing one. */
const WRITER = new RegExp(`${START}(?:tee|touch|cp|mv|truncate|dd)(?=$|[\\s)\`|;&])`);
/** sed or perl, and the arguments after it up to the end of its command. */
const SED_OR_PERL = new RegExp(`${START}(?:sed|perl)(?=\\s)([^|;&\\n]*)`, "g");
/** An in-place flag: `-i`, `-i.bak`, `-Ei`, `-pi`, `--in-place`, `--in-place=.bak`. */
const IN_PLACE = /(?:^|\s)(?:-[a-zA-Z]*i|--in-place)(?=$|[\s=.'"_])/;
/** A script (a python or node heredoc, `-c`, `-e`) that opens a file to write or append, or writes one. */
const SCRIPT_WRITES = /\bopen\([^)]{0,200}?['"][wax]\+?b?['"]|\b(?:writeFile|appendFile)(?:Sync)?\(|\bcreateWriteStream\(|\.write_(?:text|bytes)\(/;
/** A shell that runs a script it is given: bash, sh or zsh. */
const SHELL = `${START}(?:ba|z)?sh`;
/**
 * A shell's `-c` and the quote its script starts with (in the masked text), after at most four other
 * flags, each with a word of its own as `-o pipefail` has. The flag's letters before its `c` hold no
 * `c`, so a run of them can't split many ways.
 */
const SHELL_C = new RegExp(`${SHELL}(?:\\s+-[a-zA-Z]+(?:\\s+[a-z]+)?){0,4}?\\s+-[abd-zA-Z]*c[a-zA-Z]*\\s+(['"])`, "g");
/** A line that feeds a heredoc to a shell, up to its `<<`. */
const SHELL_FEED = new RegExp(`${SHELL}(?:\\s+-[a-zA-Z]+)*\\s*$`);
/** A heredoc's end word after `<<` or `<<-`, bare or quoted. */
const DELIMITER = /^(['"]?)([A-Za-z_][\w-]{0,63})\1/;
/** How deep a shell's script inside a shell's script is read. */
const DEPTH = 2;

type Heredoc = { end: string; tabs: boolean; shell: boolean; body: string[] };
/** A command as the shell reads it, and the scripts in it a shell runs. */
type Read = { masked: string; scripts: string[] };

/**
 * Reads a command left to right as the shell does: a backslash escapes the next character, quotes
 * hold text, and a heredoc's body runs from the line after its `<<` to its end word. The masked text
 * keeps every position, with each escaped character, each quoted string's inside and each heredoc
 * body replaced, so a redirect's target can be read back from the command itself.
 */
function read(command: string): Read {
  const r: Reading = { out: [], tail: "", pending: [], scripts: [] };
  for (let i = 0; i < command.length; ) i = step(command, i, r);
  const masked = r.out.join("");
  return { masked, scripts: [...r.scripts, ...shellC(command, masked)] };
}

/** The masked text so far, the start of its line, the heredocs that line started, and the scripts found. */
type Reading = { out: string[]; tail: string; pending: Heredoc[]; scripts: string[] };

/** Adds masked text, keeping the last characters of its line: only they can say a shell is fed. */
function add(r: Reading, piece: string) {
  r.out.push(piece);
  const nl = piece.lastIndexOf("\n");
  r.tail = (nl < 0 ? r.tail + piece : piece.slice(nl + 1)).slice(-200);
}

/** Reads what starts at `i`, adding it masked to `r`; gives where to go on. */
function step(command: string, i: number, r: Reading): number {
  const c = command[i]!;
  if (c === "\\") {
    add(r, command[i + 1] === undefined ? "_" : "__");
    return i + 2;
  }
  if (c === "'" || c === '"') {
    const end = closing(command, i);
    add(r, c + "_".repeat(Math.max(0, end - i - 1)) + (end < command.length ? c : ""));
    return end + 1;
  }
  if (c === "<" && command[i + 1] === "<" && command[i - 1] !== "<" && command[i + 2] !== "<") {
    const h = heredoc(command, i, r.tail);
    if (h) r.pending.push(h);
    add(r, "<<");
    return i + 2;
  }
  add(r, c);
  return c === "\n" && r.pending.length ? bodies(command, i + 1, r) : i + 1;
}

/** Where the quote that opens at `at` closes: its index, or the end of the command when it doesn't. */
function closing(command: string, at: number): number {
  const q = command[at];
  let j = at + 1;
  while (j < command.length && command[j] !== q) j += q === '"' && command[j] === "\\" ? 2 : 1;
  return Math.min(j, command.length);
}

/** The heredoc that starts at `at` (its `<<`), with whether the line before it (`line`) feeds it to a shell. */
function heredoc(command: string, at: number, line: string): Heredoc | undefined {
  const tabs = command[at + 2] === "-";
  const rest = command.slice(at + (tabs ? 3 : 2), at + 80).replace(/^[ \t]*/, "");
  const word = DELIMITER.exec(rest)?.[2];
  return word ? { end: word, tabs, shell: SHELL_FEED.test(line), body: [] } : undefined;
}

/**
 * Reads the bodies of the heredocs the line before `from` started, blanking them, and keeps those a
 * shell runs as scripts; gives where the command goes on.
 */
function bodies(command: string, from: number, r: Reading): number {
  let i = from;
  for (const h of r.pending) {
    i = body(command, i, h, r);
    if (h.shell) r.scripts.push(h.body.join("\n"));
  }
  r.pending = [];
  return Math.min(i, command.length);
}

/** Reads one heredoc's body from `from` up to its end line, blanking it; gives where it ends. */
function body(command: string, from: number, h: Heredoc, r: Reading): number {
  let i = from;
  while (i < command.length) {
    const nl = command.indexOf("\n", i);
    const stop = nl < 0 ? command.length : nl;
    const line = command.slice(i, stop);
    add(r, " ".repeat(line.length) + (nl < 0 ? "" : "\n"));
    i = stop + 1;
    if ((h.tabs ? line.replace(/^\t+/, "") : line).trim() === h.end) return i;
    h.body.push(line);
  }
  return i;
}

/** The scripts given to a shell's `-c` in quotes, read back from the command. */
function shellC(command: string, masked: string): string[] {
  return [...masked.matchAll(SHELL_C)].map((m) => {
    const open = m.index + m[0].length - 1;
    const end = closing(command, open);
    const text = command.slice(open + 1, end);
    return m[1] === '"' ? text.replace(/\\(["\\$`])/g, "$1") : text;
  });
}

/** The files a shell command redirects into: not `&N` or /dev/null, with a quoted name unquoted. */
function redirected(command: string, masked: string): string[] {
  return [...masked.matchAll(REDIRECT)].flatMap((m) => {
    const at = m.index + m[0].length - m[1]!.length;
    const to = command.slice(at, at + m[1]!.length).replace(/^(['"])(.*)\1$/, "$2");
    return to && !to.startsWith("&") && to !== "/dev/null" ? [to] : [];
  });
}

/** Whether a command, as `read` masks it, runs sed or perl in place. */
const inPlace = (masked: string) => [...masked.matchAll(SED_OR_PERL)].some((m) => IN_PLACE.test(m[1]!));

/** What a command writes: the files it redirects into, and whether it runs something that writes; with the scripts a shell runs in it. */
function writes(command: string, depth = 0): { to: string[]; writer: boolean } {
  const { masked, scripts } = read(command);
  const own = { to: redirected(command, masked), writer: WRITER.test(masked) || inPlace(masked) || SCRIPT_WRITES.test(command) };
  if (depth >= DEPTH) return own;
  for (const s of scripts) {
    const inner = writes(s, depth + 1);
    own.to.push(...inner.to);
    own.writer ||= inner.writer;
  }
  return own;
}

/** Whether the path `to` names `file`: the same path, or one ends with the other after a `/`. */
const samePath = (to: string, file: string) => to === file || to.endsWith(`/${file}`) || file.endsWith(`/${to}`);

/** Whether `file` appears in a command as a whole path, not as part of a longer name (`F.bak` isn't `F`). */
function names(command: string, file: string): boolean {
  for (let i = command.indexOf(file); i >= 0; i = command.indexOf(file, i + 1)) {
    const before = command[i - 1],
      after = command[i + file.length];
    if ((before === undefined || /[\s'"=/(`>|]/.test(before)) && (after === undefined || /[\s'";&|)`<>]/.test(after))) return true;
  }
  return false;
}

/** Whether a shell command writes `file`: a redirect to it, or a writing command that names it. */
export function shellWritesFile(command: string, file: string): boolean {
  if (!names(command, file)) return false;
  const w = writes(command);
  return w.to.some((to) => samePath(to, file)) || w.writer;
}

/** Whether a shell command writes any file, as far as its text shows. */
export function shellWrites(command: string): boolean {
  const w = writes(command);
  return w.to.length > 0 || w.writer;
}

/** Whether a tool call changes a file: a file tool, or a Bash command that writes. */
export const writesFiles = (tool: unknown, input: Record<string, unknown>) =>
  (typeof tool === "string" && FILE_TOOLS.includes(tool)) || (tool === "Bash" && shellWrites(String(input.command ?? "")));
