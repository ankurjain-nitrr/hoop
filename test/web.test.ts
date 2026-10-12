import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { example, tempHome } from "./helpers.js";

export async function withServer(fn: (base: string, hoop: Hoop) => Promise<void>) {
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, hoop);
  } finally {
    server.close();
  }
}

test("the review API returns the latest revision with each item's lines and the previous revision", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    hoop.submit({ ...example(), review_id, items: example().items.slice(0, 2) });
    const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
    assert.equal(view.meta.revisions, 2);
    assert.equal(view.doc.items.length, 2);
    assert.equal(view.doc.items[0].lines.length, 3);
    assert.equal(view.previous.revision, 1);
    assert.equal(view.previous.items.length, 4);
    const list = await (await fetch(`${base}/api/reviews`)).json();
    assert.deepEqual(list.map((m: { id: string }) => m.id), [review_id]);
  }));

test("pages and assets are served; unknown reviews and routes are 404", () =>
  withServer(async (base, hoop) => {
    const { review_id } = hoop.submit(example());
    const page = await fetch(`${base}/r/${review_id}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /import \{ start \} from "\/app.js"/);
    assert.equal((await fetch(`${base}/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await fetch(`${base}/api/reviews/rv_missing`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  }));
