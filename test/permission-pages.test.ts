import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { askPermission, readPermission, settlePermission } from "../src/permissions.js";
import { Store } from "../src/store.js";
import { workHook } from "../src/work.js";
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
const ask = (h: string, tool: string, tool_input: Record<string, unknown>) =>
  askPermission(h, { ...INPUTS["permission-request"], session_id: SESSION, tool_name: tool, tool_input }).id;

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
      assert.equal(await card.getByRole("heading").textContent(), "Waiting on you: permission");
      assert.equal(await card.locator(".tag").textContent(), "Bash");
      assert.equal(await card.locator(".perm-call").textContent(), "rm -rf build\nmkdir build", "the command in full");
      assert.equal(await card.locator(".d").textContent(), "Clean the build folder");
      assert.match((await page.locator("#g-waiting").textContent()) ?? "", /Waiting on you\s*1/, "it counts in Waiting on you");
      await card.getByRole("button", { name: "Allow once" }).click();
      const note = page.locator(`.list .perm-answered[data-permission="${id}"]`);
      await note.waitFor();
      assert.match((await note.textContent()) ?? "", /^Bash Allowed in hoop /);
      assert.match((await note.textContent()) ?? "", CLOCK);
      assert.equal(readPermission(h, id)!.state, "allowed");
    },
    new Hoop(new Store(h)),
  );
});

test("Deny opens its reason box, keeps what is typed through a refresh, and sends the reason Claude reads", { skip: BROWSER_SKIP }, async () => {
  const h = home();
  const id = ask(h, "Edit", { file_path: "/repo/src/app.ts", old_string: "const a = 1;", new_string: "const a = 2;" });
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 200 }));
      await page.goto(`${base}/`);
      const card = page.locator(`[data-permission="${id}"]`);
      await card.waitFor();
      // A change shows its file, and its lines as removed and added.
      assert.equal(await card.locator(".d").textContent(), "/repo/src/app.ts");
      assert.deepEqual(await card.locator(".perm-del, .perm-add").allTextContents(), ["- const a = 1;", "+ const a = 2;"]);
      await card.getByRole("button", { name: "Deny" }).click();
      const box = card.getByLabel("Reason (optional; Claude reads it)");
      assert.equal(await box.evaluate((el) => el === document.activeElement), true, "focus goes to the box");
      await box.fill("Keep a = 1");
      await page.waitForTimeout(700);
      assert.equal(await box.inputValue(), "Keep a = 1", "a refresh waits while the box is open");
      await card.locator("form").getByRole("button", { name: "Deny" }).click();
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
      assert.equal(await card.getByRole("heading").textContent(), "Waiting on you: permission");
      assert.equal(await card.locator(".perm-call").textContent(), "# Notes\nFirst line");
      assert.match((await page.locator(`[data-permission="${terminal}"]`).textContent()) ?? "", /^Bash Answered in the terminal /);
      assert.equal(await page.locator(`[data-permission="${handed}"]`).textContent(), "Bash Answer this in the terminal.");
      // The terminal answers first: Allow once on the page then says how it went.
      settlePermission(h, waiting, "terminal");
      await card.getByRole("button", { name: "Allow once" }).click();
      await page.locator(`[data-permission="${waiting}"]`, { hasText: "Answered in the terminal" }).waitFor();
      assert.equal(readPermission(h, waiting)!.state, "terminal", "the first answer won");
    },
    new Hoop(new Store(h)),
  );
});
