// The README's capture of the review loop (#336): a session submits a plan, the person comments on a
// line, Claude replies and revises, and the person approves. It runs on a throwaway hoop (its own
// port, home, repository and Claude folder, and a made-up session), drives Chrome through the review
// page, and writes the frames as one animated PNG to docs/review-loop.png. Run it again whenever the
// review page changes (docs/RELEASING.md). Needs Chrome.
// Usage: npx tsx scripts/readme-capture.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { crc32 } from "node:zlib";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { chrome, connectMcp, root, runHome, step } from "./lib.js";

const PORT = "4795";
const OUT = join(root, "docs/review-loop.png");
const WIDTH = 800,
  HEIGHT = 520;
const LIMIT = 1.5 * 1024 * 1024;

const home = runHome("hoop-capture-home-");
// The repository the page names: a clean folder name inside a throwaway one.
const repo = join(runHome("hoop-capture-repo-"), "billing");
mkdirSync(repo);
const claude = runHome("hoop-capture-claude-");
const env = {
  ...(process.env as Record<string, string>),
  HOOP_HOME: home,
  HOOP_REPO_DIR: repo,
  HOOP_CLAUDE_DIR: claude,
  HOOP_PORT: PORT,
  HOOP_NO_BROWSER: "1",
  CLAUDE_CODE_SESSION_ID: "c0ffee00-0000-4000-8000-000000000001",
};

const PLAN = `# Move invoices to the new billing service

*Q4 plan for the billing migration*

We move invoice creation to the new service first, then backfill old invoices.

## Steps

- Send new invoices to the billing service behind a flag.
- Backfill every invoice from the last two years overnight.
- Turn the flag on for all customers on Monday.

## Risks

Customers may see two invoices if the backfill and the flag overlap.
`;
const REVISED = PLAN.replace("Backfill every invoice from the last two years overnight.", "Backfill old invoices in batches, before the flag goes on.");

/** One frame: the page as it shows now, and how long it stays. */
type Frame = { png: Buffer; ms: number };
const frames: Frame[] = [];
const shoot = async (page: Page, ms = 1600) => {
  // The pointer goes out of the way, so no row's controls show only because it rests there, and a
  // toast that says a review went out has faded, so nothing covers the conversation.
  await page.mouse.move(0, 0);
  await page.locator(".toast").waitFor({ state: "detached", timeout: 15_000 });
  await page.waitForTimeout(150);
  frames.push({ png: await page.screenshot({ type: "png" }), ms });
};

// The session has a transcript with the title the person gave it, which the page names it by.
const transcripts = join(claude, "projects", "-capture");
mkdirSync(transcripts, { recursive: true });
writeFileSync(
  join(transcripts, `${env.CLAUDE_CODE_SESSION_ID}.jsonl`),
  `${JSON.stringify({ type: "custom-title", customTitle: "Plan the billing migration", sessionId: env.CLAUDE_CODE_SESSION_ID })}\n`,
);

// The session runs, as Claude Code records it: a session file for this process, with a messaging
// socket that takes hoop's messages, so the page shows the review reaching Claude.
const socket = join(claude, "session.sock");
const inbox = createServer((c) => c.resume());
await new Promise<void>((r) => inbox.listen(socket, r));
mkdirSync(join(claude, "sessions"), { recursive: true });
writeFileSync(
  join(claude, "sessions", `${process.pid}.json`),
  JSON.stringify({
    sessionId: env.CLAUDE_CODE_SESSION_ID,
    pid: process.pid,
    cwd: repo,
    status: "idle",
    messagingSocketPath: socket,
    startedAt: Date.now(),
  }),
);

const session = await connectMcp(env, repo);
step("the session submits a plan");
const sent = await session.call("hoop_submit", { markdown: PLAN });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, colorScheme: "light" });
  await page.goto(sent.url.replace("//localhost:", "//127.0.0.1:"));
  const line = page.getByText("Backfill every invoice");
  await line.waitFor();
  await line.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shoot(page, 2200);

  step("the person comments on a line and requests changes");
  await page.getByRole("button", { name: /^Comment on "Steps" line 2/ }).click();
  await page.locator("#cbody").pressSequentially("Two years in one night is risky. Can we batch it?", { delay: 8 });
  await shoot(page);
  await page.getByRole("button", { name: "Start a review" }).click();
  await page.locator("#finishBtn").click();
  await shoot(page, 1400);
  await page.getByRole("button", { name: "Submit review" }).click();
  await page.locator(".receipt, [data-receipt]").first().waitFor();
  await shoot(page);

  step("Claude replies and revises");
  const feedback = await session.call("hoop_feedback", { review_id: sent.review_id });
  const thread = feedback.threads[0].thread;
  await session.call("hoop_reply", { thread, body: "Yes: batches, finished before the flag goes on." });
  await session.call("hoop_submit", { markdown: REVISED, review_id: sent.review_id, base_revision: 1 });
  await page.locator("#showRevision").waitFor({ timeout: 30_000 });
  await shoot(page, 1400);
  await page.locator("#showRevision").click();
  const revised = page.getByText("Backfill old invoices in batches");
  await revised.waitFor();
  await revised.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shoot(page, 2200);

  step("the person approves");
  const resolve = page.getByRole("button", { name: "Resolve conversation" });
  while (await resolve.count()) await resolve.first().click();
  await page.locator("#finishBtn").click();
  await shoot(page, 1200);
  await page.getByRole("button", { name: "Submit review" }).click();
  await page.locator(".top").getByText("Approved").first().waitFor();
  await page.evaluate(() => scrollTo(0, 0));
  await shoot(page, 3000);
} finally {
  await browser.close();
  await session.client.close();
  inbox.close();
}

step("the frames become one animated PNG");
const apng = animate(frames);
writeFileSync(OUT, apng);
// HOOP_CAPTURE_FRAMES=<folder> also keeps each frame as its own PNG, to look over before committing.
const keep = process.env.HOOP_CAPTURE_FRAMES;
if (keep) frames.forEach((f, i) => writeFileSync(join(keep, `frame-${i + 1}.png`), f.png));
step(`${OUT}: ${frames.length} frames, ${(apng.length / 1024).toFixed(0)} KB`);
if (apng.length > LIMIT) throw new Error(`the capture is ${apng.length} bytes, over the ${LIMIT} the README allows`);

/** A PNG's chunks, as [type, data]. */
function chunks(png: Buffer): [string, Buffer][] {
  const out: [string, Buffer][] = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    out.push([png.toString("latin1", at + 4, at + 8), png.subarray(at + 8, at + 8 + len)]);
    at += 12 + len;
  }
  return out;
}

/** One chunk, with its length and CRC. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Same-sized PNG frames as one animated PNG (APNG), which loops: each frame's image data is reused
 * as is, with a frame control chunk for its size and delay.
 */
function animate(list: Frame[]): Buffer {
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])];
  const first = chunks(list[0]!.png);
  parts.push(chunk("IHDR", first.find(([t]) => t === "IHDR")![1]));
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(list.length, 0);
  actl.writeUInt32BE(0, 4);
  parts.push(chunk("acTL", actl));
  let seq = 0;
  list.forEach((f, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(WIDTH, 4);
    fctl.writeUInt32BE(HEIGHT, 8);
    fctl.writeUInt16BE(f.ms, 20);
    fctl.writeUInt16BE(1000, 22);
    parts.push(chunk("fcTL", fctl));
    for (const [type, data] of chunks(f.png))
      if (type === "IDAT") {
        if (i === 0) parts.push(chunk("IDAT", data));
        else {
          const seqBuf = Buffer.alloc(4);
          seqBuf.writeUInt32BE(seq++, 0);
          parts.push(chunk("fdAT", Buffer.concat([seqBuf, data])));
        }
      }
  });
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}
