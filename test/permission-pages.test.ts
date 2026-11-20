import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { askPermission, readPermission, settlePermission } from "../src/permissions.js";
import { Store } from "../src/store.js";
import { editWork, workHook } from "../src/work.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

// Claude Code's permission prompts on Work and in Home's Waiting on you, in the words decided in
// rv_mw7wkyez20853f: "Waiting on you: permission", the tool, the command or change in full, Allow
// once and Deny with "Reason (optional; Claude reads it)", and where it was answered.

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const INPUTS = JSON.parse(readFileSync(new URL("./fixtures/hook-inputs/permission.json", import.meta.url), "utf8"));
const SESSION = HOOKS["post-taskcreate"].session_id;

/** A hoop home with permission prompts on and a session with work, as Work lists it. */
function home() {
  const h = tempHome();
  writeFileSync(join(h, "on"), "permission_prompts\n");
  workHook(h, { ...HOOKS["post-taskcreate"], tool_input: { subject: "Read the code" }, tool_response: { task: { id: "1", subject: "Read the code" } } });
  return h;
}
// Each prompt asked a moment after the last, so their order never rests on a tie.
let tick = Date.now();
const ask = (h: string, tool: string, tool_input: Record<string, unknown>) =>
  askPermission(h, { ...INPUTS["permission-request"], session_id: SESSION, tool_name: tool, tool_input }, new Date((tick += 5))).id;

/** A home with two Bash prompts, the first asked first. */
function twoPrompts() {
  const h = home();
  return { h, first: ask(h, "Bash", { command: "echo one" }), second: ask(h, "Bash", { command: "echo two" }) };
}

/** Opens Home, asking for its lists every 200 ms. */
async function homeFast(page: import("playwright-core").Page, base: string) {
  await page.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 200 }));
  await page.goto(`${base}/`);
}

/** Waits out the moment Allow once ignores presses after the cards appeared or moved. */
const settled = (page: { waitForTimeout(ms: number): Promise<void> }) => page.waitForTimeout(600);

/**
 * Makes each quiet moment from now on last five seconds, so a test's press after a move lands
 * inside it however slow the machine.
 */
const stretchQuiet = (page: import("playwright-core").Page) => page.evaluate(() => Object.assign(window, { HOOP_QUIET_MS: 5000 }));

/** "14:02" as the pages write a time today: its spaces don't break. */
const CLOCK = /\d{1,2}:\d{2}(?: [AP]M)?$/;

test("Home's Waiting on you shows a prompt in full, and Allow once answers it there", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const id = ask(h, "Bash", { command: "rm -rf build\nmkdir build", description: "Clean the build folder" });
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/`);
      const card = page.locator(`.list [data-permission="${id}"]`);
      await card.waitFor();
      await settled(page);
      assert.equal(await card.getByRole("heading").textContent(), "Waiting on you: permission");
      assert.equal(await card.locator(".tag-tool").textContent(), "Bash");
      assert.equal(await card.locator(".perm-call").textContent(), "rm -rf build\nmkdir build", "the command in full");
      assert.equal(await card.locator(".d").textContent(), "Clean the build folder");
      assert.match((await page.locator("#g-waiting").textContent()) ?? "", /Waiting on you\s*1/, "it counts in Waiting on you");
      await card.getByRole("button", { name: /^Allow once:/ }).click();
      const note = page.locator(`.list .perm-answered[data-permission="${id}"]`);
      await note.waitFor();
      assert.match((await note.textContent()) ?? "", /^Bash Allowed in hoop /);
      assert.match((await note.textContent()) ?? "", CLOCK);
      assert.equal(readPermission(h, id)!.state, "allowed");
    },
    new Hoop(new Store(h)),
  );
});

test("regression: a prompt shown as a card isn't listed again as its session's Work prompt", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const id = ask(h, "Bash", { command: "npm publish" });
  // Work reads the same prompt as the session's step waiting on a permission prompt.
  const doing = { what: "npm publish", at: new Date().toISOString(), open: true, waiting: "permission" };
  const sessions = [{ id: SESSION, name: "Export work", state: "busy", doing, agents: [], todos: [], changes: [] }];
  await withBrowser(
    async ({ base, page }) => {
      await page.route("**/api/work", (route) => route.fulfill({ json: { sessions } }));
      await page.goto(`${base}/`);
      await page.locator(`.list [data-permission="${id}"]`).waitFor();
      await page.waitForResponse((r) => r.url().endsWith("/api/work"));
      await settled(page);
      assert.equal(await page.locator("#g-waiting-body .waiting-row").count(), 0, "no row besides the card");
      assert.match((await page.locator("#g-waiting").textContent()) ?? "", /Waiting on you\s*1/, "it counts once");
    },
    new Hoop(new Store(h)),
  );
});

test("Deny opens its reason box, keeps what is typed through a refresh, and sends the reason Claude reads", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const id = ask(h, "Edit", { file_path: "/repo/src/app.ts", old_string: "const a = 1;", new_string: "const a = 2;" });
  await withBrowser(
    async ({ base, page }) => {
      await homeFast(page, base);
      const card = page.locator(`[data-permission="${id}"]`);
      await card.waitFor();
      await settled(page);
      // A change shows its file, and its lines as removed and added.
      assert.equal(await card.locator(".d").textContent(), "/repo/src/app.ts");
      assert.deepEqual(await card.locator(".perm-del, .perm-add").allTextContents(), ["- const a = 1;", "+ const a = 2;"]);
      await card.getByRole("button", { name: /^Deny:/ }).click();
      const box = card.getByLabel("Reason (optional; Claude reads it)");
      assert.equal(await box.evaluate((el) => el === document.activeElement), true, "focus goes to the box");
      await box.fill("Keep a = 1");
      await page.waitForTimeout(700);
      assert.equal(await box.inputValue(), "Keep a = 1", "a refresh waits while the box is open");
      await card
        .locator("form")
        .getByRole("button", { name: /^Deny:/ })
        .click();
      await page.locator(`.perm-answered[data-permission="${id}"]`, { hasText: "Denied in hoop" }).waitFor();
      assert.deepEqual([readPermission(h, id)!.state, readPermission(h, id)!.reason], ["denied", "Keep a = 1"]);
    },
    new Hoop(new Store(h)),
  );
});

test("Work shows a session's prompt under what it does, and says where each was answered", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const waiting = ask(h, "Write", { file_path: "/repo/NOTES.md", content: "# Notes\nFirst line" });
  const terminal = ask(h, "Bash", { command: "ls" });
  settlePermission(h, terminal, "terminal");
  const handed = ask(h, "Bash", { command: "pwd" });
  settlePermission(h, handed, "handed");
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      const card = page.locator(`section.work-session [data-permission="${waiting}"]`);
      await card.waitFor();
      await settled(page);
      assert.equal(await card.getByRole("heading").textContent(), "Waiting on you: permission");
      assert.equal(await card.locator(".perm-call").textContent(), "# Notes\nFirst line");
      assert.match((await page.locator(`[data-permission="${terminal}"]`).textContent()) ?? "", /^Bash Answered in the terminal /);
      assert.equal(await page.locator(`[data-permission="${handed}"]`).textContent(), "Bash Answer this in the terminal.");
      // The terminal answers first: Allow once on the page then says how it went.
      settlePermission(h, waiting, "terminal");
      await card.getByRole("button", { name: /^Allow once:/ }).click();
      await page.locator(`[data-permission="${waiting}"]`, { hasText: "Answered in the terminal" }).waitFor();
      assert.equal(readPermission(h, waiting)!.state, "terminal", "the first answer won");
    },
    new Hoop(new Store(h)),
  );
});

test("regression: a second click right after Allow once allows nothing more, and focus lands on the note", { skip: BROWSER_SKIP }, async () => {
  const { h, first, second } = twoPrompts();
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/`);
      const button = page.locator(`[data-permission="${first}"] [data-perm-allow]`);
      await button.waitFor();
      await settled(page);
      // Cards go oldest first, so the second sits below the first.
      const ids = await page.locator(".list article.permission").evaluateAll((els) => els.map((el) => el.getAttribute("data-permission")));
      assert.deepEqual(ids, [first, second]);
      assert.equal(await button.getAttribute("aria-label"), "Allow once: Bash echo one", "each card's buttons name it");
      const box = (await button.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(150);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.locator(`[data-permission-note="${first}"]`).waitFor();
      await page.waitForTimeout(600);
      assert.deepEqual([readPermission(h, first)!.state, readPermission(h, second)!.state], ["allowed", "waiting"], "only the first was allowed");
      // A click that lands on the held card moves the focus off it; never onto a button.
      assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "BUTTON");
      // A double click counts once too.
      await page.waitForTimeout(1600);
      await page.locator(`[data-permission="${second}"] [data-perm-allow]`).dblclick();
      await page.locator(`[data-permission-note="${second}"]`).waitFor();
      // Focus goes to the note, not a button.
      await page.waitForFunction((id) => document.activeElement?.getAttribute("data-permission-note") === id, second, { timeout: 5000 });
    },
    new Hoop(new Store(h)),
  );
});

test("a card shows every field of the call, those that widen it first, and hidden characters as markers", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const bash = ask(h, "Bash", {
    command: "echo \u202Eevil\u200B",
    description: "Say it",
    dangerouslyDisableSandbox: true,
    run_in_background: true,
    timeout: 600000,
  });
  const edit = ask(h, "Edit", { file_path: "/repo/a.ts", old_string: "", new_string: "x", replace_all: true });
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/`);
      const b = page.locator(`[data-permission="${bash}"]`);
      await b.waitFor();
      assert.equal(await b.locator(".perm-call").textContent(), "echo ⟨U+202E⟩evil⟨U+200B⟩");
      assert.deepEqual(await b.locator(".perm-fields dt").allTextContents(), ["dangerouslyDisableSandbox", "run_in_background", "timeout"]);
      assert.deepEqual(await b.locator(".perm-fields dd").allTextContents(), ["true", "true", "600000"]);
      assert.equal(await b.locator(".perm-widens").count(), 2, "the fields that widen the call stand out");
      const e = page.locator(`[data-permission="${edit}"]`);
      assert.deepEqual(await e.locator(".perm-del, .perm-add").allTextContents(), ["+ x"], "an empty old text has no line");
      assert.deepEqual(await e.locator(".perm-fields dt").allTextContents(), ["replace_all"]);
      // The tool is a tag; the reason box's Deny is a plain button, and Allow once the only primary.
      assert.equal(await b.locator(".tag-tool").evaluate((el) => getComputedStyle(el).borderStyle), "solid");
      await b.getByRole("button", { name: /^Deny:/ }).click();
      const deny = b.locator("form button[type=submit]");
      assert.equal(await deny.evaluate((el) => el.classList.contains("danger") || el.classList.contains("primary")), false);
      assert.equal(await b.getByLabel("Reason (optional; Claude reads it)").getAttribute("maxlength"), "200");
    },
    new Hoop(new Store(h)),
  );
});

test("on Work, a Deny box survives refreshes, the heading keeps sentence case, and the prompt counts as waiting on you", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const id = ask(h, "Bash", { command: "rm -rf build" });
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => Object.assign(window, { HOOP_WORK_MS: 200 }));
      await page.goto(`${base}/work`);
      const card = page.locator(`section.work-session [data-permission="${id}"]`);
      await card.waitFor();
      await settled(page);
      assert.equal(await card.getByRole("heading").evaluate((el) => getComputedStyle(el).textTransform), "none");
      assert.match((await page.locator(".work-counts").textContent()) ?? "", /1 waiting on you/);
      await card.getByRole("button", { name: /^Deny:/ }).click();
      const box = card.getByLabel("Reason (optional; Claude reads it)");
      await box.pressSequentially("Keep the build");
      await box.evaluate((el: HTMLInputElement) => el.setSelectionRange(4, 4));
      await page.waitForTimeout(900);
      assert.equal(await box.inputValue(), "Keep the build");
      assert.equal(await box.evaluate((el: HTMLInputElement) => [el === document.activeElement, el.selectionStart].join()), "true,4", "focus and cursor stay");
    },
    new Hoop(new Store(h)),
  );
});

/** The y of a prompt's Allow once on the page. */
const allowY = async (page: import("playwright-core").Page, id: string) => (await page.locator(`[data-permission="${id}"] [data-perm-allow]`).boundingBox())!.y;

test("regression: the next card keeps its place for the hold after Allow once, or after the terminal answered", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const first = ask(h, "Bash", { command: "echo one" });
  const second = ask(h, "Bash", { command: "echo two" });
  const third = ask(h, "Bash", { command: "echo three" });
  await withBrowser(
    async ({ base, page }) => {
      await homeFast(page, base);
      await page.locator(`[data-permission="${third}"] [data-perm-allow]`).waitFor();
      await settled(page);
      const y = await allowY(page, second);
      await page.locator(`[data-permission="${first}"] [data-perm-allow]`).click();
      await page.locator(`[data-permission-note="${first}"]`).waitFor();
      for (const wait of [100, 400, 400]) {
        await page.waitForTimeout(wait);
        assert.ok(Math.abs((await allowY(page, second)) - y) < 1, "the next card stays under the pointer's place");
      }
      // It moves up once the hold lets go.
      await page.waitForFunction(
        ([id, at]) => document.querySelector(`[data-permission="${id}"] [data-perm-allow]`)!.getBoundingClientRect().y < (at as number) - 1,
        [second, y] as const,
        { timeout: 5000 },
      );
      // Answered in the terminal: the card held the same way.
      const y3 = await allowY(page, third);
      settlePermission(h, second, "terminal");
      await page.locator(`[data-permission-note="${second}"]`).waitFor();
      await page.waitForTimeout(300);
      assert.ok(Math.abs((await allowY(page, third)) - y3) < 1, "a card answered elsewhere holds its place too");
    },
    new Hoop(new Store(h)),
  );
});

test("regression: while an answer is sent focus stays on its own card, and a failed answer gives it back its Allow once", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const first = ask(h, "Bash", { command: "echo one" });
  ask(h, "Bash", { command: "echo two" });
  await withBrowser(
    async ({ base, page }) => {
      let fail = true;
      await page.route("**/api/permissions/*", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        await new Promise((r) => setTimeout(r, 600));
        return fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"no"}' }) : route.continue();
      });
      await page.goto(`${base}/`);
      const allow = page.locator(`[data-permission="${first}"] [data-perm-allow]`);
      await allow.waitFor();
      await settled(page);
      await allow.focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-permission")), first, "focus is on the card being answered, no button");
      await page.locator(`[data-permission="${first}"] .rename-error`, { hasText: "no" }).waitFor();
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-perm-allow")),
        first,
        "a failed answer gives the focus back to its own Allow once",
      );
      assert.equal(readPermission(h, first)!.state, "waiting");
      fail = false;
    },
    new Hoop(new Store(h)),
  );
});

test("a MultiEdit shows each edit's own fields after its change, replace_all first and bold", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const id = ask(h, "MultiEdit", {
    file_path: "/repo/a.ts",
    edits: [
      { old_string: "a", new_string: "b", replace_all: true },
      { old_string: "c", new_string: "d" },
    ],
  });
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/`);
      const card = page.locator(`[data-permission="${id}"]`);
      await card.waitFor();
      assert.deepEqual(await card.locator(".perm-del, .perm-add").allTextContents(), ["- a", "+ b", "- c", "+ d"]);
      assert.deepEqual(await card.locator(".perm-fields dt").allTextContents(), ["replace_all"], "the first edit's replace_all, and nothing for the second");
      assert.equal(await card.locator(".perm-fields .perm-widens").count(), 1);
      // It follows its own edit's change.
      assert.equal(await card.locator(".perm-call + .perm-fields").count(), 1);
    },
    new Hoop(new Store(h)),
  );
});

test("regression: a retry right after a failed Allow once gets a whole hold", { skip: BROWSER_SKIP }, async () => {
  const { h, first, second } = twoPrompts();
  await withBrowser(
    async ({ base, page }) => {
      let fail = true;
      await page.route("**/api/permissions/*", (route) =>
        route.request().method() === "POST" && fail
          ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"no"}' })
          : route.continue(),
      );
      await homeFast(page, base);
      const allow = page.locator(`[data-permission="${first}"] [data-perm-allow]`);
      await allow.waitFor();
      await settled(page);
      await allow.click();
      await page.locator(`[data-permission="${first}"] .rename-error`, { hasText: "no" }).waitFor();
      fail = false;
      await page.waitForTimeout(600);
      const y = await allowY(page, second);
      await allow.click();
      await page.locator(`[data-permission-note="${first}"]`).waitFor();
      for (const wait of [300, 400, 400]) {
        await page.waitForTimeout(wait);
        assert.ok(Math.abs((await allowY(page, second)) - y) < 1, "the next card keeps its place for the whole hold");
      }
    },
    new Hoop(new Store(h)),
  );
});

test("regression: a hold behind an open Deny box counts down only once the card shows answered, and its redraw starts the quiet moment", {
  skip: BROWSER_SKIP,
}, async () => {
  const { h, first, second } = twoPrompts();
  await withBrowser(
    async ({ base, page }) => {
      await homeFast(page, base);
      await page.locator(`[data-permission="${second}"] [data-perm-allow]`).waitFor();
      await settled(page);
      await stretchQuiet(page);
      await page
        .locator(`[data-permission="${second}"]`)
        .getByRole("button", { name: /^Deny:/ })
        .click();
      // Answered in the terminal while the box is open: the loads that bring it wait.
      settlePermission(h, first, "terminal");
      await page.waitForTimeout(2000);
      await page.keyboard.press("Escape");
      await page.locator(`[data-permission-note="${first}"]`).waitFor();
      const y = await allowY(page, second);
      // The quiet moment: a press right after the redraw allows nothing.
      await page.locator(`[data-permission="${second}"] [data-perm-allow]`).click();
      await page.waitForTimeout(300);
      assert.equal(readPermission(h, second)!.state, "waiting", "a press right after the cards changed counts for nothing");
      await page.waitForTimeout(700);
      assert.ok(Math.abs((await allowY(page, second)) - y) < 1, "the hold still holds a second after the card showed answered");
    },
    new Hoop(new Store(h)),
  );
});

/** A second session with work, newer than the first, so Work lists it on top. */
const OTHER = "99999999-2222-3333-4444-555555555555";
/** A prompt in `session`. */
const askIn = (h: string, session: string, command: string) =>
  askPermission(h, { ...INPUTS["permission-request"], session_id: session, tool_name: "Bash", tool_input: { command } }, new Date((tick += 5))).id;

/** Two sessions with the same work and the same prompt, the second session newest and so on top. */
function twoSessions() {
  const h = home();
  workHook(
    h,
    {
      ...HOOKS["post-taskcreate"],
      session_id: OTHER,
      tool_input: { subject: "Read the code" },
      tool_response: { task: { id: "1", subject: "Read the code" } },
    },
    new Date(Date.now() + 1000).toISOString(),
  );
  return { h, older: askIn(h, SESSION, "npm test"), newer: askIn(h, OTHER, "npm test") };
}

/** Opens Work, asking for its lists every 200 ms. */
async function workFast(page: import("playwright-core").Page, base: string) {
  await page.addInitScript(() => Object.assign(window, { HOOP_WORK_MS: 200 }));
  await page.goto(`${base}/work`);
}

type Page = import("playwright-core").Page;
/**
 * Runs `fn` on Work with two sessions' prompts of the same name, once both show and the quiet
 * moment has passed.
 */
function onTwoSessions(fn: (page: Page, s: ReturnType<typeof twoSessions>) => Promise<void>) {
  const s = twoSessions();
  return withBrowser(
    async ({ base, page }) => {
      await workFast(page, base);
      await page.locator(`[data-permission="${s.older}"] [data-perm-allow]`).waitFor();
      await settled(page);
      await fn(page, s);
    },
    new Hoop(new Store(s.h)),
  );
}

test("regression: when sessions swap places on Work, a press where a card was allows nothing", { skip: BROWSER_SKIP }, async () => {
  await onTwoSessions(async (page, { h, older, newer }) => {
    await stretchQuiet(page);
    const box = (await page.locator(`[data-permission="${newer}"] [data-perm-allow]`).boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    assert.ok((await allowY(page, older)) > box.y, "the newer session is on top");
    // The older session does something else: it moves to the top, and its card to where the other was.
    editWork(h, SESSION, (r) => {
      r.updated = new Date(Date.now() + 5000).toISOString();
    });
    await page.waitForFunction(
      ([id, px, py]) => document.elementFromPoint(px as number, py as number)?.getAttribute("data-perm-allow") === id,
      [older, x, y] as const,
      { timeout: 5000, polling: 10 },
    );
    await page.mouse.click(x, y);
    await page.waitForTimeout(300);
    assert.deepEqual(
      [readPermission(h, older)!.state, readPermission(h, newer)!.state],
      ["waiting", "waiting"],
      "a press right after the cards moved counts for nothing",
    );
  });
});

test("regression: a prompt answered in the terminal leaves focus on its own note, not another card's Allow once of the same name", {
  skip: BROWSER_SKIP,
}, async () => {
  await onTwoSessions(async (page, { h, older, newer }) => {
    const allow = page.locator(`[data-permission="${newer}"] [data-perm-allow]`);
    assert.equal(
      await allow.getAttribute("aria-label"),
      await page.locator(`[data-permission="${older}"] [data-perm-allow]`).getAttribute("aria-label"),
      "both buttons have the same name",
    );
    await allow.focus();
    settlePermission(h, newer, "terminal");
    await page.locator(`[data-permission-note="${newer}"]`).waitFor();
    await page.waitForTimeout(500);
    assert.deepEqual(
      await page.evaluate(() => [document.activeElement?.getAttribute("data-permission-note"), document.activeElement?.getAttribute("data-perm-allow")]),
      [newer, null],
      "focus is on the answered prompt's note",
    );
  });
});

/** Waits, checking often, until a prompt's Allow once sits more than a pixel `way` from `y` on screen. */
const allowMoves = (page: Page, id: string, y: number, way: "up" | "down") =>
  page.waitForFunction(
    ([pid, at, w]) => {
      const now = document.querySelector(`[data-permission="${pid}"] [data-perm-allow]`)!.getBoundingClientRect().top;
      return w === "up" ? now < at - 1 : now > at + 1;
    },
    [id, y, way] as const,
    { timeout: 5000, polling: 10 },
  );

/** Shows `text` in the page's banner, or clears it. A string, so the page's own module path needs no types. */
const banner = (page: Page, text: string) => page.evaluate(`import("/frame.js").then((m) => m.setBanner(${JSON.stringify(text)}))`);

/**
 * Presses a prompt's Allow once, and checks the press counted for nothing: it sent no answer within
 * two seconds, and an answer it did send is waited for, however slow the server, before the check.
 */
async function pressIgnored(page: Page, h: string, id: string, why: string) {
  const sent = page
    .waitForRequest((r) => r.method() === "POST" && r.url().includes("/api/permissions/"), { timeout: 2000 })
    .then(
      (r) => r.response(),
      () => null,
    );
  await page.locator(`[data-permission="${id}"] [data-perm-allow]`).click();
  assert.equal(await sent, null, `${why}: the press sent an answer`);
  assert.equal(readPermission(h, id)!.state, "waiting", why);
}

test("regression: a note that expires moves the cards below, and Allow once waits a moment", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const old = ask(h, "Bash", { command: "ls" });
  const id = ask(h, "Bash", { command: "echo two" });
  await withBrowser(
    async ({ base, page }) => {
      await workFast(page, base);
      await page.locator(`[data-permission="${id}"] [data-perm-allow]`).waitFor();
      await settled(page);
      await stretchQuiet(page);
      // Answered almost ten minutes ago, once the page shows: its note goes from the page in four
      // seconds, well after its hold lets go.
      settlePermission(h, old, "terminal", new Date(Date.now() - 10 * 60 * 1000 + 4000));
      await page.locator(`[data-permission-note="${old}"]`).waitFor();
      await page.waitForFunction((pid) => !document.querySelector(`[data-permission-note="${pid}"]`), old, { timeout: 10000, polling: 10 });
      await pressIgnored(page, h, id, "a press right after the card moved counts for nothing");
    },
    new Hoop(new Store(h)),
  );
});

test("regression: a card that moves with no redraw, as when the window narrows, makes Allow once wait", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const id = ask(h, "Bash", { command: "npm test", description: "Run the tests ".repeat(30).trim() });
  await withBrowser(
    async ({ base, page }) => {
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.goto(`${base}/`);
      await page.locator(`[data-permission="${id}"] [data-perm-allow]`).waitFor();
      await settled(page);
      await stretchQuiet(page);
      const y = await allowY(page, id);
      // The description above the buttons wraps onto more lines.
      await page.setViewportSize({ width: 420, height: 900 });
      await allowMoves(page, id, y, "down");
      await pressIgnored(page, h, id, "a press right after the card moved counts for nothing");
    },
    new Hoop(new Store(h)),
  );
});

test("regression: a card that slides down on screen as the scroll clamps makes Allow once wait", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const id = ask(h, "Bash", { command: "npm test" });
  await withBrowser(
    async ({ base, page }) => {
      await page.setViewportSize({ width: 1000, height: 600 });
      await workFast(page, base);
      const allow = page.locator(`[data-permission="${id}"] [data-perm-allow]`);
      await allow.waitFor();
      await settled(page);
      await stretchQuiet(page);
      // Scrolled to the bottom of a page made taller, with the card near the top of the screen: the
      // next redraw drops what made it taller, the browser pulls the scroll back, and the card slides down.
      const y = await page.evaluate((pid) => {
        const b = document.querySelector(`[data-permission="${pid}"] [data-perm-allow]`)!;
        const top = b.getBoundingClientRect().top + window.scrollY;
        const spacer = document.createElement("div");
        spacer.style.height = `${Math.max(0, top - 100 + window.innerHeight - document.documentElement.scrollHeight)}px`;
        document.getElementById("app")!.append(spacer);
        window.scrollTo(0, top - 100);
        return b.getBoundingClientRect().top;
      }, id);
      assert.ok(y > 50 && y < 200, `the card is near the top of the screen (${y})`);
      await allowMoves(page, id, y, "down");
      await pressIgnored(page, h, id, "a press right after the card slid counts for nothing");
    },
    new Hoop(new Store(h)),
  );
});

test("the person's own scrolling never makes Allow once wait", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const id = ask(h, "Bash", { command: "npm test", description: "Run the tests ".repeat(60).trim() });
  await withBrowser(
    async ({ base, page }) => {
      await page.setViewportSize({ width: 600, height: 400 });
      await workFast(page, base);
      const allow = page.locator(`[data-permission="${id}"] [data-perm-allow]`);
      await allow.waitFor();
      await allow.scrollIntoViewIfNeeded();
      await settled(page);
      await page.mouse.wheel(0, 60);
      // Past at least one redraw, which finds the card where the scroll put it.
      await page.waitForTimeout(300);
      await allow.click();
      await page.locator(`[data-permission-note="${id}"]`).waitFor();
      assert.equal(readPermission(h, id)!.state, "allowed");
    },
    new Hoop(new Store(h)),
  );
});

/**
 * Runs `fn` on Home, `height` px tall, with one prompt (with `description`) below the banner, after
 * the banner showed and cleared again, as a pages check that came back clears it. `fn`'s `before`
 * runs while the banner still shows.
 */
function afterBanner(height: number, description: string, fn: (page: Page, h: string, id: string) => Promise<void>, before?: (page: Page) => Promise<unknown>) {
  const h = home();
  const id = ask(h, "Bash", { command: "npm test", description });
  return withBrowser(
    async ({ base, page }) => {
      await page.setViewportSize({ width: 800, height });
      await page.goto(`${base}/`);
      await page.locator(`[data-permission="${id}"] [data-perm-allow]`).waitFor();
      await banner(page, "The pages stopped. Any hoop command or a new session starts them again.");
      // The page looks at the cards while the banner shows, as it does on any redraw.
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      await settled(page);
      await before?.(page);
      const y = await allowY(page, id);
      await banner(page, "");
      await allowMoves(page, id, y, "up");
      await fn(page, h, id);
    },
    new Hoop(new Store(h)),
  );
}

test("regression: a banner above the cards that clears makes Allow once wait", { skip: BROWSER_SKIP }, () =>
  afterBanner(900, "Run the tests", (page, h, id) => pressIgnored(page, h, id, "a press right after the banner cleared counts for nothing"), stretchQuiet),
);

test("regression: after a banner clears, the person's own scroll never makes Allow once wait", { skip: BROWSER_SKIP }, () =>
  afterBanner(300, "Run the tests ".repeat(80).trim(), async (page, h, id) => {
    await settled(page);
    // A wrong quiet moment would last long enough to catch the press.
    await stretchQuiet(page);
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 40);
    await page.waitForFunction((was) => window.scrollY !== was, before);
    await page.locator(`[data-permission="${id}"] [data-perm-allow]`).click();
    await page.locator(`[data-permission-note="${id}"]`).waitFor();
    assert.equal(readPermission(h, id)!.state, "allowed");
  }),
);
