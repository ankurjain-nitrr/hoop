import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ActionChecks, Actions, type ActionItem, type NpmRunner } from "../src/actions.js";
import { Hoop } from "../src/hoop.js";
import { INSTRUCTIONS } from "../src/mcp.js";
import { OPS } from "../src/ops.js";
import { type GhRunner, PrStates } from "../src/prs.js";
import { Store } from "../src/store.js";
import { actionMessage, deliverAction } from "../src/wake.js";
import { createWebServer, type PagesOptions } from "../src/web.js";
import type { ClaudeSession } from "../src/work.js";
import { BROWSER_SKIP, cli, example, hasFocus, pagesFor, TEST_SESSION, tempHome, tsx, withBrowser } from "./helpers.js";

const add = OPS.find((o) => o.name === "action")!;
const withdraw = OPS.find((o) => o.name === "action_withdraw")!;
const PR = "https://github.com/acme/shop/pull/42";
const DESC = "The CSV export is reviewed and green.\nMerging it lets the release go out.";
const ctx = { actor: "claude" };

/** A `gh` stand-in: `pr view <url>` answers with the state in `states`; any other URL fails. */
function fakeGh(states: Record<string, string>) {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "api") return "octocat\n";
    const state = states[args[2]!];
    if (!state) throw new Error("no such pull request");
    return JSON.stringify({ title: "Add CSV export", state, mergeable: "MERGEABLE", statusCheckRollup: [] });
  };
  return { gh, calls };
}

/** An `npm` stand-in: `view <pkg>@<version> version` prints the version when it is in `published`. */
function fakeNpm(published: string[], fail = false) {
  const calls: string[][] = [];
  const npm: NpmRunner = async (args) => {
    calls.push(args);
    if (fail) throw new Error("npm ERR! code E404");
    const spec = args[1]!;
    return published.includes(spec) ? `${spec.slice(spec.lastIndexOf("@") + 1)}\n` : "";
  };
  return { npm, calls };
}

const addItem = (hoop: Hoop, title: string, done_when: Record<string, unknown>, description = DESC) =>
  add.run(hoop, { title, description, done_when } as never, ctx) as { id: string; state: string; already: boolean };

test("hoop_action adds an item with a title that says what to do, a two-line description and a check hoop can run", () => {
  const hoop = new Hoop(new Store(tempHome()), "sess-act-1");
  const { review_id } = hoop.submit(example());
  const vague = ["Review this", "review it.", "#42", "PR 42", "42", PR, "Check this"];
  for (const title of vague) assert.throws(() => addItem(hoop, title, { kind: "manual" }), /says what the person should do/, title);
  assert.throws(() => addItem(hoop, "Merge it", { kind: "manual" }, "one\ntwo\nthree"), /at most two lines/);
  assert.throws(() => addItem(hoop, "Merge it", { kind: "manual" }, " "), /description needs text/);
  assert.throws(() => addItem(hoop, "Two\nlines", { kind: "manual" }), /title is one line/);
  assert.throws(() => addItem(hoop, "Merge it", { kind: "pr_merged", url: "https://github.com/acme/shop/issues/42" }), /done_when.url/);
  assert.throws(() => addItem(hoop, "Approve it", { kind: "review_approved", review_id: "rv_nothere" }), /must name a hoop review/);
  assert.throws(() => addItem(hoop, "Ship it", { kind: "npm_version", package: "Bad Name", version: "1.0.0" }), /done_when.package/);
  assert.throws(() => addItem(hoop, "Ship it", { kind: "npm_version", package: "hoop", version: "^1.0.0" }), /exact version/);
  assert.throws(() => addItem(hoop, "Ship it", { kind: "later" }), /done_when.kind/);

  const pr = addItem(hoop, "Merge the CSV export pull request", { kind: "pr_merged", url: `${PR}/` });
  assert.match(pr.id, /^ac_[a-z0-9]+$/);
  assert.equal(pr.state, "open");
  addItem(hoop, "Approve the export plan", { kind: "review_approved", review_id });
  addItem(hoop, "Approve the staged 0.2.0 release", { kind: "npm_version", package: "@acme/shop", version: "v0.2.0" });
  addItem(hoop, "Run the database migration", { kind: "manual" });
  const items = new Actions(hoop.store).list();
  assert.equal(items.length, 4);
  assert.deepEqual(items.find((i) => i.id === pr.id)!.done_when, { kind: "pr_merged", url: PR }, "the URL is kept clean");
  assert.deepEqual(items.find((i) => i.done_when.kind === "npm_version")!.done_when, { kind: "npm_version", package: "@acme/shop", version: "0.2.0" });
  assert.equal(items[0]!.owner.session, "sess-act-1");
  // The same open item again is the first one.
  assert.deepEqual(addItem(hoop, "Merge the CSV export pull request", { kind: "pr_merged", url: PR }), { ...pr, already: true });

  const outside = new Hoop(new Store(tempHome()), null);
  assert.throws(() => addItem(outside, "Run the migration", { kind: "manual" }), /isn't in a Claude Code session/);
});

test("a session's items live in its .hoop folder, indexed in the home folder; a session without one keeps them in the home folder", () => {
  const home = tempHome();
  const session = "sess-act-folder";
  const project = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-repo-actions");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${session}.jsonl`), "");
  const own = addItem(new Hoop(new Store(home), session), "Run the migration", { kind: "manual" });
  assert.ok(existsSync(join(project, session, ".hoop", "actions", `${own.id}.json`)));
  const other = addItem(new Hoop(new Store(home), { session: "codex-1", claude: false }), "Run the seed script", { kind: "manual" });
  assert.ok(existsSync(join(home, "actions", `${other.id}.json`)));
  assert.deepEqual(
    new Actions(new Store(home))
      .list()
      .map((i) => i.id)
      .sort(),
    [own.id, other.id].sort(),
  );
});

test("only the session that added an item withdraws it, with a reason, and only while it is open", () => {
  const store = new Store(tempHome());
  const mine = new Hoop(store, "sess-act-2");
  const { id } = addItem(mine, "Run the database migration", { kind: "manual" });
  assert.throws(() => withdraw.run(new Hoop(store, "sess-act-3"), { id, reason: "Not needed" }, ctx), /belongs to another session/);
  assert.throws(() => withdraw.run(mine, { id, reason: " " }, ctx), /reason needs text/);
  assert.throws(() => withdraw.run(mine, { id: "ac_missing", reason: "x" }, ctx), /no action item ac_missing/);
  const out = withdraw.run(mine, { id, reason: "The migration ran in CI" }, ctx) as { state: string; reason: string };
  assert.deepEqual(out, { id, state: "withdrawn", reason: "The migration ran in CI" });
  const item = new Actions(store).get(id);
  assert.equal(item.closed_by, "session sess-act");
  assert.ok(item.closed_at);
  assert.throws(() => withdraw.run(mine, { id, reason: "Again" }, ctx), /already withdrawn/);
});

test("each check: a merged pull request, an approved review, a published version; a manual item never closes on its own", async () => {
  const store = new Store(tempHome());
  const hoop = new Hoop(store, "sess-act-4");
  const { review_id } = hoop.submit(example());
  const items = new Actions(store);
  const item = (title: string, done_when: Record<string, unknown>) => items.get(addItem(hoop, title, done_when).id);
  const open = item("Merge the open one", { kind: "pr_merged", url: "https://github.com/acme/shop/pull/1" });
  const merged = item("Merge the merged one", { kind: "pr_merged", url: "https://github.com/acme/shop/pull/2" });
  const closed = item("Merge the closed one", { kind: "pr_merged", url: "https://github.com/acme/shop/pull/3" });
  const unknown = item("Merge the unknown one", { kind: "pr_merged", url: "https://github.com/acme/shop/pull/4" });
  const review = item("Approve the plan", { kind: "review_approved", review_id });
  const released = item("Approve the 1.0.0 release", { kind: "npm_version", package: "@acme/shop", version: "1.0.0" });
  const staged = item("Approve the 1.1.0 release", { kind: "npm_version", package: "@acme/shop", version: "1.1.0" });
  const manual = item("Run the migration", { kind: "manual" });

  const { gh } = fakeGh({
    "https://github.com/acme/shop/pull/1": "OPEN",
    "https://github.com/acme/shop/pull/2": "MERGED",
    "https://github.com/acme/shop/pull/3": "CLOSED",
  });
  const { npm, calls } = fakeNpm(["@acme/shop@1.0.0"]);
  const checks = new ActionChecks(store, new PrStates(gh), npm);
  const done = async (i: ActionItem) => checks.done(i);
  assert.equal(await done(open), false);
  assert.equal(await done(merged), true);
  assert.equal(await done(closed), false, "closed without merging isn't done");
  assert.equal(await done(unknown), false, "a failed gh isn't done");
  assert.equal(await done(review), false);
  hoop.review(review_id, { verdict: "approved", reviewer: "owner" });
  assert.equal(await done(review), true, "the store says approved");
  assert.equal(await done(released), true);
  assert.equal(await done(staged), false);
  assert.deepEqual(calls[0], ["view", "@acme/shop@1.0.0", "version"]);
  assert.equal(await done(manual), false);
  // npm is asked at most once a minute per item, and never again once it is published.
  await Promise.all([done(staged), done(staged), done(released)]);
  assert.equal(calls.length, 2);
  // A failing npm reads as not done.
  const failing = new ActionChecks(store, new PrStates(gh), fakeNpm([], true).npm);
  assert.equal(await failing.done(released), false);
});

test("the wake messages say Done, or Won't do with the person's reason, to the session that added the item", async () => {
  const base = { id: "ac_x", title: "Merge the CSV export pull request", description: "d", done_when: { kind: "manual" as const }, created: "" };
  const owner = { session: TEST_SESSION };
  assert.equal(actionMessage({ ...base, owner, state: "done" }), "Done: Merge the CSV export pull request");
  assert.equal(
    actionMessage({ ...base, owner, state: "wont_do", reason: "We ship it next week" }),
    "Won't do: Merge the CSV export pull request — We ship it next week",
  );
  const sent: [string, string][] = [];
  const sessions = () => [{ session: TEST_SESSION, pid: 1, status: "idle", socket: "/tmp/s.sock" }];
  const send = async (socket: string, text: string) => void sent.push([socket, text]);
  assert.equal(await deliverAction({ ...base, owner, state: "open" }, { sessions, send }), undefined);
  assert.equal(await deliverAction({ ...base, owner, state: "withdrawn", reason: "x" }, { sessions, send }), undefined, "a withdrawal is the session's own");
  assert.equal((await deliverAction({ ...base, owner, state: "done" }, { sessions, send }))?.outcome, "sent");
  assert.deepEqual(sent, [["/tmp/s.sock", "Done: Merge the CSV export pull request"]]);
  assert.equal((await deliverAction({ ...base, owner: { session: "ended-1" }, state: "done" }, { sessions, send }))?.outcome, "no_session");
  const failing = async () => {
    throw new Error("refused");
  };
  assert.deepEqual(await deliverAction({ ...base, owner, state: "done" }, { sessions, send: failing, now: () => "t" }), {
    outcome: "failed",
    error: "refused",
    at: "t",
  });
  assert.match(INSTRUCTIONS, /add an action item with hoop_action/);
  assert.match(INSTRUCTIONS, /Never tell the person something is done unless its check shows it done/);
});

/** A pages server on a free port. */
async function withServer(opts: PagesOptions, fn: (base: string) => Promise<void>, hoop: Hoop) {
  const server = createWebServer(hoop, [], opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}
const postJson = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

test("the pages check open items only when Home asks, close them when done, take Done and Won't do from the person, and tell the session", async () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  const { review_id } = hoop.submit(example());
  const merged = addItem(hoop, "Merge the CSV export pull request", { kind: "pr_merged", url: PR });
  const review = addItem(hoop, "Approve the export plan", { kind: "review_approved", review_id });
  const manual = addItem(hoop, "Run the database migration", { kind: "manual" });
  const declined = addItem(hoop, "Approve the 0.2.0 release", { kind: "npm_version", package: "hoop", version: "0.2.0" });
  const { gh, calls } = fakeGh({ [PR]: "MERGED" });
  const npm = fakeNpm([]);
  const sent: string[] = [];
  const sessions = (): ClaudeSession[] => [{ session: TEST_SESSION, pid: 1, status: "idle", socket: "/tmp/s.sock" }];
  const send = async (_socket: string, text: string) => void sent.push(text);
  await withServer(
    { gh, npm: npm.npm, sessions, send },
    async (base) => {
      const plain = (await (await fetch(`${base}/api/actions`)).json()) as { id: string; state: string }[];
      assert.equal(plain.length, 4);
      assert.ok(plain.every((i) => i.state === "open"));
      assert.equal(calls.length + npm.calls.length, 0, "no gh or npm until Home asks");

      const checked = (await (await fetch(`${base}/api/actions?check=1`)).json()) as Record<string, unknown>[];
      const byId = (id: string) => checked.find((i) => i.id === id)!;
      assert.equal(byId(merged.id).state, "done");
      assert.equal(byId(merged.id).closed_by, "hoop");
      assert.ok(byId(merged.id).closed_at, "when hoop saw it done");
      assert.equal(byId(merged.id).delivery, "sent");
      assert.deepEqual(byId(merged.id).link, { href: PR, text: "acme/shop#42" });
      assert.deepEqual((byId(merged.id).session as { label: string }).label, `session ${TEST_SESSION.slice(0, 8)}`);
      assert.equal(byId(review.id).state, "open");
      assert.deepEqual(byId(review.id).link, { href: `/r/${review_id}`, text: "Order export: requirements" });
      assert.deepEqual(byId(declined.id).link, { href: "https://www.npmjs.com/package/hoop/v/0.2.0", text: "hoop@0.2.0" });
      assert.equal(byId(manual.id).link, undefined);
      assert.deepEqual(sent, ["Done: Merge the CSV export pull request"]);
      assert.equal(JSON.stringify(checked).includes("/tmp/"), false, "no paths reach the pages");

      // A second check within the minute asks neither gh nor npm again, and tells the session nothing new.
      const before = calls.length + npm.calls.length;
      await fetch(`${base}/api/actions?check=1`);
      assert.equal(calls.length + npm.calls.length, before);
      assert.equal(sent.length, 1);

      // The review approved on its page closes its item on the next check, which reads the store.
      hoop.review(review_id, { verdict: "approved", reviewer: "owner" });
      await fetch(`${base}/api/actions?check=1`);
      assert.equal(sent.at(-1), "Done: Approve the export plan");

      // Only a manual item takes the person's Done.
      const refused = await postJson(`${base}/api/actions/${declined.id}`, { action: "done" });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, /only a manual item/);
      const ticked = await postJson(`${base}/api/actions/${manual.id}`, { action: "done" });
      assert.equal(ticked.status, 201);
      assert.equal(ticked.body.state, "done");
      assert.equal(sent.at(-1), "Done: Run the database migration");
      assert.equal((await postJson(`${base}/api/actions/${manual.id}`, { action: "done" })).status, 400, "once");

      // Won't do needs a one-line reason, which goes back to the session.
      for (const reason of [undefined, " ", "two\nlines"])
        assert.equal((await postJson(`${base}/api/actions/${declined.id}`, { action: "wont_do", reason })).status, 400, String(reason));
      const no = await postJson(`${base}/api/actions/${declined.id}`, { action: "wont_do", reason: "We release on Monday" });
      assert.equal(no.status, 201);
      assert.equal(no.body.state, "wont_do");
      assert.equal(no.body.reason, "We release on Monday");
      assert.equal(sent.at(-1), "Won't do: Approve the 0.2.0 release — We release on Monday");
      assert.equal((await postJson(`${base}/api/actions/ac_missing`, { action: "done" })).status, 400);
      assert.equal((await postJson(`${base}/api/actions/${manual.id}`, { action: "other" })).status, 400);
    },
    hoop,
  );
});

test("an item waiting on a pull request that is gone or closed stays open and says it can't merge (#183)", async () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  const GONE = "https://github.com/acme/gone/pull/1";
  const CLOSED = "https://github.com/acme/shop/pull/7";
  const OUTAGE = "https://github.com/acme/shop/pull/8";
  const gone = addItem(hoop, "Merge the deleted pull request", { kind: "pr_merged", url: GONE });
  const closed = addItem(hoop, "Merge the closed pull request", { kind: "pr_merged", url: CLOSED });
  const outage = addItem(hoop, "Merge the unreadable pull request", { kind: "pr_merged", url: OUTAGE });
  const calls: string[] = [];
  const gh: GhRunner = async (args) => {
    if (args[0] === "api") return "octocat\n";
    calls.push(args[2]!);
    if (args[2] === GONE) throw Object.assign(new Error("Command failed"), { stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/gone'." });
    if (args[2] === CLOSED) return JSON.stringify({ title: "Old", state: "CLOSED" });
    throw Object.assign(new Error("Command failed"), { stderr: "HTTP 502: Bad Gateway" });
  };
  await withServer(
    { gh },
    async (base) => {
      const before = (await (await fetch(`${base}/api/actions`)).json()) as Record<string, unknown>[];
      assert.ok(
        before.every((i) => i.pr_state === undefined),
        "nothing known before Home checks",
      );
      const checked = (await (await fetch(`${base}/api/actions?check=1`)).json()) as Record<string, unknown>[];
      const byId = (id: string) => checked.find((i) => i.id === id)!;
      assert.equal(byId(gone.id).state, "open", "only the person closes it, with Won't do");
      assert.equal(byId(gone.id).pr_state, "gone");
      assert.equal(byId(closed.id).pr_state, "closed");
      assert.equal(byId(outage.id).pr_state, undefined, "a failure for now says nothing new");
      const declined = await postJson(`${base}/api/actions/${gone.id}`, { action: "wont_do", reason: "The repository was deleted" });
      assert.equal(declined.body.state, "wont_do");
      assert.equal(declined.body.pr_state, undefined, "a closed item doesn't say it");
    },
    hoop,
  );
  assert.deepEqual(calls.sort(), [CLOSED, GONE, OUTAGE].sort());
});

test("Home says an item's pull request no longer exists, and keeps Won't do on it (#183)", { skip: BROWSER_SKIP }, async () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  const GONE = "https://github.com/acme/gone/pull/1";
  const item = addItem(hoop, "Merge the deleted pull request", { kind: "pr_merged", url: GONE });
  const gh: GhRunner = async (args) => {
    if (args[0] === "api") return "octocat\n";
    throw Object.assign(new Error("Command failed"), { stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/gone'." });
  };
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(base);
      const card = page.locator("section.group", { has: page.locator("h2", { hasText: "Waiting on you" }) }).locator(`[data-action="${item.id}"]`);
      await card.locator(".m", { hasText: "no longer exists" }).waitFor();
      assert.match(await card.locator(".m").innerText(), /added .* · the pull request no longer exists on GitHub; press Won't do to clear it$/);
      assert.equal(await card.getByRole("button", { name: "Won't do: Merge the deleted pull request" }).count(), 1);
    },
    hoop,
    { gh },
  );
});

test("hoop action add and withdraw run through the pages process for the terminal's session", async () => {
  const home = tempHome();
  const env = { ...process.env, ...(await pagesFor(home)), CLAUDE_CODE_SESSION_ID: "sess-act-cli" };
  const run = (...args: string[]) => spawnSync(process.execPath, [tsx, cli, ...args, "--json"], { encoding: "utf8", env });
  const added = run(
    "action",
    "add",
    "Approve",
    "the",
    "0.2.0",
    "release",
    "--description",
    "It is staged.\\nApproving publishes it.",
    "--done-when",
    "npm_version:@acme/shop@0.2.0",
  );
  assert.equal(added.status, 0, added.stderr);
  const { id } = JSON.parse(added.stdout) as { id: string };
  const item = new Actions(new Store(home, { readOnly: true })).get(id);
  assert.equal(item.title, "Approve the 0.2.0 release");
  assert.equal(item.description, "It is staged.\nApproving publishes it.");
  assert.deepEqual(item.done_when, { kind: "npm_version", package: "@acme/shop", version: "0.2.0" });
  const bad = run("action", "add", "Merge", "it", "--description", "x", "--done-when", "pr_merged:nope");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /done_when.url/);
  const gone = run("action", "withdraw", id, "Released", "by", "CI");
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(new Actions(new Store(home, { readOnly: true })).get(id).reason, "Released by CI");
});

test("Home shows open items under Waiting on you, with Done on manual ones and Won't do with a reason; closed ones fold into Completed", {
  skip: BROWSER_SKIP,
}, async () => {
  const hoop = new Hoop(new Store(tempHome()), TEST_SESSION);
  hoop.submit(example());
  const csv = addItem(hoop, "Merge the CSV export pull request", { kind: "pr_merged", url: PR });
  const manual = addItem(hoop, "Run the database migration", { kind: "manual" });
  const merged = addItem(hoop, "Merge the docs pull request", { kind: "pr_merged", url: "https://github.com/acme/shop/pull/7" });
  const { gh } = fakeGh({ [PR]: "OPEN", "https://github.com/acme/shop/pull/7": "MERGED" });
  const sent: string[] = [];
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 300 }));
      await page.goto(base);
      const waiting = page.locator("section.group", { has: page.locator("h2", { hasText: "Waiting on you" }) });
      const completed = page.locator("section.group", { has: page.locator("h2", { hasText: "Completed" }) });
      await waiting.locator(`[data-action="${manual.id}"]`).waitFor();
      // The merged one closed on Home's first check, into Completed, which starts folded.
      await page.getByRole("button", { name: /^Completed/ }).click();
      await completed.locator(`[data-action="${merged.id}"]`).waitFor();
      assert.match(await completed.locator(`[data-action="${merged.id}"] .m`).innerText(), /hoop saw it done/);
      assert.equal(await waiting.locator(".count").innerText(), "2");
      assert.match(await page.title(), /^\(3\) /, "the tab counts the review and the two open items");
      const pr = waiting.locator(`[data-action="${csv.id}"]`);
      assert.equal(await pr.locator("h3").innerText(), "Merge the CSV export pull request");
      assert.equal(await pr.locator(".d").innerText(), "The CSV export is reviewed and green.\nMerging it lets the release go out.");
      assert.equal(await pr.locator(`.m a[href="${PR}"]`).innerText(), "acme/shop#42");
      assert.equal(await pr.locator(`.m a[href="${PR}"]`).getAttribute("target"), "_blank", "a pull request opens in a new tab");
      assert.match(await pr.locator(".m").innerText(), /from session test-ses · added .* · done when it merges/);
      assert.equal(await pr.getByRole("button", { name: "Done", exact: true }).count(), 0, "hoop checks a pull request itself");

      // Won't do asks for a reason; an empty one is refused in place.
      await pr.getByRole("button", { name: /^Won't do/ }).click();
      const reason = pr.getByLabel("Why won't you do it?");
      assert.ok(await hasFocus(reason));
      await pr.getByRole("button", { name: "Send" }).click();
      await pr.locator(".rename-error", { hasText: "reason needs text" }).waitFor();
      await reason.fill("We ship it with the next release");
      await reason.press("Enter");
      await completed.locator(`[data-action="${csv.id}"]`).waitFor();
      assert.match(await completed.locator(`[data-action="${csv.id}"]`).innerText(), /won't do .*: We ship it with the next release/);
      assert.deepEqual(sent, ["Done: Merge the docs pull request", "Won't do: Merge the CSV export pull request — We ship it with the next release"]);

      // Escape closes the form and puts focus back on Won't do.
      const row = waiting.locator(`[data-action="${manual.id}"]`);
      await row.getByRole("button", { name: /^Won't do/ }).click();
      await page.keyboard.press("Escape");
      assert.ok(await hasFocus(row.getByRole("button", { name: /^Won't do/ })));

      await row.getByRole("button", { name: "Done", exact: true }).click();
      await completed.locator(`[data-action="${manual.id}"]`).waitFor();
      assert.match(await completed.locator(`[data-action="${manual.id}"] .m`).innerText(), /marked done/);
      assert.equal(await waiting.count(), 0, "nothing waits");
      assert.equal(sent.at(-1), "Done: Run the database migration");
      await page.waitForFunction(() => document.title.startsWith("(1) "));
    },
    hoop,
    { gh, sessions: () => [{ session: TEST_SESSION, pid: 1, status: "idle", socket: "/tmp/s.sock" }], send: async (_s, text) => void sent.push(text) },
  );
});
