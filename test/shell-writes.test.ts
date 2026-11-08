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
  ];
  for (const input of inputs) {
    const start = performance.now();
    shellWrites(input);
    shellWritesFile(input, "a");
    const ms = performance.now() - start;
    assert.ok(ms < 500, `${JSON.stringify(input.slice(0, 12))}… (${input.length} characters) took ${Math.round(ms)} ms`);
  }
});
