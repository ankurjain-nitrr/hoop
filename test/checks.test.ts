import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowed, parseFindings, repoCommand, runCheck } from "../src/checks.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** A repository whose check command runs `script` with Node, and a hoop folder that allows it or not. */
function setup(script: string, allow = true) {
  const repo = tmp("hoop-check-repo-"), home = tmp("hoop-check-home-");
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
  assert.deepEqual(found?.findings.map((f) => [f.line, f.message]), [[3, "uses a dash between words"], [7, "uses a dash between words"]]);
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
  assert.deepEqual(findings.map((f) => f.line), [3, 5, 5, 8]);
  assert.ok(findings.every((f) => !f.message.startsWith(" ") && !/finding\(s\)/.test(f.message)), "snippet and summary lines are ignored");
  assert.equal(findings[0]!.message, "uses a dash between words; use a period, comma, colon or parentheses");
  assert.deepEqual(parseFindings("Something went wrong\nmore\n", 1), [{ message: "Something went wrong" }]);
  assert.deepEqual(parseFindings("all clear\n", 0), []);
});

test("FR-7: a repository without a command, or with a malformed one, checks nothing", async () => {
  const repo = tmp("hoop-check-none-"), home = tmp("hoop-check-home-");
  assert.equal(await runCheck(repo, "x\n", home), undefined);
  writeFileSync(join(repo, "hoop.config.json"), JSON.stringify({ check: "python3 check.py" }));
  assert.equal(repoCommand(repo), undefined, "a command must be a list of arguments");
  assert.equal(await runCheck(repo, "x\n", home), undefined);
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
