import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Hoop } from "../src/hoop.js";
import { verdictFor } from "../src/rules.js";
import { CLIENT_ID, SIGNIN_MS, SignIns } from "../src/signin.js";
import { Store } from "../src/store.js";
import { updateHoopConfig } from "../src/util.js";
import { createWebServer } from "../src/web.js";
import { BROWSER_SKIP, example, tempHome } from "./helpers.js";

type Answer = "pending" | "token" | "expired" | "denied" | "offline";

/** A stand-in for GitHub's device sign-in: `answer` says what the next token request gets. */
function fakeGitHub(opts: { login?: string; clientId?: string } = {}) {
  const gh = { answer: "pending" as Answer, clientIds: [] as string[], userAuth: [] as string[] };
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (form.get("client_id")) gh.clientIds.push(form.get("client_id")!);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (u.endsWith("/login/device/code"))
      return json({ device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://github.example/login/device", expires_in: 900, interval: 5 });
    if (u.endsWith("/login/oauth/access_token")) {
      if (gh.answer === "offline") throw new TypeError("fetch failed");
      if (gh.answer === "token") return json({ access_token: "gho_secret" });
      return json({ error: gh.answer === "pending" ? "authorization_pending" : gh.answer === "expired" ? "expired_token" : "access_denied" });
    }
    if (u.endsWith("/user")) {
      gh.userAuth.push(String((init?.headers as Record<string, string>)?.authorization));
      return json({ login: opts.login ?? "priya" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { gh, fetch };
}

function homeWith(settings: Record<string, unknown>) {
  const home = tempHome();
  updateHoopConfig(home, (c) => ({ ...c, signin: true, github_client_id: "Iv1.test", ...settings }));
  return home;
}

test("FR-81 to FR-84: whose verdict a page's verdict is", () => {
  assert.deepEqual(verdictFor("approved", "priya", { enabled: true }), { verdict: "approved", marks: { signed_in: { login: "priya" } } });
  assert.deepEqual(verdictFor("approved", undefined, { enabled: false }), { verdict: "approved", marks: { unverified: true } });
  const agent = verdictFor("approved", undefined, { enabled: true });
  assert.deepEqual([agent.verdict, agent.marks], ["comment", { agent_approval: true }]);
  assert.match(agent.note!, /counts as an agent's/);
  assert.deepEqual(verdictFor("changes_requested", undefined, { enabled: true }).marks, { changes_requested_by_agent: true });
  assert.deepEqual(verdictFor("comment", undefined, { enabled: true }), { verdict: "comment", marks: {} });
});

test("FR-83, FR-133, FR-143: a device sign-in waits, signs in, hands its ID over once, and lasts eight hours", async () => {
  const { gh, fetch } = fakeGitHub();
  let now = Date.now();
  const s = new SignIns(homeWith({}), { fetch, now: () => now, pollMs: 60_000 });
  const started = await s.start();
  assert.equal(started.user_code, "ABCD-1234");
  await s.check(started.flow);
  assert.equal(s.status(started.flow)!.state, "waiting");
  gh.answer = "token";
  await s.check(started.flow);
  const done = s.status(started.flow)!;
  assert.deepEqual([done.state, done.login], ["signed_in", "priya"]);
  assert.match(done.signin!, /^[a-f0-9]{64}$/);
  assert.equal(s.status(started.flow)!.signin, undefined, "the ID is handed over once");
  assert.equal(s.who(done.signin), "priya");
  assert.equal(s.who("not-a-sign-in"), undefined);
  assert.deepEqual(gh.userAuth, ["Bearer gho_secret"]);
  assert.ok(!JSON.stringify(s).includes("gho_secret"), "the token isn't kept");
  now += SIGNIN_MS + 1;
  assert.equal(s.who(done.signin), undefined, "a sign-in ends after eight hours");
});

test("FR-133, FR-137: an expired code, a denial and an unreachable GitHub each end the sign-in with a next step", async () => {
  for (const answer of ["expired", "denied", "offline"] as const) {
    const { gh, fetch } = fakeGitHub();
    const s = new SignIns(homeWith({}), { fetch, pollMs: 60_000 });
    const { flow } = await s.start();
    gh.answer = answer;
    await s.check(flow);
    const st = s.status(flow)!;
    assert.equal(st.state, answer);
    assert.ok(st.next.length > 10, st.next);
    if (answer !== "expired") assert.match(st.next, /github_client_id.*signin: false/);
  }
  const refusing = (async () =>
    new Response(JSON.stringify({ error: "device_flow_disabled" }), { headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
  const refused = new SignIns(homeWith({}), { fetch: refusing });
  await assert.rejects(refused.start(), (err: Error & { state: string }) => err.state === "not_set_up" && /github_client_id/.test(err.message));
});

test("FR-144: a person's own OAuth App signs them in", async () => {
  const { gh, fetch } = fakeGitHub({ login: "own-app-user" });
  const s = new SignIns(homeWith({ github_client_id: "Iv1.mine" }), { fetch, pollMs: 60_000 });
  const { flow } = await s.start();
  gh.answer = "token";
  await s.check(flow);
  assert.equal(s.status(flow)!.login, "own-app-user");
  assert.deepEqual([...new Set(gh.clientIds)], ["Iv1.mine"]);
});

test("FR-144: without a client ID of their own, a person signs in through hoop's OAuth App", async () => {
  const { gh, fetch } = fakeGitHub();
  await new SignIns(homeWith({ github_client_id: "" }), { fetch, pollMs: 60_000 }).start();
  assert.deepEqual(gh.clientIds, [CLIENT_ID]);
  assert.match(CLIENT_ID, /^\S+$/);
});

async function serve(home: string, fetch: typeof globalThis.fetch) {
  const hoop = new Hoop(new Store(home));
  const signins = new SignIns(home, { fetch, pollMs: 10 });
  const server = createWebServer(hoop, [], { signins });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, init: { body?: unknown; signin?: string } = {}) => {
    const res = await globalThis.fetch(base + path, {
      method: init.body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(init.signin ? { "x-hoop-signin": init.signin } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { hoop, server, base, call };
}

test("FR-81, FR-82: an approve without a sign-in is an agent approval, and the review stays open and takes comments", async () => {
  const home = homeWith({});
  const { hoop, server, call } = await serve(home, fakeGitHub().fetch);
  try {
    const { review_id } = hoop.submit(example());
    // Marks in the request count for nothing; only the browser's sign-in does.
    const res = await call(`/api/reviews/${review_id}/feedback`, { body: { verdict: "approved", signed_in: { login: "mallory" }, reviewer: "agent" } });
    assert.equal(res.status, 201);
    assert.deepEqual([res.body.verdict, res.body.agent_approval, res.body.signed_in], ["comment", true, undefined]);
    assert.match(res.body.note, /counts as an agent's/);
    assert.equal(hoop.store.meta(review_id).status, "open");
    const more = await call(`/api/reviews/${review_id}/feedback`, {
      body: { verdict: "changes_requested", comments: [{ item: "FR-3", line: 1, body: "Still open" }] },
    });
    assert.deepEqual([more.status, more.body.verdict, more.body.changes_requested_by_agent], [201, "comment", true]);
  } finally {
    server.close();
  }
});

test("FR-83, FR-85, FR-143: after the GitHub sign-in, an approval records the login and its notes, and only this browser's ID counts", async () => {
  const repo = tempHome();
  process.env.HOOP_REPO_DIR = repo;
  const { gh, fetch } = fakeGitHub();
  const { hoop, server, call } = await serve(homeWith({}), fetch);
  try {
    const { review_id } = hoop.submit(example());
    const started = await call("/api/signin", { body: {} });
    assert.equal(started.status, 201);
    gh.answer = "token";
    let st: any;
    for (let i = 0; i < 50 && st?.state !== "signed_in"; i++) {
      await sleep(20);
      st = (await call(`/api/signin/${started.body.flow}`)).body;
    }
    assert.equal(st.state, "signed_in");
    const id = st.signin;
    assert.equal((await call("/api/whoami", { signin: id })).body.login, "priya");
    assert.equal((await call("/api/whoami")).body.login, null, "a request without this browser's ID isn't signed in");
    const approved = await call(`/api/reviews/${review_id}/feedback`, { body: { verdict: "approved", summary: "Ship it after the review." }, signin: id });
    assert.deepEqual([approved.body.verdict, approved.body.signed_in], ["approved", { login: "priya" }]);
    assert.equal(hoop.store.meta(review_id).status, "approved");
    const decision = JSON.parse(readFileSync(join(repo, "decisions", "order-export-requirements.json"), "utf8"));
    assert.deepEqual([decision.approved.login, decision.approved.notes], ["priya", "Ship it after the review."]);
  } finally {
    server.close();
  }
});

test("FR-84, FR-86: with the sign-in off, an approval works and shows as unverified in the trail and the decision record", async () => {
  const repo = tempHome();
  process.env.HOOP_REPO_DIR = repo;
  const { hoop, server, call } = await serve(tempHome(), fakeGitHub().fetch);
  try {
    const { review_id } = hoop.submit(example());
    await call(`/api/reviews/${review_id}/feedback`, { body: { verdict: "comment", reviewer: "agent", comments: [{ item: "FR-3", line: 1, body: "Why?" }] } });
    const res = await call(`/api/reviews/${review_id}/feedback`, { body: { verdict: "approved", reviewer: "ankur" } });
    assert.deepEqual([res.body.verdict, res.body.unverified], ["approved", true]);
    const decision = JSON.parse(readFileSync(join(repo, "decisions", "order-export-requirements.json"), "utf8"));
    assert.equal(decision.approved.unverified, true);
    const view = (await call(`/api/reviews/${review_id}`)).body;
    assert.deepEqual(
      view.trail.map((e: any) => [e.who, e.signed_in, e.what]),
      [
        ["agent", false, "1 comment"],
        ["ankur", false, "final approval, unverified"],
      ],
    );
  } finally {
    server.close();
  }
});

test("FR-133, FR-86: the finish panel holds Submit until the sign-in, shows the code and each state, and the trail lists events", {
  skip: BROWSER_SKIP,
}, async () => {
  const { gh, fetch } = fakeGitHub();
  const home = homeWith({});
  const { hoop, server, base } = await serve(home, fetch);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: process.env.HOOP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const { review_id } = hoop.submit(example());
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("#q-Q-1-a").check(); // every question is answered before a submit
    await page.getByRole("button", { name: /Finish your review/ }).click();
    await page.locator("#v-approve").check();
    assert.equal(await page.locator("#submitReview").isDisabled(), true, "Submit waits for the sign-in");
    await page.getByRole("button", { name: "Sign in with GitHub" }).click();
    await page.getByText("ABCD-1234").waitFor();
    assert.equal(await page.getByRole("link", { name: "Open GitHub" }).getAttribute("href"), "https://github.example/login/device");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.getByRole("button", { name: "Copy code" }).click();
    await page.getByRole("button", { name: "Copied" }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "ABCD-1234", "Copy puts the code on the clipboard");
    gh.answer = "token";
    await page.getByText(/Signed in with GitHub as/).waitFor({ timeout: 10000 });
    await page.locator("#summary").fill("Looks right.");
    await page.locator("#submitReview").click();
    await page.getByText(/Review submitted: Approved/).waitFor();
    assert.equal(hoop.store.meta(review_id).status, "approved");
    await page.locator(".frame-user", { hasText: "priya" }).waitFor();
    await page.locator(".trail summary").click();
    assert.match(await page.locator(".trail").innerText(), /priya GitHub final approval/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

test("review fix: a GitHub that never answers ends the sign-in as offline, within the timeout", async () => {
  const hanging = ((_url: string | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof globalThis.fetch;
  const s = new SignIns(homeWith({}), { fetch: hanging, timeoutMs: 50 });
  const started = Date.now();
  // The abort timer doesn't hold the event loop open, so the test does while it waits.
  const keep = setInterval(() => {}, 1000);
  try {
    await assert.rejects(s.start(), (err: Error & { state: string }) => err.state === "offline");
  } finally {
    clearInterval(keep);
  }
  assert.ok(Date.now() - started < 2000);
});

test("review fix: ended flows and expired sign-ins are swept, so the pages process doesn't grow", async () => {
  const { gh, fetch } = fakeGitHub();
  let now = Date.now();
  const s = new SignIns(homeWith({}), { fetch, now: () => now, pollMs: 60_000 });
  const first = await s.start();
  gh.answer = "token";
  await s.check(first.flow);
  const id = s.status(first.flow)!.signin!;
  const sizes = () => [(s as unknown as { flows: Map<string, unknown> }).flows.size, (s as unknown as { signins: Map<string, unknown> }).signins.size];
  assert.deepEqual(sizes(), [1, 1]);
  now += SIGNIN_MS + 1;
  await s.start();
  assert.deepEqual(sizes(), [1, 0], "the old flow and the expired sign-in are gone; the new flow stays");
  assert.equal(s.who(id), undefined);
});
