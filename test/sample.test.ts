import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { init } from "../src/init.js";
import { parseMarkdown } from "../src/markdown.js";
import { SAMPLE_MARKDOWN } from "../src/sample.js";
import { Store } from "../src/store.js";
import { BROWSER_SKIP, hoopArgs, pagesFor, tempHome, withBrowser } from "./helpers.js";

// The sample review (#212): `hoop init` ends by opening it, and Home offers it while it lists no
// reviews, with a prompt to copy that asks Claude for one. No test runs a real `claude` or opens a
// real browser: both are stand-ins on PATH that record their calls.

test("the sample is plainly a sample, and has a line to comment on, words to suggest a change to and a question", () => {
  const doc = parseMarkdown(SAMPLE_MARKDOWN);
  assert.match(doc.title, /^Sample review: /);
  assert.equal(doc.subtitle, "A sample to try hoop on: no Claude session is waiting on it");
  assert.match(doc.tldr, /^This is a sample, .*close the sample when you're done\.$/);
  const question = doc.items.find((i) => i.choices);
  assert.ok(question, "a Question section");
  assert.deepEqual(
    question.choices!.map((c) => [c.id, Boolean(c.recommended)]),
    [
      ["a", true],
      ["b", false],
      ["c", false],
    ],
  );
  assert.ok(
    doc.items.some((i) => i.title === "The plan"),
    "a section of plain text to comment on and suggest changes to",
  );
});

test("opening the sample gives the one still open, and a new one once it is closed", () => {
  const hoop = new Hoop(new Store(tempHome()), null);
  const first = hoop.openSample();
  assert.equal(first.outcome, "created");
  const meta = hoop.store.meta(first.review_id);
  assert.equal(meta.sample, true);
  assert.ok(meta.opened_by, "the person's, as a file they opened is");
  assert.equal(meta.owner, undefined, "no session takes what they write on it");
  assert.deepEqual([hoop.openSample().review_id, hoop.openSample().outcome], [first.review_id, "unchanged"]);
  hoop.close(first.review_id, "Tried it.");
  const next = hoop.openSample();
  assert.equal(next.outcome, "created");
  assert.notEqual(next.review_id, first.review_id);
});

/** Runs `fn` with PATH holding only stand-ins and the system folders, so no real `claude` can run. */
async function withoutClaude<T>(fn: () => Promise<T>): Promise<T> {
  const path = process.env.PATH;
  process.env.PATH = `${mkdtempSync(join(tmpdir(), "hoop-sample-nobin-"))}:/usr/bin:/bin`;
  try {
    return await fn();
  } finally {
    process.env.PATH = path;
  }
}

test("init ends by opening the sample and saying where it is, or why it didn't open, and --print opens nothing", async () => {
  const settings = join(mkdtempSync(join(tmpdir(), "hoop-sample-settings-")), "settings.json");
  let out = "";
  const write = (s: string) => void (out += s);
  assert.equal(await withoutClaude(() => init({ todo: "no", settings, out: write, sample: async () => "http://localhost:4747/r/rv_1" })), 0);
  assert.match(out, /claude isn't on PATH/);
  assert.ok(out.endsWith("hoop: a sample review is open to try the review page on: http://localhost:4747/r/rv_1\n"), out);

  out = "";
  const failing = async (): Promise<string> => {
    throw new Error("the review pages are off");
  };
  assert.equal(await withoutClaude(() => init({ todo: "no", settings, out: write, sample: failing })), 0, "a sample that can't open doesn't fail init");
  assert.ok(out.endsWith("hoop: the sample review didn't open (the review pages are off). Home offers it while you have no reviews.\n"), out);

  let asked = false;
  await init({ print: true, settings, out: () => {}, sample: async () => ((asked = true), "") });
  assert.equal(asked, false, "--print only prints");
});

/** A folder of stand-ins that record their arguments in `<name>.log`: claude, and the browser openers. */
function standIns() {
  const bin = mkdtempSync(join(tmpdir(), "hoop-sample-bin-"));
  for (const name of ["claude", "open", "xdg-open"]) writeFileSync(join(bin, name), `#!/bin/sh\necho "$*" >> "${bin}/${name}.log"\n`, { mode: 0o755 });
  const log = (name: string) =>
    existsSync(join(bin, `${name}.log`))
      ? readFileSync(join(bin, `${name}.log`), "utf8")
          .trim()
          .split("\n")
      : [];
  const opened = () => [...log("open"), ...log("xdg-open")];
  // hoop starts the opener detached and doesn't wait for it, so its call is recorded a moment later.
  const openedSoon = async (n: number) => {
    for (const end = Date.now() + 5000; opened().length < n && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
    return opened();
  };
  return { bin, log, opened, openedSoon };
}

/** Runs `hoop init` with the stand-ins first on PATH, a temp hoop home and Claude Code folder, and `env` on top. */
function hoopInit(args: string[], bin: string, env: Record<string, string>) {
  const { HOOP_NO_BROWSER: _n, ...rest } = process.env as Record<string, string>;
  const child = spawn(process.execPath, [...hoopArgs, "init", ...args], {
    env: { ...rest, PATH: `${bin}:/usr/bin:/bin`, HOOP_CLAUDE_DIR: mkdtempSync(join(tmpdir(), "hoop-sample-claude-")), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (status) => resolve({ status, stdout, stderr })),
  );
}

test("hoop init installs the plugin, then opens the sample in the browser; --no-browser only prints its link", async () => {
  const home = tempHome();
  const pages = await pagesFor(home);
  const { bin, log, opened, openedSoon } = standIns();
  const env = { ...pages, HOOP_PAGES: "" };

  const first = await hoopInit(["--no"], bin, env);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(log("claude").slice(-2), ["plugin marketplace add ankurjain-nitrr/hoop", "plugin install hoop@hoop"]);
  const url = /a sample review is open to try the review page on: (\S+)/.exec(first.stdout)?.[1];
  assert.ok(url, first.stdout);
  assert.deepEqual(await openedSoon(1), [url], "the browser opens the sample, through the platform's opener");
  const sample = new Store(home, { readOnly: true }).list().filter((m) => m.sample);
  assert.equal(sample.length, 1);
  assert.ok(url.endsWith(`/r/${sample[0]!.id}`));

  const again = await hoopInit(["--no", "--no-browser"], bin, env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`a sample review is open to try the review page on: ${url.replace(/[.?]/g, "\\$&")}`), "the same sample");
  assert.deepEqual(opened(), [url], "--no-browser opens nothing");

  // With the pages off, init says why the sample didn't open, and still succeeds.
  const off = await hoopInit(["--no"], bin, { ...env, HOOP_PAGES: "off" });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /the sample review didn't open \(the review pages are off \(HOOP_PAGES=off\)\)/);
  assert.deepEqual(opened(), [url]);

  assert.equal((await hoopInit(["--bogus"], bin, env)).status, 2);
});

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

test("Home with no reviews offers Open a sample review, which goes to it, and a prompt to copy", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ base, page }) => {
    await page.goto(base);
    const button = page.getByRole("button", { name: "Open a sample review" });
    await button.waitFor();
    assert.match(await page.locator(".empty.start").innerText(), /No reviews yet\./);
    assert.equal(await page.locator(".empty.start .prompt").innerText(), "Send me a short sample review in hoop, with one question for me, so I can try it.");
    assert.equal(await page.getByRole("button", { name: "Copy the prompt" }).count(), 1);
    await page.addScriptTag({ path: AXE });
    const serious = await page.evaluate(async () => {
      const r = await (window as unknown as { axe: { run: () => Promise<{ violations: { id: string; impact: string }[] }> } }).axe.run();
      return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);
    });
    assert.deepEqual(serious, []);

    await button.click();
    await page.waitForURL(/\/r\/rv_/);
    await page.locator(".top h1", { hasText: "Sample review: plan the team offsite" }).waitFor();
    await page.getByText("When should the offsite be?").first().waitFor();
    // Home now lists it, and offers no second sample.
    await page.goto(base);
    await page.locator(".list a.row", { hasText: "Sample review: plan the team offsite" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Open a sample review" }).count(), 0);
  }),
);
