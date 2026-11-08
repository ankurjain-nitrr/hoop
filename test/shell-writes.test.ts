import { test } from "node:test";
import assert from "node:assert/strict";
import { shellWrites, shellWritesFile } from "../src/shell-writes.js";

// What counts as a shell write, for the gate on writes while a review waits and the eval checks
// (src/shell-writes.ts). A false positive refuses a harmless command, so text inside quotes or a
// heredoc's body counts for nothing.

const writes = (commands: string[]) => commands.filter((c) => !shellWrites(c));
const reads = (commands: string[]) => commands.filter((c) => shellWrites(c));

test("redirects, writing commands, in-place edits and scripts that write count as writes", () => {
  assert.deepEqual(
    writes([
      "echo x > a",
      "echo x >> a",
      "echo x &> a",
      "echo x 1> a",
      "echo x >| a",
      "echo x >|a",
      'echo x > "my file.txt"',
      "tee a",
      "cat a | tee -a b",
      "touch a",
      "cp a b",
      "mv a b",
      "truncate -s 0 a",
      "dd if=a of=b",
      "sed -i s/a/b/ f",
      "sed -i.bak s/a/b/ f",
      "sed -i '' 's/a/b/' f",
      "sed -Ei 's/a/b/' f",
      "sed -e 's/a/b/' -i f",
      "sed --in-place 's/a/b/' f",
      "sed --in-place=.bak 's/a/b/' f",
      "perl -pi -e 's/a/b/' f",
      "perl -i.bak -pe 's/a/b/' f",
      "python3 -c \"open('f', 'w').write('x')\"",
      "python3 - <<'EOF'\nwith open('f', 'a') as h:\n    h.write('x')\nEOF",
      "python3 -c \"import pathlib; pathlib.Path('f').write_text('x')\"",
      "node -e \"require('fs').writeFileSync('f', 'x')\"",
      "node -e \"require('fs').appendFileSync('f', 'x')\"",
      "node -e \"require('fs').appendFile('f', 'x', () => {})\"",
      "node -e \"require('fs').createWriteStream('f')\"",
      "cat > scripts/backup.sh <<'EOF'\n#!/bin/sh\nEOF",
      "git status && echo done > log.txt",
    ]),
    [],
    "each of these writes a file",
  );
});

test("reads, deletions, quoted text and heredoc bodies don't count as writes", () => {
  assert.deepEqual(
    reads([
      "rm a",
      "git status",
      "cat a 2>&1",
      "ls > /dev/null",
      "echo x >&2",
      "sed -n '/x/p' f",
      "sed 's/-i/x/' f",
      "sed -e 's/ -i / --in-place /' f",
      "perl -ne 'print if / -i/' f",
      'git commit -m "mv the files, then cp the rest > later"',
      "echo 'a > b'",
      'grep -rn "tee" src',
      "rg 'touch|cp' docs",
      "python3 - <<'EOF'\nif len(x) > 3:\n    print('more')\nEOF",
      'node -e "console.log(1 > 0)"',
      "npm test -- --test-name-pattern='cp a b'",
      "sedan --help",
      "perlite -i",
    ]),
    [],
    "none of these writes a file",
  );
});

// Regressions from #472's review: forms main caught that the first version of this missed.
test("a command right after an operator or by its full path counts", () => {
  assert.deepEqual(
    writes([
      "echo a|tee out.txt",
      "ls;touch f",
      "cd x&&cp a b",
      "cd x&&sed -i s/a/b/ f",
      "true||mv a b",
      "/bin/cp a b",
      "/usr/bin/sed -i 's/a/b/' f",
      "(cd x;touch f)",
    ]),
    [],
  );
});

test("a shell's own script counts: bash -c, sh -c and a heredoc fed to a shell", () => {
  assert.deepEqual(
    writes([
      'bash -c "echo x > f"',
      "sh -c 'cat a > b'",
      "zsh -lc 'touch f'",
      "bash -euo pipefail -c 'echo x > f'",
      "/bin/bash -c 'sed -i s/a/b/ f'",
      "bash <<'EOF'\necho x > f\nEOF",
      "sh -s <<EOF\ncp a b\nEOF",
      "bash -c 'sh -c \"echo x > f\"'",
    ]),
    [],
  );
  // A heredoc that isn't a shell's script stays text.
  assert.deepEqual(reads(["cat <<'EOF'\necho x > f\nEOF", "python3 - <<'EOF'\nprint('a > b')\nEOF", "bash -c 'echo a'"]), []);
});

test("an escaped quote outside quotes is a character, and a herestring or a quoted << isn't a heredoc", () => {
  assert.deepEqual(writes(["echo it\\'s > f", 'echo \\"x > f', "cat <<<word\necho x > f", 'echo "<<EOF"\necho x > f']), []);
  assert.equal(shellWritesFile("echo it\\'s > notes.md", "notes.md"), true);
});

test("a redirect with no space before its file names that file", () => {
  for (const c of ["echo x >notes.md", "x>notes.md", "echo x >>notes.md", "cmd 2>notes.md", "cat >notes.md <<'EOF'\nhi\nEOF", "echo x >|notes.md"])
    assert.equal(shellWritesFile(c, "notes.md"), true, c);
  assert.equal(shellWritesFile("echo x >notes.md.bak", "notes.md"), false);
});

test("a command writes a file only by naming that file, not a longer one", () => {
  assert.equal(shellWritesFile("echo x > F", "F"), true);
  assert.equal(shellWritesFile("echo x > F.bak", "F"), false, "> F.bak isn't a write to F");
  assert.equal(shellWritesFile("cp F.bak G", "F"), false, "F.bak isn't F");
  assert.equal(shellWritesFile("cat F > out.txt", "F"), false, "reading F into another file");
  assert.equal(shellWritesFile("echo x > ./src/limits.ts", "src/limits.ts"), true);
  assert.equal(shellWritesFile("echo x > src/limits.ts", "limits.ts"), true, "a path that ends with the file's");
  assert.equal(shellWritesFile("sed -i 's/a/b/' src/limits.ts", "src/limits.ts"), true);
  assert.equal(shellWritesFile("sed 's/a/b/' src/limits.ts", "src/limits.ts"), false);
  assert.equal(shellWritesFile('echo x > "src/limits.ts"', "src/limits.ts"), true, "a quoted target");
  assert.equal(shellWritesFile("echo x >| src/limits.ts", "src/limits.ts"), true);
  assert.equal(shellWritesFile("git diff src/limits.ts", "src/limits.ts"), false);
});

test("long repeated input takes linear time", () => {
  const n = 50_000;
  const inputs = [
    "sed ".repeat(n),
    `sed ${"a".repeat(n * 4)}`,
    `open(${"a".repeat(n * 4)}`,
    "open(".repeat(n),
    ">".repeat(n * 4),
    "> ".repeat(n * 2),
    '"'.repeat(n * 4),
    "'".repeat(n * 4),
    `"${"\\".repeat(n * 4)}`,
    "<<EOF\n".repeat(n),
    "a".repeat(n * 4),
    "-i ".repeat(n),
    "writeFile".repeat(n),
    "sh -a ".repeat(n),
    "bash -c '".repeat(n),
    `sh -${"c".repeat(n * 4)}`,
    `bash -${"cx".repeat(n / 2)}`,
    "sh -o pipefail ".repeat(n),
    "<<a ".repeat(n),
    "\\".repeat(n * 4),
    `bash <<EOF\n${"x\n".repeat(n)}`,
  ];
  for (const input of inputs) {
    const start = performance.now();
    shellWrites(input);
    shellWritesFile(input, "a");
    const ms = performance.now() - start;
    assert.ok(ms < 500, `${JSON.stringify(input.slice(0, 12))}… (${input.length} characters) took ${Math.round(ms)} ms`);
  }
});
