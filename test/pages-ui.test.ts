import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { Hoop } from "../src/hoop.js";
import { registerSession } from "../src/sessions.js";
import { Store } from "../src/store.js";
import { repoIdentity } from "../src/util.js";
import { createWebServer, type PagesOptions } from "../src/web.js";
import { BROWSER_SKIP, example, tempHome } from "./helpers.js";

const CHROME = process.env.HOOP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Serves the pages for `hoop` on `port` (any free one by default). */
async function serve(hoop: Hoop, opts: PagesOptions = {}, port = 0): Promise<{ server: Server; base: string; port: number }> {
  const server = createWebServer(hoop, [], opts);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const p = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${p}`, port: p };
}
const stop = (server: Server) => { server.closeAllConnections(); server.close(); };

async function browse(fn: (page: Page) => Promise<void>) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try { await fn(await browser.newPage()); } finally { await browser.close(); }
}

/** A repository folder whose tracker has one item with `title`. */
function repoWith(title: string): string {
  const dir = tempHome();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "TRACKER.md"), `# Tracker\n\n| ID | Parent | Title |\n|---|---|---|\n| T-1 | | ${title} |\n`);
  return dir;
}

/** Runs `fn` with two open repositories: the server's own, A, and B, which a live session names. */
async function twoRepos(fn: (a: string, b: string, hoop: Hoop) => Promise<void>) {
  const a = repoWith("Work in A"), b = repoWith("Work in B"), saved = process.env.HOOP_REPO_DIR;
  const hoop = new Hoop(new Store(tempHome()));
  process.env.HOOP_REPO_DIR = a;
  const remove = registerSession(hoop.store.home, b);
  try { await fn(a, b, hoop); } finally { remove(); process.env.HOOP_REPO_DIR = saved; }
}

/** Submits a review as if from `dir`. */
function submitFrom(hoop: Hoop, dir: string) {
  const saved = process.env.HOOP_REPO_DIR;
  process.env.HOOP_REPO_DIR = dir;
  try { return hoop.submit(example()).review_id; } finally { process.env.HOOP_REPO_DIR = saved; }
}

test("FR-5, FR-7: every page shows the version, and warns while the server is out of date", { skip: BROWSER_SKIP }, async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const id = hoop.submit(example()).review_id;
  let stale = true;
  const { server, base } = await serve(hoop, { stale: () => stale });
  try {
    await browse(async (page) => {
      for (const path of ["/", `/r/${id}`, "/tracker"]) {
        await page.goto(`${base}${path}`);
        await page.locator(".frame-version").waitFor();
        assert.match(await page.locator(".frame-version").innerText(), /^v\d+\.\d+\.\d+ · [0-9a-f]{7}$/, path);
        assert.match(await page.locator("#banner").innerText(), /older hoop code.*stop process \d+/, path);
      }
      stale = false;
      await page.goto(base);
      await page.locator(".frame-version").waitFor();
      assert.equal(await page.locator("#banner").innerText(), "", "a current server shows no warning");
    });
  } finally {
    stop(server);
  }
});

test("FR-5, FR-10: an open page says when the pages stopped, from its regular info request", { skip: BROWSER_SKIP }, async () => {
  const { server, base } = await serve(new Hoop(new Store(tempHome())));
  await browse(async (page) => {
    await page.addInitScript(() => { (window as any).HOOP_INFO_MS = 200; });
    await page.goto(base);
    await page.locator(".frame-version").waitFor();
    stop(server);
    await page.getByText("The pages stopped. Any hoop command or a new session starts them again.").waitFor({ timeout: 5000 });
  });
});

test("FR-8: a page whose code fails to load shows the error and the restart step in place of Loading", { skip: BROWSER_SKIP }, async () => {
  const { server, base } = await serve(new Hoop(new Store(tempHome())));
  try {
    await browse(async (page) => {
      await page.route("**/app.js", (r) => r.fulfill({ contentType: "text/javascript", body: "export const broken = ;" }));
      await page.goto(base);
      const alert = page.getByRole("alert");
      await alert.waitFor({ timeout: 6000 });
      assert.match(await alert.innerText(), /couldn't start: .+\. Stop hoop's pages process, and any hoop command starts the current one\./);
      assert.equal(await page.getByText("Loading…").count(), 0);
    });
  } finally {
    stop(server);
  }
});

test("FR-6: from one server, the tracker page offers each open repository, and each page names its document's repository", { skip: BROWSER_SKIP }, () =>
  twoRepos(async (a, b, hoop) => {
    const fromB = submitFrom(hoop, b);
    const { server, base } = await serve(hoop);
    try {
      await browse(async (page) => {
        await page.goto(`${base}/tracker`);
        await page.getByText("Work in A").waitFor();
        assert.equal(await page.locator(".frame-repo").innerText(), repoIdentity(a)!.name);
        await page.locator("#tracker-repo").selectOption(repoIdentity(b)!.key);
        await page.getByText("Work in B").waitFor();
        assert.equal(await page.locator(".frame-repo").innerText(), repoIdentity(b)!.name);
        assert.match(page.url(), new RegExp(`repo=${repoIdentity(b)!.key}`), "the address keeps the chosen repository");
        await page.reload();
        await page.getByText("Work in B").waitFor();
        await page.goto(`${base}/r/${fromB}`);
        await page.locator(".frame-repo").waitFor();
        assert.equal(await page.locator(".frame-repo").innerText(), repoIdentity(b)!.name, "a review names its own repository");
      });
    } finally {
      stop(server);
    }
  }));

test("FR-4: a reviewer's marks survive a restart, because the address stays the same", { skip: BROWSER_SKIP }, async () => {
  const hoop = new Hoop(new Store(tempHome()));
  const id = hoop.submit(example()).review_id;
  const first = await serve(hoop);
  await browse(async (page) => {
    await page.goto(`${first.base}/r/${id}`);
    const viewed = page.locator("input[data-viewed]").first();
    await viewed.check();
    stop(first.server);
    const second = await serve(hoop, {}, first.port);
    try {
      await page.reload();
      await page.locator("input[data-viewed]").first().waitFor();
      assert.equal(await page.locator("input[data-viewed]").first().isChecked(), true);
    } finally {
      stop(second.server);
    }
  });
});

test("NFR-2, FR-6: the tracker routes take an open repository's key, and no response holds a folder path", () =>
  twoRepos(async (a, b, hoop) => {
    const id = submitFrom(hoop, b);
    const { server, base } = await serve(hoop);
    try {
      const key = repoIdentity(b)!.key;
      const info = await (await fetch(`${base}/api/info`)).json();
      assert.deepEqual(info.repos.map((r: { key: string }) => r.key), [repoIdentity(a)!.key, key]);
      assert.equal("repo" in info, false, "the info names no single repository");
      const tracker = await (await fetch(`${base}/api/tracker?repo=${key}`)).json();
      assert.equal(tracker.items[0].cells.Title, "Work in B");
      const bad = await fetch(`${base}/api/trackers?repo=0000000000000000`);
      assert.equal(bad.status, 400, "an unknown key is refused");
      const paths = [a, b, realpathSync(a), realpathSync(b), realpathSync(tmpdir()), tmpdir()];
      for (const route of ["/api/info", "/api/reviews", `/api/reviews/${id}`, `/api/trackers?repo=${key}`, `/api/tracker?repo=${key}`]) {
        const text = await (await fetch(`${base}${route}`)).text();
        for (const p of paths) assert.equal(text.includes(p), false, `${route} holds ${p}`);
      }
    } finally {
      stop(server);
    }
  }));
