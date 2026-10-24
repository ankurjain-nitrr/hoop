import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { sessionName } from "../src/owner.js";
import { registerSession } from "../src/sessions.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import type { AddressInfo } from "node:net";
import { BROWSER_SKIP, example, TEST_SESSION, tempHome, withBrowser, hasFocus } from "./helpers.js";

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

test("another agent's session keeps its reviews in the hoop folder, is named by its client or Home, and a rename never touches a transcript", () =>
  withServer(async (base, hoop) => {
    // A transcript that happens to share the session's ID must still be left alone.
    const session = "0a1b2c3d-codex-mcp-client";
    const before = line({ type: "user", message: "hi" }) + line({ type: "custom-title", customTitle: "From a transcript" });
    const path = transcript(session, before);
    const other = new Hoop(hoop.store, { session, claude: false, name: "codex-mcp-client" });
    const { review_id } = other.submit(example());
    assert.ok(existsSync(join(hoop.store.home, "reviews", review_id, "review.json")), "kept in the hoop folder, not a Claude Code folder");
    assert.deepEqual(hoop.store.meta(review_id).owner, { session, name: "codex-mcp-client", claude: false });
    const listed = async () => (await (await fetch(`${base}/api/reviews`)).json())[0].session;
    assert.deepEqual(await listed(), { id: session, name: "codex-mcp-client", label: "codex-mcp-client (0a1b2c3d)", live: false });

    const res = await rename(base, session, { name: "Codex plan" });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { session, name: "Codex plan", transcript: false, label: "Codex plan (0a1b2c3d)" });
    assert.equal(readFileSync(path, "utf8"), before, "no line appended to any transcript");
    assert.deepEqual(JSON.parse(readFileSync(join(hoop.store.home, "names.json"), "utf8")), { [session]: "Codex plan" });
    assert.deepEqual(await listed(), { id: session, name: "Codex plan", label: "Codex plan (0a1b2c3d)", live: false });
    // A revision records the name given on Home.
    other.submit({ ...example(), review_id });
    assert.equal(hoop.store.meta(review_id).owner?.name, "Codex plan");
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
      // The control is a pencil icon right after the session's name, not a text button.
      assert.equal(await button.innerText(), "");
      assert.equal(await button.locator("svg").count(), 1);
      const heading = (await page.getByRole("heading", { name: "Fix login" }).boundingBox())!;
      const pencil = (await button.boundingBox())!;
      assert.ok(pencil.x >= heading.x + heading.width && pencil.x - (heading.x + heading.width) < 16, "the pencil sits right after the name");
      assert.ok(Math.abs(pencil.y + pencil.height / 2 - (heading.y + heading.height / 2)) < 6, "on the name's line");
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

test("Home folds each section and session from its heading, keeps the folds across refreshes and reloads, and works without storage", {
  skip: BROWSER_SKIP,
}, async () => {
  await withBrowser(async ({ hoop, base, browser }) => {
    const B = "second-session-7777";
    transcript(TEST_SESSION, line({ type: "custom-title", customTitle: "Export plan" }));
    transcript(B, line({ type: "ai-title", aiTitle: "Fix login" }));
    const done = hoop.submit({ ...example(), slug: "done", title: "Done review" }).review_id;
    hoop.review(done, { verdict: "approved" });
    const asked = hoop.submit({ ...example(), slug: "asked", title: "Asked review" }).review_id;
    hoop.review(asked, { verdict: "changes_requested", summary: "Split it." });
    hoop.submit({ ...example(), title: "Export review" });
    new Hoop(hoop.store, B).submit({ ...example(), title: "Login review" });
    const page = await browser.newPage();
    await page.addInitScript(() => ((window as unknown as { HOOP_PRS_MS: number }).HOOP_PRS_MS = 200));
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page.locator(".list .session").first().waitFor();
    const pending = page.locator(".list .group").first();
    const exportPlan = pending.getByRole("button", { name: "Export plan", exact: true });
    const expanded = (b = exportPlan) => b.getAttribute("aria-expanded");
    assert.equal(await expanded(), "true");
    assert.equal(await pending.getByRole("heading", { name: "Export plan" }).count(), 1, "the button sits in the session's heading");

    // A click folds the session, shows its counts beside its name, and leaves the pencil in place.
    await exportPlan.click();
    assert.equal(await expanded(), "false");
    assert.equal(await page.locator(`#${await exportPlan.getAttribute("aria-controls")}`).isHidden(), true);
    assert.equal(await pending.getByRole("link", { name: /Export review/ }).count(), 0);
    assert.equal(
      await pending
        .locator(".session", { has: page.getByRole("button", { name: "Export plan", exact: true }) })
        .locator(".fold-summary")
        .innerText(),
      "1 awaiting review · 1 changes requested",
    );
    assert.equal(await pending.getByRole("button", { name: "Rename Export plan" }).isVisible(), true);
    assert.equal(await hasFocus(exportPlan), true);
    // The same session's completed part folds apart from its pending part.
    assert.equal(await expanded(page.locator(`[data-collapse="home:completed:${TEST_SESSION}"]`)), "true");

    // Enter and Space toggle from the keyboard.
    const login = pending.getByRole("button", { name: "Fix login", exact: true });
    await login.focus();
    await page.keyboard.press("Enter");
    assert.equal(await expanded(login), "false");
    await page.keyboard.press(" ");
    assert.equal(await expanded(login), "true");

    // Completed starts folded, its count in its heading (#197); it opens from the keyboard, the
    // browser remembers that it was opened, and it folds whole again.
    const completed = page.getByRole("button", { name: /Completed/ });
    assert.equal(await expanded(completed), "false");
    assert.match(await completed.innerText(), /^Completed\s+1$/);
    assert.equal(await page.getByRole("link", { name: /Done review/ }).count(), 0);
    await completed.focus();
    await page.keyboard.press("Enter");
    assert.equal(await expanded(completed), "true");
    await page.getByRole("link", { name: /Done review/ }).waitFor();
    await page.reload();
    await page.locator(".list .session").first().waitFor();
    assert.equal(await expanded(completed), "true", "opening Completed is remembered");
    await completed.click();
    assert.equal(await expanded(completed), "false");
    assert.equal(await page.getByRole("link", { name: /Done review/ }).count(), 0);

    // The pull request refresh paints Home again; the folds and focus stay.
    await exportPlan.focus();
    await page.locator(".list").evaluate((el) => el.setAttribute("data-old", ""));
    await page.locator(".list:not([data-old])").waitFor();
    assert.equal(await expanded(), "false");
    assert.equal(await expanded(completed), "false");
    assert.equal(await hasFocus(exportPlan), true);
    await page.reload();
    await page.locator(".list .session").first().waitFor();
    assert.equal(await expanded(), "false");
    assert.equal(await expanded(completed), "false");
    assert.equal(await expanded(login), "true");

    // Expand all opens everything; Collapse all folds every session and leaves the sections open.
    await page.getByRole("button", { name: "Expand all" }).click();
    assert.deepEqual(await page.locator("[data-collapse]").evaluateAll((els) => els.map((el) => el.getAttribute("aria-expanded"))), Array(5).fill("true"));
    await page.getByRole("button", { name: "Collapse all" }).click();
    const states = await page.locator("[data-collapse]").evaluateAll((els) => els.map((el) => [el.dataset.level, el.getAttribute("aria-expanded")]));
    assert.deepEqual(states, [
      ["part", "true"],
      ["session", "false"],
      ["session", "false"],
      ["part", "true"],
      ["session", "false"],
    ]);
    assert.deepEqual(await page.locator(".fold-summary").allInnerTexts(), ["1 awaiting review", "1 awaiting review · 1 changes requested", "1 approved"]);
    assert.equal(await hasFocus(page.getByRole("button", { name: "Collapse all" })), true);
    assert.deepEqual(errors, []);

    // Without storage, everything but Completed starts open, and still folds and opens.
    const bare = await browser.newPage();
    await bare.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw new Error("blocked");
      };
      Storage.prototype.setItem = () => {
        throw new Error("blocked");
      };
    });
    const bareErrors: string[] = [];
    bare.on("pageerror", (e) => bareErrors.push(e.message));
    await bare.goto(base);
    await bare.locator(".list .session").first().waitFor();
    const b = bare.locator(".list .group").first().getByRole("button", { name: "Export plan", exact: true });
    assert.equal(await expanded(b), "true");
    await b.click();
    assert.equal(await expanded(b), "false");
    const bareCompleted = bare.getByRole("button", { name: /Completed/ });
    assert.equal(await expanded(bareCompleted), "false");
    await bareCompleted.click();
    assert.equal(await expanded(bareCompleted), "true");
    assert.deepEqual(bareErrors, []);
  });
});

test("Home says in one line when nothing waits on the person, above a folded Completed", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const done = hoop.submit({ ...example(), title: "Done review" }).review_id;
    hoop.review(done, { verdict: "approved" });
    await page.goto(base);
    await page.locator(".list .all-clear").waitFor();
    assert.equal(await page.locator(".list .all-clear").innerText(), "Nothing waiting on you.");
    assert.equal(await page.getByRole("button", { name: /^Pending/ }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /^Completed/ }).getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByRole("link", { name: /Done review/ }).count(), 0);
  });
});

test("a review approved while Home is open lands in a folded Completed, which stays folded with focus on its button", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const done = hoop.submit({ ...example(), slug: "done", title: "Done review" }).review_id;
    hoop.review(done, { verdict: "approved" });
    const next = hoop.submit({ ...example(), slug: "next", title: "Next review" }).review_id;
    await page.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 200 }));
    await page.goto(base);
    const completed = page.getByRole("button", { name: /^Completed/ });
    await completed.waitFor();
    assert.match(await completed.innerText(), /^Completed\s+1$/);
    await completed.focus();
    hoop.review(next, { verdict: "approved" });
    await page.waitForFunction(() => /Completed\s+2/.test(document.querySelector('[data-collapse="home:completed"]')?.textContent ?? ""));
    assert.equal(await completed.getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByRole("link", { name: /Next review/ }).count(), 0);
    assert.equal(await hasFocus(completed), true);
  });
});
