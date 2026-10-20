import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowed, parseFindings, repoCommand, runCheck } from "../src/checks.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** A repository whose check command runs `script` with Node, and a hoop folder that allows it or not. */
function setup(script: string, allow = true) {
  const repo = tmp("hoop-check-repo-"),
    home = tmp("hoop-check-home-");
  writeFileSync(join(repo, "check.mjs"), script);
  const command = [process.execPath, "check.mjs"];
  writeFileSync(join(repo, "hoop.config.json"), JSON.stringify({ check: command }));
  if (allow) writeFileSync(join(home, "config.json"), JSON.stringify({ checks: [{ repo, command }] }));
  return { repo, home, command };
}

const REPORTER = `import { readFileSync } from "node:fs";
const file = process.argv[2];
const lines = readFileSync(file, "utf8").split("\\n");
let n = 0;
lines.forEach((l, i) => { if (l.includes("—")) { console.log(file + ":" + (i + 1) + ": uses a dash between words"); console.log("    " + l); n++; } });
if (n) { console.log(""); console.log(n + " finding(s)."); }
process.exit(n ? 1 : 0);
`;

test("FR-1, FR-4: an allowed command runs on the document; exit 0 gives no findings, exit 1 gives findings", async () => {
  const { repo, home, command } = setup(REPORTER);
  const clean = await runCheck(repo, "# Doc\n\nAll good.\n", home);
  assert.equal(clean?.ran, true);
  assert.deepEqual(clean?.findings, []);
  assert.deepEqual(clean?.command, command);
  const found = await runCheck(repo, "# Doc\n\nGood — mostly.\n\nFine.\n\nBad — again.\n", home);
  assert.equal(found?.ran, true);
  assert.deepEqual(
    found?.findings.map((f) => [f.line, f.message]),
    [
      [3, "uses a dash between words"],
      [7, "uses a dash between words"],
    ],
  );
  assert.ok(typeof found?.ms === "number");
});

test("FR-2: a command runs only when the user's own config allows exactly it for this folder", async () => {
  const none = setup(REPORTER, false);
  const out = await runCheck(none.repo, "x — y\n", none.home);
  assert.equal(out?.ran, false);
  assert.equal(out?.reason, "not_allowed", "no user config at all still says how to allow it");
  assert.deepEqual(out?.allow?.command, none.command);
  assert.match(out!.message!, /Ask the user to add this entry/);

  // Regression guard: a pull that changes the command must not run the new one.
  const { repo, home } = setup(REPORTER);
  writeFileSync(join(repo, "hoop.config.json"), JSON.stringify({ check: [process.execPath, "other.mjs"] }));
  assert.equal((await runCheck(repo, "x\n", home))?.reason, "not_allowed");

  // The folder matches by real path, so a symlink to the repository is the same folder.
  const ok = setup(REPORTER);
  const link = join(tmp("hoop-check-link-"), "repo");
  symlinkSync(ok.repo, link);
  assert.equal(isAllowed(link, ok.command, ok.home), true);
  assert.equal(isAllowed(ok.repo, [...ok.command, "--extra"], ok.home), false);
});

test("FR-4: a missing command, another exit code or a timeout means the check didn't run", async () => {
  const missing = setup("");
  const cmd = ["/no/such/checker"];
  writeFileSync(join(missing.repo, "hoop.config.json"), JSON.stringify({ check: cmd }));
  writeFileSync(join(missing.home, "config.json"), JSON.stringify({ checks: [{ repo: missing.repo, command: cmd }] }));
  const a = await runCheck(missing.repo, "x\n", missing.home);
  assert.deepEqual([a?.ran, a?.reason], [false, "failed"]);
  assert.match(a!.message!, /couldn't start/);

  const crash = setup(`console.error("boom"); process.exit(3);`);
  const b = await runCheck(crash.repo, "x\n", crash.home);
  assert.deepEqual([b?.ran, b?.reason], [false, "failed"]);
  assert.match(b!.message!, /exited with code 3\. boom/);

  const slow = setup(`setTimeout(() => process.exit(0), 5000);`);
  const c = await runCheck(slow.repo, "x\n", slow.home, { timeoutMs: 300 });
  assert.deepEqual([c?.ran, c?.reason], [false, "timeout"]);
});

test("FR-5: only path:line: message lines become findings, read from devloop's real checker output", () => {
  const output = readFileSync(new URL("./fixtures/writing-check-output.txt", import.meta.url), "utf8");
  const findings = parseFindings(output, 1);
  assert.deepEqual(
    findings.map((f) => f.line),
    [3, 5, 5, 8],
  );
  assert.ok(
    findings.every((f) => !f.message.startsWith(" ") && !/finding\(s\)/.test(f.message)),
    "snippet and summary lines are ignored",
  );
  assert.equal(findings[0]!.message, "uses a dash between words; use a period, comma, colon or parentheses");
  assert.deepEqual(parseFindings("Something went wrong\nmore\n", 1), [{ message: "Something went wrong" }]);
  assert.deepEqual(parseFindings("all clear\n", 0), []);
});

test("FR-7: a repository without a command, or with a malformed one, checks nothing", async () => {
  const repo = tmp("hoop-check-none-"),
    home = tmp("hoop-check-home-");
  assert.equal(await runCheck(repo, "x\n", home), undefined);
  writeFileSync(join(repo, "hoop.config.json"), JSON.stringify({ check: "python3 check.py" }));
  assert.equal(repoCommand(repo), undefined, "a command must be a list of arguments");
  assert.equal(await runCheck(repo, "x\n", home), undefined);
});

test("review fixes: a checker that ignores SIGTERM, a bad argument or a broken temp folder never hangs or throws", async () => {
  // Regression: the timeout only sent SIGTERM, so a checker that ignored it kept hoop waiting.
  const stubborn = setup(`process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
  const t0 = Date.now();
  const a = await runCheck(stubborn.repo, "x\n", stubborn.home, { timeoutMs: 300 });
  assert.deepEqual([a?.ran, a?.reason], [false, "timeout"]);
  assert.ok(Date.now() - t0 < 3000, "it settles soon after the timeout");

  // Regression: an argument with a NUL byte made runCheck reject instead of returning an outcome.
  const nul = setup("");
  const cmd = [process.execPath, "check\u0000.mjs"];
  writeFileSync(join(nul.repo, "hoop.config.json"), JSON.stringify({ check: cmd }));
  writeFileSync(join(nul.home, "config.json"), JSON.stringify({ checks: [{ repo: nul.repo, command: cmd }] }));
  const b = await runCheck(nul.repo, "x\n", nul.home);
  assert.deepEqual([b?.ran, b?.reason], [false, "failed"]);

  // Regression: a temp folder that can't be made also made runCheck reject.
  const ok = setup(REPORTER);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = join(ok.repo, "no", "such", "folder");
  try {
    const c = await runCheck(ok.repo, "x\n", ok.home);
    assert.deepEqual([c?.ran, c?.reason], [false, "failed"]);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
});

test("review fixes: large output keeps its findings, stderr counts, and columns or line 0 don't become lines", async () => {
  // Regression: more than a few megabytes of output was reported as a command that couldn't start.
  const loud = setup(
    `const f = process.argv[2]; console.log(f + ":2: first"); process.stdout.write("x".repeat(3 * 1024 * 1024) + "\\n"); process.exitCode = 1;`,
  );
  const a = await runCheck(loud.repo, "x\ny\n", loud.home);
  assert.equal(a?.ran, true);
  assert.deepEqual(
    a?.findings.map((f) => [f.line, f.message]),
    [[2, "first"]],
  );

  // Regression: findings on stderr were ignored.
  const err = setup(`console.error(process.argv[2] + ":3: on stderr"); process.exit(1);`);
  assert.deepEqual(
    (await runCheck(err.repo, "x\n", err.home))?.findings.map((f) => f.line),
    [3],
  );

  // Regression: "path:3:5:" read the column as the line, and line 0 was accepted.
  assert.deepEqual(
    parseFindings("doc.md:3:5: MD009 trailing\ndoc.md:0: x\n", 1).map((f) => [f.line, f.message]),
    [[3, "MD009 trailing"]],
  );
  assert.deepEqual(
    parseFindings("C:/docs/a.md:4: message: with a colon\n", 1).map((f) => [f.line, f.message]),
    [[4, "message: with a colon"]],
  );
});

test("review fixes: an allow entry's folder must be absolute, and a symlinked entry matches its real folder", () => {
  const ok = setup(REPORTER, false);
  const link = join(tmp("hoop-check-link-"), "repo");
  symlinkSync(ok.repo, link);
  writeFileSync(join(ok.home, "config.json"), JSON.stringify({ checks: [{ repo: link, command: ok.command }] }));
  assert.equal(isAllowed(ok.repo, ok.command, ok.home), true);
  // Regression: a relative folder resolved against wherever hoop happened to run.
  writeFileSync(join(ok.home, "config.json"), JSON.stringify({ checks: [{ repo: ".", command: ok.command }] }));
  assert.equal(isAllowed(process.cwd(), ok.command, ok.home), false);
});

test("NFR-1: a document's text can't change the command that runs", async () => {
  const { repo, home } = setup(`import { writeFileSync } from "node:fs"; writeFileSync("args.json", JSON.stringify(process.argv.slice(2))); process.exit(0);`);
  const text = "# Doc\n\n$(touch pwned) `rm -rf ~` ; echo hi && exit 1\n";
  const out = await runCheck(repo, text, home);
  assert.equal(out?.ran, true);
  const args = JSON.parse(readFileSync(join(repo, "args.json"), "utf8"));
  assert.equal(args.length, 1, "the command gets exactly one added argument, the file path");
  assert.match(args[0], /document\.md$/);
  assert.throws(() => readFileSync(join(repo, "pwned")), "nothing in the text ran");
});

test("NFR-1: an allowed argument that looks like shell syntax reaches the checker as written", async () => {
  // Regression guard: with a shell, this argument would run "touch pwned".
  const repo = tmp("hoop-check-repo-"),
    home = tmp("hoop-check-home-");
  writeFileSync(
    join(repo, "check.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync("args.json", JSON.stringify(process.argv.slice(2))); process.exit(0);`,
  );
  const command = [process.execPath, "check.mjs", "$(touch pwned); echo"];
  writeFileSync(join(repo, "hoop.config.json"), JSON.stringify({ check: command }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ checks: [{ repo, command }] }));
  assert.equal((await runCheck(repo, "x\n", home))?.ran, true);
  assert.equal(JSON.parse(readFileSync(join(repo, "args.json"), "utf8"))[0], "$(touch pwned); echo");
  assert.throws(() => readFileSync(join(repo, "pwned")));
});
