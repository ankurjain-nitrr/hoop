import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { sessionName } from "../src/owner.js";
import { registerSession } from "../src/sessions.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import type { AddressInfo } from "node:net";
import { BROWSER_SKIP, example, TEST_SESSION, tempHome, withBrowser } from "./helpers.js";

/** A pages server for a fresh store, on a free port. */
async function withServer(fn: (base: string, hoop: Hoop) => Promise<void>) {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hoop);
  } finally {
    server.close();
  }
}

/** Writes a session's transcript into the test's Claude Code folder, and returns its path. */
function transcript(session: string, text: string) {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-home-sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${session}.jsonl`);
  writeFileSync(path, text);
  return path;
}
const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const titleLine = (name: string, session: string) => `{"type":"custom-title","customTitle":${JSON.stringify(name)},"sessionId":"${session}"}\n`;

const rename = (base: string, session: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/sessions/${session}/name`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("a session's name: the title set in its transcript, else the name given on Home, else Claude Code's generated title", () => {
  const home = tempHome();
  writeFileSync(join(home, "names.json"), JSON.stringify({ "prio-1": "Named on Home", "prio-2": "Named on Home", "prio-3": "Named on Home" }));
  transcript("prio-1", line({ type: "ai-title", aiTitle: "Generated" }) + line({ type: "custom-title", customTitle: "Set with /rename" }));
  transcript("prio-2", line({ type: "ai-title", aiTitle: "Generated" }));
  assert.equal(sessionName("prio-1", home), "Set with /rename");
  assert.equal(sessionName("prio-2", home), "Named on Home");
  assert.equal(sessionName("prio-2"), "Generated", "without hoop's folder, only the transcript counts");
  assert.equal(sessionName("prio-3", home), "Named on Home", "a session whose transcript is gone keeps its name");
  assert.equal(sessionName("prio-4", home), undefined);
});

test("renaming a session appends Claude Code's /rename line to its transcript, and only appends", () =>
  withServer(async (base, hoop) => {
    const before = line({ type: "user", message: "hi" }) + line({ type: "ai-title", aiTitle: "Generated" });
    const path = transcript(TEST_SESSION, before);
    hoop.submit(example());
    const res = await rename(base, TEST_SESSION, { name: "  Export plan  " });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { session: TEST_SESSION, name: "Export plan", transcript: true, label: "Export plan (test-ses)" });
    assert.equal(readFileSync(path, "utf8"), before + titleLine("Export plan", TEST_SESSION), "the exact /rename line, after the untouched transcript");
    assert.deepEqual(JSON.parse(readFileSync(join(hoop.store.home, "names.json"), "utf8")), { [TEST_SESSION]: "Export plan" });
    const [m] = await (await fetch(`${base}/api/reviews`)).json();
    assert.deepEqual(m.session, { id: TEST_SESSION, name: "Export plan", label: "Export plan (test-ses)", live: false });

    // A transcript whose last line is cut short gets a line break first, and its bytes stay as they were.
    writeFileSync(path, `${before}{"type":"user"`);
    assert.equal((await rename(base, TEST_SESSION, { name: "CSV export" })).status, 201);
    assert.equal(readFileSync(path, "utf8"), `${before}{"type":"user"\n${titleLine("CSV export", TEST_SESSION)}`);
    // Names go into the transcript as JSON, so quotes and other scripts survive.
    assert.equal((await rename(base, TEST_SESSION, { name: 'Café "plan" 計画' })).status, 201);
    assert.ok(readFileSync(path, "utf8").endsWith(titleLine('Café "plan" 計画', TEST_SESSION)));
    assert.equal((await (await fetch(`${base}/api/reviews`)).json())[0].session.name, 'Café "plan" 計画');
  }));

test("a rename is refused for a bad name, a session with no review, a foreign Origin and a non-JSON body", () =>
  withServer(async (base, hoop) => {
    const before = line({ type: "ai-title", aiTitle: "Generated" });
    const path = transcript(TEST_SESSION, before);
    hoop.submit(example());
    for (const [name, error] of [
      ["", "a session name needs text"],
      ["   ", "a session name needs text"],
      ["two\nlines", "a session name is one line"],
      ["sep\u2028arated", "a session name is one line"],
      ["x".repeat(101), "a session name has at most 100 characters"],
      [42, "a session name needs text"],
    ] as const) {
      const res = await rename(base, TEST_SESSION, { name });
      assert.equal(res.status, 400, JSON.stringify(name));
      const body = await res.json();
      assert.equal(body.error, error);
      assert.equal(body.errors[0].path, "name");
    }
    assert.equal((await rename(base, TEST_SESSION, "{nope")).status, 400);
    // A session hoop has no review from can't be renamed from the pages, and an ID that isn't one never matches.
    transcript("stranger-5555", before);
    assert.equal((await rename(base, "stranger-5555", { name: "Mine now" })).status, 404);
    assert.equal(readFileSync(join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-home-sessions", "stranger-5555.jsonl"), "utf8"), before);
    assert.equal((await rename(base, "..%2Fescape", { name: "x" })).status, 404);
    // Cross-site writes are refused before anything is written.
    assert.equal((await rename(base, TEST_SESSION, { name: "Evil" }, { origin: "https://evil.example" })).status, 403);
    const plain = await fetch(`${base}/api/sessions/${TEST_SESSION}/name`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"name":"Plain"}',
    });
    assert.equal(plain.status, 415);
    assert.equal(readFileSync(path, "utf8"), before, "no refused rename touched the transcript");
    const ok = await rename(base, TEST_SESSION, { name: "x".repeat(100) }, { origin: base });
    assert.equal(ok.status, 201, "a name of 100 characters, from the page's own origin, is accepted");
  }));

test("a session without a transcript is renamed in hoop alone", () =>
  withServer(async (base, hoop) => {
    new Hoop(hoop.store, "no-transcript-6666").submit(example());
    const res = await rename(base, "no-transcript-6666", { name: "Lost transcript" });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).transcript, false);
    assert.equal((await (await fetch(`${base}/api/reviews`)).json())[0].session.label, "Lost transcript (no-trans)");
  }));

test("a review's session is live while its hoop runs", () =>
  withServer(async (base, hoop) => {
    hoop.submit(example());
    assert.equal((await (await fetch(`${base}/api/reviews`)).json())[0].session.live, false);
    // This process registers as the test's Claude Code session.
    const remove = registerSession(hoop.store.home, process.env.HOOP_REPO_DIR!);
    try {
      assert.equal((await (await fetch(`${base}/api/reviews`)).json())[0].session.live, true);
    } finally {
      remove();
    }
  }));

test("Home groups each section's reviews by session, and renames a session from the keyboard", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const B = "second-session-7777";
    transcript(TEST_SESSION, line({ type: "custom-title", customTitle: "Export plan" }));
    transcript(B, line({ type: "ai-title", aiTitle: "Fix login" }));
    const b = new Hoop(hoop.store, B);
    const done = hoop.submit({ ...example(), slug: "done", title: "Done review" }).review_id;
    hoop.review(done, { verdict: "approved" });
    b.submit({ ...example(), title: "Login review" });
    const orphan = hoop.submit({ ...example(), title: "Old review" }).review_id;
    hoop.store.update(orphan, { owner: undefined });
    hoop.submit({ ...example(), title: "Export review" });
    const remove = registerSession(hoop.store.home, process.env.HOOP_REPO_DIR!);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(base);
      await page.locator(".list .session").first().waitFor();
      const groups = () =>
        page.locator(".list .group").evaluateAll((els) =>
          els.map((el) => ({
            head: el.querySelector("h2")!.textContent!.replace(/\s+/g, " ").trim(),
            sessions: [...el.querySelectorAll(".session")].map((s) => ({
              name: s.querySelector("h3")!.textContent,
              id: s.querySelector(".sid")?.textContent ?? null,
              place: s.querySelector(".place")?.textContent ?? null,
              live: Boolean(s.querySelector(".live")),
              rows: [...s.querySelectorAll("a[href]")].map((a) => a.querySelector(".t")!.textContent),
            })),
          })),
        );
      const place = basename(process.env.HOOP_REPO_DIR!);
      assert.deepEqual(await groups(), [
        {
          head: "Pending 3",
          sessions: [
            { name: "Export plan", id: "test-ses", place, live: true, rows: ["Export review"] },
            { name: "Fix login", id: "second-s", place, live: false, rows: ["Login review"] },
            { name: "No session", id: null, place: null, live: false, rows: ["Old review"] },
          ],
        },
        { head: "Completed 1", sessions: [{ name: "Export plan", id: "test-ses", place, live: true, rows: ["Done review"] }] },
      ]);
      assert.equal(await page.getByRole("region", { name: "Fix login" }).count(), 1, "each session is a labelled region");

      // Rename opens a labelled field with focus in it; Enter saves, and focus goes back to the button.
      const button = page.getByRole("button", { name: "Rename Fix login" });
      await button.focus();
      await page.keyboard.press("Enter");
      const field = page.getByLabel("Session name");
      assert.equal(await field.evaluate((el) => el === document.activeElement), true);
      assert.equal(await field.inputValue(), "Fix login");
      await field.fill("Login bug");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Rename Login bug" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Rename Login bug" }).evaluate((el) => el === document.activeElement), true);
      assert.ok(readFileSync(join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-home-sessions", `${B}.jsonl`), "utf8").endsWith(titleLine("Login bug", B)));

      // Escape and Cancel close without saving, and put focus back on Rename.
      await page.keyboard.press("Enter");
      await field.fill("Not saved");
      await page.keyboard.press("Escape");
      assert.equal(await page.getByRole("button", { name: "Rename Login bug" }).evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Cancel" }).click();
      assert.equal(await page.getByRole("button", { name: "Rename Login bug" }).evaluate((el) => el === document.activeElement), true);

      // A refused name shows in an alert, and focus stays in the field.
      await page.keyboard.press("Enter");
      await field.fill("  ");
      await page.getByRole("button", { name: "Save" }).click();
      const alert = page.getByRole("alert");
      await alert.filter({ hasText: "a session name needs text" }).waitFor();
      assert.equal(await field.evaluate((el) => el === document.activeElement && el.getAttribute("aria-invalid") === "true"), true);
      assert.equal(await page.getByRole("heading", { name: "Login bug", exact: true }).count(), 1);
      assert.deepEqual(errors, []);
    } finally {
      remove();
    }
  });
});
