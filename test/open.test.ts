import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { currentUser } from "../src/util.js";
import { BROWSER_SKIP, pagesFor, sessionless, tempHome, withBrowser, hoopArgs } from "./helpers.js";

/** A terminal outside any session, with its own hoop folder and a folder for files. */
async function terminal() {
  const home = tempHome(),
    dir = tempHome();
  const pages = await pagesFor(home);
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [...hoopArgs, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(sessionless({ ...pages, HOOP_REPO_DIR: dir })).filter(([k]) => !k.startsWith("GIT_"))),
    });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  return { home, dir, run };
}

test("hoop open, from a terminal without a session, opens a file for review as the person and prints its link", async () => {
  const { home, dir, run } = await terminal();
  writeFileSync(join(dir, "plan.md"), "# Launch plan\n\nShip the export on Friday.\n");
  const printed = run(["open", "plan.md", "--no-browser"]);
  assert.equal(printed.code, 0, printed.err);
  const id = printed.out.match(/\/r\/(rv_[a-z0-9]+)/)?.[1];
  assert.ok(id, printed.out);
  assert.match(printed.out, /^Opened "Launch plan": http:\/\/localhost:\d+\/r\/rv_[a-z0-9]+\n$/);
  const meta = new Store(home).meta(id);
  assert.equal(meta.opened_by, currentUser());
  assert.equal(meta.owner, undefined, "no session owns it");
  assert.deepEqual(meta.source?.path, realpathSync(join(dir, "plan.md")));
  assert.ok(existsSync(join(home, "reviews", id, "review.json")), "it lives in the hoop home folder");
  // A session's submit from the same terminal is still refused.
  assert.equal(run(["submit", "plan.md"]).code, 1);
});

test("hoop open again revises the review only when the file changed, and supersedes an approved one", async () => {
  const { home, dir, run } = await terminal();
  const file = join(dir, "notes.md");
  writeFileSync(file, "# Notes\n\nFirst draft.\n");
  const first = run(["open", file, "--title", "Team notes", "--json"]).json();
  assert.equal(first.outcome, "created");
  assert.equal(first.opened_by, currentUser());
  assert.equal(new Store(home).meta(first.review_id).title, "Team notes");

  const same = run(["open", file, "--no-browser", "--json"]).json();
  assert.equal(same.outcome, "unchanged");
  assert.equal(same.review_id, first.review_id);
  assert.equal(same.revision, 1);
  assert.match(run(["open", file]).out, /^No change to "Team notes": /);

  writeFileSync(file, "# Notes\n\nSecond draft.\n");
  const revised = run(["open", file, "--json"]).json();
  assert.deepEqual([revised.outcome, revised.review_id, revised.revision], ["revised", first.review_id, 2]);
  assert.equal(new Hoop(new Store(home), null).feedback(first.review_id).revision, 2);

  new Hoop(new Store(home), null).review(first.review_id, { verdict: "approved" });
  writeFileSync(file, "# Notes\n\nThird draft.\n");
  const next = run(["open", file, "--json"]).json();
  assert.equal(next.outcome, "superseded");
  assert.equal(next.supersedes, first.review_id);
  assert.equal(new Store(home).meta(next.review_id).opened_by, currentUser());
  // The newer review is the one opening the file finds from now on.
  assert.equal(run(["open", file, "--json"]).json().review_id, next.review_id);
});

test("hoop open refuses a missing file and an extra argument, with the usage", async () => {
  const { run } = await terminal();
  const missing = run(["open", "nope.md"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /can't read nope\.md/);
  assert.match(missing.err, /usage: hoop open <file\.md>/);
  assert.equal(run(["open"]).code, 1);
  assert.equal(run(["open", "a.md", "b.md"]).code, 1);
});

test("on a review a person opened, any session reads, comments and replies; no session revises or proposes edits", () => {
  const home = tempHome(),
    dir = tempHome();
  const file = join(dir, "doc.md");
  writeFileSync(file, "# Policy\n\nRefunds within 30 days.\n");
  const store = new Store(home);
  const opened = new Hoop(store, null).open(file);
  const id = opened.review_id;
  const thread = new Hoop(store, null).review(id, { verdict: "comment", comments: [{ item: "S-0", line: 1, body: "Why 30?" }] }).comments[0]!.thread!;

  const a = new Hoop(store, "session-aaaa-1111"),
    b = new Hoop(store, { session: "other-agent-2222", claude: false, name: "codex" });
  assert.equal(a.feedback(id).opened_by, currentUser());
  assert.equal(a.comment(id, { item: "S-0", line: 1, body: "Consider 14 days." }).session?.id, "session-aaaa-1111");
  assert.equal(a.reply(thread, "It matches the law.").author, "session session-");
  assert.equal(b.reply(thread, "Agreed.").author, "codex (other-ag)");
  assert.equal(store.meta(id).owner, undefined, "a reply doesn't make a session the owner");

  assert.throws(() => a.submit({ ...a.store.revision(id), review_id: id }), /opened this review from a file with hoop open.*hoop open on the file again/);
  assert.throws(() => b.proposeEdits(id, thread, [{ item: "S-0", line: 1, find: "30", replace: "14" }]), /no session can propose edits/);
  // Outside a session, hoop still only reads.
  assert.throws(() => new Hoop(store, null).reply(thread, "Me"), /isn't in a Claude Code session/);
  assert.equal(store.meta(id).revisions, 1);
});

test("the review page and Home say who opened a file, and the pages never see its path", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(
    async ({ hoop, base, page }) => {
      const dir = tempHome();
      const file = join(dir, "brief.md");
      writeFileSync(file, "# Brief\n\nWhat we build next.\n");
      const { review_id } = hoop.open(file);
      const view = await (await fetch(`${base}/api/reviews/${review_id}`)).text();
      assert.ok(!view.includes(dir), "no path in the review's view");
      assert.ok(!(await (await fetch(`${base}/api/reviews`)).text()).includes(dir), "no path in the list");

      await page.goto(`${base}/r/${review_id}`);
      await page.locator(".owner").waitFor();
      assert.match(await page.locator(".owner").innerText(), new RegExp(`^Opened by ${currentUser()}`));

      await page.goto(base);
      const head = page.locator(".list .session h3").first();
      await head.waitFor();
      assert.equal((await head.innerText()).trim(), `Opened by ${currentUser()}`);
    },
    new Hoop(new Store(tempHome()), null),
  );
});
