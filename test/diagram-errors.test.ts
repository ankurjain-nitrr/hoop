import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { parseMarkdown } from "../src/markdown.js";
import type { Page } from "playwright-core";
import { BROWSER_SKIP, MERMAID_URL, serveMermaid, tempHome, withBrowser } from "./helpers.js";
import type { AddressInfo } from "node:net";
import { createWebServer } from "../src/web.js";

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

const doc = (diagram: string) => parseMarkdown(`# Feed design\n\nHow the feed is built.\n\n## Flow\n\nThe steps.\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n`);
const BROKEN = "flowchart LR\n  a[Start --> b";
const GOOD = "flowchart LR\n  a[Start] --> b[End]";

const setup = () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(doc(BROKEN));
  const flow = hoop.store.revision(review_id).items.find((i) => i.title === "Flow")!.id;
  return { hoop, review_id, flow };
};

test("a diagram the page couldn't draw comes back in feedback, with its section, first line and the error", () => {
  const { hoop, review_id, flow } = setup();
  assert.equal(hoop.feedback(review_id).diagram_errors, undefined);
  assert.equal(hoop.reportDiagram(review_id, { revision: 1, item: flow, line: 2, message: "Parse error on line 2" }), true);
  assert.deepEqual(hoop.feedback(review_id).diagram_errors, [
    { item: flow, line: 2, section: "Flow", first_line: "flowchart LR", message: "Parse error on line 2" },
  ]);
  // The same error again writes nothing.
  assert.equal(hoop.reportDiagram(review_id, { revision: 1, item: flow, line: 2, message: "Parse error on line 2" }), false);
});

test("a report on an older revision or on a line that isn't a diagram changes nothing, and a new revision starts clean", () => {
  const { hoop, review_id, flow } = setup();
  assert.equal(hoop.reportDiagram(review_id, { revision: 1, item: flow, line: 1, message: "not a diagram" }), false);
  assert.throws(() => hoop.reportDiagram(review_id, { revision: 1, item: flow, message: "x" }), /expected/);
  hoop.reportDiagram(review_id, { revision: 1, item: flow, line: 2, message: "Parse error" });
  hoop.receive(review_id);
  hoop.submit({ ...doc(GOOD), review_id }, 1);
  assert.equal(hoop.reportDiagram(review_id, { revision: 1, item: flow, line: 2, message: "Parse error" }), false);
  assert.equal(hoop.feedback(review_id).diagram_errors, undefined);
});

test("the review page reports a diagram the library refuses", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    await serveMermaid(page);
    const { review_id } = hoop.submit(doc(BROKEN));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".diagram-error").waitFor();
    const until = Date.now() + 10_000;
    while (!hoop.feedback(review_id).diagram_errors && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    const [failure] = hoop.feedback(review_id).diagram_errors ?? [];
    assert.equal(failure?.section, "Flow");
    assert.equal(failure?.line, 2);
    assert.match(failure!.message, /\S/);
  });
});

/** The diagram reports the page sends, by their bodies. */
const reports = (page: Page) => {
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/diagram-error")) sent.push(r.postData() ?? "");
  });
  return sent;
};

/** Loads a review with a broken diagram, repaints it twice, and returns the reports the page sent. */
async function repaints(answer?: "refuse" | "drop") {
  let sent: string[] = [];
  await withBrowser(async ({ hoop, base, page }) => {
    await serveMermaid(page);
    sent = reports(page);
    if (answer === "refuse") await page.route("**/diagram-error", (r) => r.fulfill({ status: 400, contentType: "application/json", body: '{"error":"no"}' }));
    if (answer === "drop") await page.route("**/diagram-error", (r) => r.abort());
    const { review_id } = hoop.submit(doc(BROKEN));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".diagram-error").waitFor();
    // Each repaint draws the diagram again in a new box, and the library refuses it again.
    for (let k = 0; k < 2; k++) {
      await page.waitForTimeout(200);
      await page.evaluate(() => document.querySelector(".diagram")?.setAttribute("data-old", "1"));
      await page.locator("[data-viewed]").last().click();
      // Marking the section viewed collapses it, so the new box is in the page but hidden.
      await page.locator(".diagram:not([data-old]) .diagram-error").waitFor({ state: "attached" });
    }
    await page.waitForTimeout(300);
  });
  return sent;
}

test("the page reports a refused diagram once per page load, however often it repaints", { skip: BROWSER_SKIP }, async () => {
  const sent = await repaints();
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0]!).revision, 1);
});

test("a report hoop refused isn't sent again, and one that never reached hoop is", { skip: BROWSER_SKIP }, async () => {
  assert.equal((await repaints("refuse")).length, 1);
  assert.equal((await repaints("drop")).length, 3);
});

test("the page reports nothing when the diagram library didn't load", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    await page.route(MERMAID_URL, (r) => r.abort());
    const sent = reports(page);
    const { review_id } = hoop.submit(doc(BROKEN));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".diagram-error").waitFor();
    await page.waitForTimeout(300);
    assert.deepEqual(sent, []);
    assert.equal(hoop.feedback(review_id).diagram_errors, undefined);
  });
});

test("the diagram-error route refuses a bad body with 400 and records a good one", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(doc(BROKEN));
    const flow = hoop.store.revision(review_id).items.find((i) => i.title === "Flow")!.id;
    const send = (body: unknown) =>
      fetch(`${base}/api/reviews/${review_id}/diagram-error`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await send({ revision: 1, item: flow })).status, 400);
    assert.equal((await send([1])).status, 400);
    const ok = await send({ revision: 1, item: flow, line: 2, message: "Parse error" });
    assert.deepEqual([ok.status, await ok.json()], [201, { recorded: true }]);
  }));
