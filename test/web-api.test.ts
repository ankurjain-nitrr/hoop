import { test } from "node:test";
import assert from "node:assert/strict";
import { api, peek, post, request } from "../web/api.js";

type Call = { path: string; init?: RequestInit };

/** Replaces `fetch` with `reply` for one test, and records each call; the page has no banner. */
function stubFetch(t: { after: (fn: () => void) => void }, reply: (path: string) => Promise<Response>): Call[] {
  const calls: Call[] = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = ((path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return reply(path);
  }) as typeof fetch;
  const g = globalThis as { document?: unknown };
  const documentBefore = g.document;
  g.document = { getElementById: () => null };
  t.after(() => {
    globalThis.fetch = fetchBefore;
    g.document = documentBefore;
  });
  return calls;
}

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

test("post sends its body as JSON, the only kind of write the API takes", async (t) => {
  const calls = stubFetch(t, () => json({ done: true }));
  assert.deepEqual(await post("/api/x", { reason: "r" }), { done: true });
  await post("/api/y", {});
  assert.equal(calls[0]?.path, "/api/x");
  assert.deepEqual(calls[0]?.init, { method: "POST", headers: { "content-type": "application/json" }, body: '{"reason":"r"}' });
  assert.equal(calls[1]?.init?.body, "{}");
});

test("a request that gets no answer throws in plain words, flagged pagesDown, and asks whether the pages answer", async (t) => {
  const calls = stubFetch(t, () => Promise.reject(new TypeError("Failed to fetch")));
  await assert.rejects(request("/api/reviews"), (err: Error & { pagesDown?: boolean }) => {
    assert.match(err.message, /^hoop's pages didn't answer\./);
    assert.equal(err.pagesDown, true);
    assert.ok(err.cause instanceof TypeError);
    return true;
  });
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/api/reviews", "/api/info"],
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(request("/api/reviews", { signal: abort.signal }), { message: "Failed to fetch" }, "an abort keeps its own error");
});

test("peek gives undefined for a refusal or no answer, and asks nothing more", async (t) => {
  const replies: Record<string, () => Promise<Response>> = {
    "/ok": () => json([1]),
    "/refused": () => json({ error: "no" }, 500),
    "/down": () => Promise.reject(new TypeError("Failed to fetch")),
  };
  const calls = stubFetch(t, (path) => replies[path]!());
  assert.deepEqual(await peek("/ok"), [1]);
  assert.equal(await peek("/refused"), undefined);
  assert.equal(await peek("/down"), undefined);
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/ok", "/refused", "/down"],
  );
});
