import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { parseMarkdown } from "../src/markdown.js";
import { BROWSER_SKIP, serveMermaid, tempHome, withBrowser } from "./helpers.js";

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
