import { test } from "node:test";
import assert from "node:assert/strict";
import { api, peek, post, request } from "../web/api.js";
import { PAGES_STOPPED } from "../web/frame.js";
import { BROWSER_SKIP, withBrowser } from "./helpers.js";

type Call = { path: string; init?: RequestInit };
type Banner = { textContent: string; classList: { toggle: (name: string, on: boolean) => void } };

/**
 * Replaces `fetch` with `reply` for one test, and records each call. The page has a banner, empty
 * unless `banner` says otherwise.
 */
function stubFetch(t: { after: (fn: () => void) => void }, reply: (path: string) => Promise<Response>, banner = ""): { calls: Call[]; banner: Banner } {
  const calls: Call[] = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = ((path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return reply(path);
  }) as typeof fetch;
  const el: Banner = { textContent: banner, classList: { toggle: () => {} } };
  const g = globalThis as { document?: unknown };
  const documentBefore = g.document;
  g.document = { getElementById: (id: string) => (id === "banner" ? el : null) };
  t.after(() => {
    globalThis.fetch = fetchBefore;
    g.document = documentBefore;
  });
  return { calls, banner: el };
}

/** Lets the probe for whether the pages answer finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));
const down = () => Promise.reject(new TypeError("Failed to fetch"));

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

test("api returns the reply, and a refusal throws its error with the reply and status", async (t) => {
  const replies: Record<string, () => Promise<Response>> = {
    "/ok": () => json({ a: 1 }),
    "/refused": () => json({ error: "No such review." }, 404),
    "/broken": () => Promise.resolve(new Response("oops", { status: 500, statusText: "Server Error" })),
  };
  stubFetch(t, (path) => replies[path]!());
  assert.deepEqual(await api("/ok"), { a: 1 });
  await assert.rejects(api("/refused"), (err: Error & { body?: unknown; status?: number }) => {
    assert.equal(err.message, "No such review.");
    assert.deepEqual(err.body, { error: "No such review." });
    assert.equal(err.status, 404);
    return true;
  });
  await assert.rejects(api("/broken"), { message: "Server Error", status: 500 }, "a reply that isn't JSON throws its status text");
});

test("api throws on an answer that isn't JSON, and a refusal whose JSON isn't an object keeps its status", async (t) => {
  const replies: Record<string, () => Promise<Response>> = {
    "/garbled": () => Promise.resolve(new Response("<html>", { status: 200 })),
    "/null": () => Promise.resolve(new Response("null", { status: 404, statusText: "Not Found" })),
    "/number": () => Promise.resolve(new Response("7", { status: 500, statusText: "Server Error" })),
  };
  stubFetch(t, (path) => replies[path]!());
  // Regression: an answer that wasn't JSON read as {}, so the Work page's load took no sessions and broke.
  await assert.rejects(api("/garbled"), SyntaxError);
  // Regression: reading `error` of a null reply threw a TypeError that lost the status.
  await assert.rejects(api("/null"), { message: "Not Found", status: 404, body: null });
  await assert.rejects(api("/number"), { message: "Server Error", status: 500, body: 7 });
});

test("post sends its body as JSON, the only kind of write the API takes", async (t) => {
  const { calls } = stubFetch(t, () => json({ done: true }));
  assert.deepEqual(await post("/api/x", { reason: "r" }), { done: true });
  await post("/api/y", {});
  assert.equal(calls[0]?.path, "/api/x");
  assert.deepEqual(calls[0]?.init, { method: "POST", headers: { "content-type": "application/json" }, body: '{"reason":"r"}' });
  assert.equal(calls[1]?.init?.body, "{}");
});

test("a request that gets no answer throws in plain words, flagged pagesDown, and asks whether the pages answer", async (t) => {
  const { calls } = stubFetch(t, down);
  await assert.rejects(request("/api/reviews"), (err: Error & { pagesDown?: boolean }) => {
    assert.match(err.message, /^hoop's pages didn't answer\./);
    assert.equal(err.pagesDown, true);
    assert.ok(err.cause instanceof TypeError);
    return true;
  });
  await settle();
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/api/reviews", "/api/info"],
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(request("/api/reviews", { signal: abort.signal }), { message: "Failed to fetch" }, "an abort keeps its own error");
  await settle();
  assert.equal(calls.filter((c) => c.path === "/api/info").length, 1, "an abort doesn't ask whether the pages answer");
});

test("the banner says the pages stopped only when the probe gets no answer either, and clears on an answer", async (t) => {
  let info: () => Promise<Response> = down;
  const { banner } = stubFetch(t, (path) => (path === "/api/info" ? info() : down()));
  await assert.rejects(request("/api/work"));
  await settle();
  assert.equal(banner.textContent, PAGES_STOPPED, "no answer from the probe either: the pages stopped");
  banner.textContent = "";
  info = () => json({});
  await assert.rejects(request("/api/work"));
  await settle();
  assert.equal(banner.textContent, "", "a page waking from sleep, whose probe answers, doesn't warn");
});

test("an answer clears the stopped banner, and so does a probe that answers", async (t) => {
  const { banner } = stubFetch(t, (path) => (path === "/down" ? down() : json({})), PAGES_STOPPED);
  await request("/api/work");
  assert.equal(banner.textContent, "", "an answer clears it");
  banner.textContent = PAGES_STOPPED;
  await assert.rejects(request("/down"));
  await settle();
  assert.equal(banner.textContent, "", "the probe answered, so the pages run");
});

test("requests that fail together send one probe", async (t) => {
  const { calls } = stubFetch(t, down);
  await Promise.allSettled([request("/api/reviews"), request("/api/actions"), request("/api/prs")]);
  await settle();
  assert.equal(calls.filter((c) => c.path === "/api/info").length, 1);
  await assert.rejects(request("/api/reviews"));
  await settle();
  assert.equal(calls.filter((c) => c.path === "/api/info").length, 2, "a later failure probes again");
});

test("peek gives undefined for a refusal or no answer, and asks nothing more", async (t) => {
  const replies: Record<string, () => Promise<Response>> = {
    "/ok": () => json([1]),
    "/refused": () => json({ error: "no" }, 500),
    "/down": down,
  };
  const { calls } = stubFetch(t, (path) => replies[path]!());
  assert.deepEqual(await peek("/ok"), [1]);
  assert.equal(await peek("/refused"), undefined);
  assert.equal(await peek("/down"), undefined);
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/ok", "/refused", "/down"],
  );
});

test("the Work page says it couldn't read the work when the reply isn't JSON or lists no sessions", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ base, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    // Regression: either reply used to leave the page without sessions, and painting it threw.
    for (const body of ["<html>", "{}"]) {
      await page.route("**/api/work", (route) => route.fulfill({ status: 200, contentType: "application/json", body }));
      await page.goto(`${base}/work`);
      await page.getByText("Couldn't read the work:").waitFor();
      await page.unrouteAll();
    }
    assert.deepEqual(errors, []);
  });
});
