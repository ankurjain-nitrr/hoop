import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Page } from "playwright-core";
import { example, tempHome, BROWSER_SKIP, serveMermaid, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { trackPr } from "../src/prs.js";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editWork, workHook } from "../src/work.js";
import { addChanges } from "../src/steer.js";
import { OPS } from "../src/ops.js";

// The Work page shows a busy session's todos, done ones folded, and its subagents.
const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));

/** Writes the busy session's transcript, with steps a minute and three minutes old, so it shows what it does now. */
function writeTranscript() {
  const folder = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-proj");
  mkdirSync(folder, { recursive: true });
  const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const call = (s: number, id: string, name: string, input: object) =>
    JSON.stringify({ type: "assistant", timestamp: at(s), message: { content: [{ type: "tool_use", id, name, input }] } });
  const done = (s: number, id: string) => JSON.stringify({ type: "user", timestamp: at(s), message: { content: [{ type: "tool_result", tool_use_id: id }] } });
  writeFileSync(
    join(folder, `${HOOKS["post-taskcreate"].session_id}.jsonl`),
    `${[call(180, "t1", "Edit", { file_path: "/tmp/proj/web/work.js" }), done(179, "t1"), call(60, "t2", "Bash", { command: "npm test" })].join("\n")}\n`,
  );
}

function seedWork(home: string) {
  writeTranscript();
  for (const [id, subject] of [
    ["1", "Read the code"],
    ["2", "Run the test suite"],
    ["3", "Open a pull request"],
    // Queued todos first, in the middle and last in the list, whose buttons must line up.
    ["4", "Write the changelog line"],
    ["5", "Ask for review"],
    // A todo waiting on a merge, one blocked by it, and one hoop checked as done.
    ["6", "Ship the export"],
    ["7", "Announce the export"],
    ["8", "Get the plan approved"],
  ])
    workHook(home, { ...HOOKS["post-taskcreate"], tool_input: { subject }, tool_response: { task: { id, subject } } });
  // A long description with links, folded to two lines behind "More".
  workHook(home, {
    ...HOOKS["post-taskupdate"],
    tool_input: {
      taskId: "3",
      description:
        "Open it against main once the suite passes, link it to http://localhost:4747/r/rv_missing0 and to https://github.com/acme/shop/issues/7, and say in the body which **tests** cover the change and how to run them.",
    },
  });
  workHook(home, { ...HOOKS["post-taskupdate"], tool_input: { taskId: "1", status: "completed" } });
  workHook(home, { ...HOOKS["post-taskupdate"], tool_input: { taskId: "2", status: "in_progress" } });
  const ago = new Date(Date.now() - 60_000).toISOString();
  workHook(
    home,
    { ...HOOKS["post-taskupdate"], tool_input: { taskId: "6", status: "in_progress", description: "Merge https://github.com/acme/shop/pull/1" } },
    ago,
  );
  workHook(home, { ...HOOKS["post-taskupdate"], tool_input: { taskId: "7", addBlockedBy: ["6"] } });
  const plan = new Hoop(new Store(home));
  const { review_id: planId } = plan.submit({ ...example(), slug: "work-plan", title: "Work plan" });
  workHook(
    home,
    { ...HOOKS["post-taskupdate"], tool_input: { taskId: "8", status: "in_progress", description: `See http://localhost:4747/r/${planId}` } },
    ago,
  );
  plan.review(planId, { verdict: "approved" });
  workHook(home, HOOKS["pre-agent"]);
  workHook(home, HOOKS["subagent-start"]);
  workHook(home, HOOKS["subagent-stop"]);
  // A running agent takes a comment and a stop; its transcript went quiet long ago, so it shows as stalled.
  const quiet = join(process.env.HOOP_CLAUDE_DIR!, "agent-quiet.jsonl");
  writeFileSync(quiet, "{}\n");
  utimesSync(quiet, new Date(Date.now() - 47 * 60_000), new Date(Date.now() - 47 * 60_000));
  workHook(home, { ...HOOKS["subagent-start"], agent_id: "a9running00000000", agent_transcript_path: quiet });
  // A person's changes, waiting for the gate since the session takes no messages.
  const sid = HOOKS["post-taskcreate"].session_id;
  addChanges(home, sid, [{ kind: "comment", todo: "3", text: "Draft first" }], { by: "owner", reachable: false });
  // A parked todo, and a todo the person added that the agent hasn't created yet.
  addChanges(
    home,
    sid,
    [
      { kind: "park", todo: "4" },
      { kind: "add", text: "Write the release notes" },
    ],
    { by: "owner", reachable: false },
  );
  // Comments sent to the session and seen by the agent, each with its delivery icon.
  const [sent, seen] = addChanges(
    home,
    sid,
    [
      { kind: "comment", todo: "4", text: "Keep it to one line" },
      { kind: "comment", todo: "5", text: "Ask Ana" },
    ],
    { by: "owner", reachable: false },
  )!;
  editWork(home, sid, (r) => {
    for (const c of r.changes ?? []) c.delivery = c.id === sent!.id ? "sent" : c.id === seen!.id ? "seen" : c.delivery;
  });
}

// Home lists pull requests in each state, from gh's own JSON.
const GH = JSON.parse(readFileSync(new URL("./fixtures/gh-pr-view.json", import.meta.url), "utf8"));
const PRS: Record<string, unknown> = {
  "https://github.com/acme/shop/pull/1": GH.ready,
  "https://github.com/acme/shop/pull/2": { ...GH.failing, mergeable: "CONFLICTING" },
  "https://github.com/acme/shop/pull/3": GH.review_requested,
  "https://github.com/acme/shop/pull/4": GH.merged,
  "https://github.com/acme/shop/pull/5": undefined,
  "https://github.com/acme/gone/pull/6": new Error("GraphQL: Could not resolve to a Repository with the name 'acme/gone'. (repository)"),
};
const gh = async (args: string[]) => {
  if (args[0] === "api") return "octocat\n";
  const v = PRS[args[2]!];
  if (v instanceof Error) throw v;
  if (!v) throw new Error("gh: not signed in");
  return JSON.stringify(v);
};

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/** Serious and critical axe findings on the page, as "rule: target" strings. */
/**
 * Breaks of the color rule (docs/DESIGN.md "Colors"): a link that is amber or not underlined, and a
 * pressed toggle drawn in amber. Amber is for agent work running and your move only.
 */
function colorRuleProblems(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--live");
    document.body.append(probe);
    const live = getComputedStyle(probe).color;
    probe.remove();
    const out: string[] = [];
    // Links in text: not the nav, not a whole card that is a link.
    for (const a of document.querySelectorAll("a[href]:not(header.frame a):not(a.row):not(.outline a)")) {
      const st = getComputedStyle(a);
      if (st.color === live) out.push(`link "${(a.textContent ?? "").trim().slice(0, 30)}" is amber`);
      if (!st.textDecorationLine.includes("underline")) out.push(`link "${(a.textContent ?? "").trim().slice(0, 30)}" isn't underlined`);
    }
    for (const el of document.querySelectorAll('[aria-pressed="true"]')) {
      const st = getComputedStyle(el);
      if ([st.color, st.borderTopColor, st.backgroundColor].includes(live)) out.push(`pressed "${(el.textContent ?? "").trim().slice(0, 30)}" is amber`);
    }
    return out;
  });
}

async function axeProblems(page: Page) {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const r = await (
      window as unknown as { axe: { run: () => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }
    ).axe.run();
    return r.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map(
        (v) =>
          `${v.id}: ${v.nodes
            .map((n) => n.target.join(" "))
            .slice(0, 3)
            .join(", ")}`,
      );
  });
}

/**
 * Installs `window.tabKey(el)`: what a control is (its tag, attributes and text, and which of the
 * controls like it it is), so a page that repaints itself mid-walk still names each control the
 * same way. A radio group is one key, because the arrow keys move inside it.
 */
const TAB_KEY = `window.tabKey = (el) => {
  if (el.type === "radio") return "radio " + el.name;
  const what = (e) => [e.tagName, e.id, e.getAttribute("href"), e.dataset.act, e.dataset.key, e.dataset.collapse, e.dataset.collapseAll,
    e.getAttribute("aria-label"), (e.textContent || "").trim().slice(0, 40)].join("|");
  const key = what(el);
  let n = 0;
  for (const e of document.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")) {
    if (e === el) break;
    if (what(e) === key) n++;
  }
  return key + "#" + n;
}`;

/**
 * The controls that Tab must reach: every visible link, button, field and select, by `tabKey`.
 */
const focusable = async (page: Page): Promise<string[]> => {
  await page.evaluate(TAB_KEY);
  return page.evaluate(() => {
    const keys = new Set<string>();
    const key = (window as unknown as { tabKey: (el: Element) => string }).tabKey;
    for (const el of document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")) {
      if (el.tabIndex < 0 || (el as HTMLButtonElement).disabled || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
      // A closed disclosure keeps its contents out of the Tab order, as it should.
      if (el.closest("details:not([open])") && !el.closest("summary")) continue;
      keys.add(key(el));
    }
    return [...keys];
  });
};

/**
 * Tabs until focus wraps around, and returns the marked controls it reached and any stop without a
 * focus outline. It fails when `max` stops pass without a wrap, so a long page can't hide a gap.
 */
async function tabThrough(page: Page, max = 200) {
  await page.evaluate(TAB_KEY);
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const reached = new Set<string>();
  const unlit: string[] = [];
  let first: string | null = null;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return {
        key: (window as unknown as { tabKey: (el: Element) => string }).tabKey(el),
        label: `${el.tagName.toLowerCase()} ${(el.getAttribute("aria-label") || el.textContent || el.id || "").trim().slice(0, 30)}`,
        outlined: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0,
      };
    });
    if (!stop || stop.key === first) return { reached, unlit, wrapped: true };
    first ??= stop.key;
    reached.add(stop.key);
    if (!stop.outlined) unlit.push(stop.label);
  }
  return { reached, unlit, wrapped: false };
}

/**
 * Any page's header: the lines under the title (the meta line and the tabs) start where its text
 * does (#199). A review's title text sits after its comment gutter; other titles have none.
 */
const headerAlignment = (page: Page): Promise<string[]> =>
  page.evaluate(`(() => {
    const problems = [];
    const h1 = document.querySelector(".top h1");
    if (!h1) return problems;
    const anchor = h1.querySelector(".anchor");
    const range = document.createRange();
    range.selectNodeContents(h1);
    const title = Math.round((anchor ?? range).getClientRects()[0].left);
    for (const el of document.querySelectorAll(".top > .sub, .top > .tabs")) {
      const x = Math.round(el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
      if (Math.abs(x - title) > 1) problems.push(el.className + " starts at " + x + "px, the title at " + title + "px");
    }
    return problems;
  })()`);

/**
 * A review page's header and reading column at full width: the verdict shows once, prose lines
 * keep to 60–80ch with their edit button inside that measure, the outline rail is at least 280px,
 * and the header controls are one height (#199, #200).
 */
const reviewLayout = (page: Page): Promise<string[]> =>
  page.evaluate(`(() => {
    const problems = [];
    const badges = document.querySelectorAll(".top .badge[data-status]").length;
    if (badges !== 1) problems.push("the header shows " + badges + " status badges");
    const line = document.querySelector(".lines:not(.raw) > .line:not(:has(.ln-code, .diagram))");
    const text = line.querySelector(".text");
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;width:1ch";
    text.append(probe);
    const ch = probe.getBoundingClientRect().width;
    probe.remove();
    const s = getComputedStyle(text);
    const measure = (parseFloat(getComputedStyle(line).maxWidth) - line.querySelector(".gutter").getBoundingClientRect().width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)) / ch;
    if (!(measure >= 60 && measure <= 80)) problems.push("prose lines are " + Math.round(measure) + "ch wide");
    const pencil = line.querySelector(".edit-btn");
    if (pencil && pencil.getBoundingClientRect().right > text.getBoundingClientRect().right + 1) problems.push("the edit button sits outside the prose measure");
    const rail = document.querySelector(".outline");
    if (rail.getClientRects().length && rail.getBoundingClientRect().width < 279) problems.push("the outline rail is " + rail.getBoundingClientRect().width + "px wide");
    const heights = [...document.querySelectorAll(".title-row .actions > .btn, .title-row .finish-wrap > .btn")].map((b) => Math.round(b.getBoundingClientRect().height));
    if (new Set(heights).size > 1) problems.push("header controls differ in height: " + heights.join(", "));
    return problems;
  })()`);

test("every page works in both themes, at phone width, from the keyboard, offline and with no serious accessibility problems", {
  skip: BROWSER_SKIP,
}, async () => {
  process.env.HOOP_REPO_DIR = tempHome();
  const home = tempHome();
  for (const url of Object.keys(PRS)) trackPr(home, url, "sess-pages");
  seedWork(home);
  await withBrowser(
    async ({ hoop, base, browser }) => {
      const { review_id } = hoop.submit(example());
      let revised = 0; // each theme's run rewrites a line in a new revision
      hoop.submit({ ...example(), review_id, items: example().items.slice(0, 3) });
      // A resolved conversation is on screen as a collapsed row.
      const fb = hoop.review(review_id, {
        verdict: "comment",
        reviewer: "agent",
        comments: [{ item: example().items[0].id, line: 1, body: "A resolved point." }],
      });
      hoop.review(review_id, { verdict: "comment", reviewer: "owner", comments: [], resolved_threads: [fb.comments[0]!.thread!] });
      // A document with a subtitle, nested sections, a renamed section, a table and a diagram.
      const docMd = (h: string) =>
        `# Plan\n\n*For the platform team*\n\nIntro.\n\n## ${h}\n\nA.\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\nDeep text.\n\n## Costs\n\n| Item | Cost |\n|---|--:|\n| Servers | 40 |\n\n## Flow\n\n\`\`\`mermaid\nflowchart LR\n  a[Start] --> b[End]\n\`\`\`\n`;
      // An approval that took a recommended option says so on the question.
      const approved = hoop.submit({
        ...parseMarkdown("# Pick\n\n## Question: Which store?\n\n- A. Files (recommended)\n- B. SQLite\n"),
        kind: "decision",
      }).review_id;
      // Approved as an older hoop let it be, taking the recommended option, which still shows as it was.
      const at = new Date().toISOString();
      hoop.store.addFeedback(approved, {
        schema: "hoop/feedback@0",
        review_id: approved,
        revision: 1,
        verdict: "approved",
        comments: [],
        answers: [{ item: "S-1", choice: "a", recommended: true }],
        resolved_threads: [],
        viewed: [],
        reviewer: "owner",
        at,
      });
      hoop.store.update(approved, { status: "approved", approved_at: at, approved_revision: 1 });
      // A review a newer one replaced, which Completed marks as Replaced.
      hoop.store.update(hoop.submit(parseMarkdown("# Old pick\n\nThe first try.\n")).review_id, { superseded_by: approved });
      // A conversation on a section the next revision removed, which shows under On removed sections.
      const removedReview = hoop.submit(parseMarkdown("# Moves\n\nWhy we move.\n\n## Rollout\n\n- On Friday.\n")).review_id;
      const rollout = hoop.store.revision(removedReview).items.find((i) => i.title === "Rollout")!.id;
      hoop.review(removedReview, { verdict: "changes_requested", reviewer: "ana", comments: [{ item: rollout, line: 1, body: "Not on a Friday." }] });
      hoop.receive(removedReview);
      hoop.submit({ ...parseMarkdown("# Moves\n\nWhy we move.\n"), review_id: removedReview });
      const docReview = hoop.submit(parseMarkdown(docMd("Goals"), {})).review_id;
      hoop.submit({ ...parseMarkdown(docMd("Aims"), {}), review_id: docReview });
      // A build with every kind of block.
      const build = hoop.startBuild(
        "# Cutting cloud cost\n\nWhat this helps decide.\n\n## Summary\n\n## Where the money goes\n\n### Compute\n\n- Servers\n- Storage\n\n| Item | Cost |\n|---|--:|\n| Servers | 40 |\n\n```sh\naws ce get-cost\n```\n\n```mermaid\nflowchart LR\n  a[Spend] --> b[Cut]\n```\n",
      ).review_id;
      // The person added a subtitle under the title.
      hoop.buildChange(build, { op: "add", kind: "subtitle", after: "b1" });
      // Claude wrote one section, and the person asked for another.
      hoop.buildWrite(build, "b3", "Compute is **most** of it.");
      // Claude's rewrite of the list, waiting to be accepted.
      hoop.buildChange(build, { op: "rewrite", block: "b6" });
      hoop.takeRequests(build);
      hoop.buildWriteBlock(build, "b6", "- Servers: 40\n- Storage: 20");
      // A comment on words Claude wrote, with Claude's reply beside it.
      hoop.buildChange(build, { op: "comment", block: "b10", selection: "most", comment: "How much is most?" });
      hoop.reply(hoop.takeRequests(build)[0]!.thread!, "About 70%.");
      hoop.buildChange(build, { op: "generate", block: "b5", note: "list the biggest" });
      // Claude suggested subsections, which wait to be accepted.
      hoop.buildChange(build, { op: "suggest", block: "b4", kind: "subsections" });
      hoop.buildSuggest(build, "g4", [{ heading: "### Storage", note: "Disks, buckets and backups." }, { heading: "### Egress" }]);
      // Action items in every state: waiting on a pull request, a release and the person; done, declined and withdrawn.
      const action = (title: string, done_when: Record<string, unknown>) =>
        (
          OPS.find((o) => o.name === "action")!.run(
            hoop,
            { title, description: "What to do, in a line.\nAnd why it matters, in another.", done_when } as never,
            { actor: "claude" },
          ) as { id: string }
        ).id;
      action("Merge the ready pull request", { kind: "pr_merged", url: "https://github.com/acme/shop/pull/1" });
      action("Approve the staged 0.2.0 release", { kind: "npm_version", package: "@acme/shop", version: "0.2.0" });
      action("Run the database migration", { kind: "manual" });
      action("Merge the merged pull request", { kind: "pr_merged", url: "https://github.com/acme/shop/pull/4" });
      action("Merge the deleted pull request", { kind: "pr_merged", url: "https://github.com/acme/gone/pull/6" });
      const declined = action("Rotate the API key", { kind: "manual" });
      await fetch(`${base}/api/actions/${declined}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "wont_do", reason: "It rotates on its own" }),
      });
      OPS.find((o) => o.name === "action_withdraw")!.run(
        hoop,
        { id: action("Seed the database", { kind: "manual" }), reason: "CI seeds it" },
        { actor: "claude" },
      );
      // Quick questions: one answered with a note and changed after Claude read it, one left open, and one withdrawn.
      const KEEP = {
        question: "Keep the old endpoint as an alias, or remove it?",
        context: "Two clients still call it.",
        options: [{ label: "Keep it as an alias", recommended: true }, { label: "Remove it" }],
      };
      const ask = hoop.ask({ questions: [KEEP, { question: "Which format?", options: [{ label: "CSV" }, { label: "JSON", recommended: true }] }] }).review_id;
      hoop.answer(ask, { question: "Q1", choice: "B", note: "Nobody needs it" });
      hoop.receiveAsk(ask);
      hoop.answer(ask, { question: "Q1", choice: "A" });
      const withdrawn = hoop.ask({ questions: [KEEP] }).review_id;
      hoop.withdraw(withdrawn, "Found the answer in the client logs");
      // Quick questions on a review's lines: one open, one answered and read, and one on a title changed since.
      const steps = (title: string) => `# ${title}\n\nWhy this matters.\n\n## Steps\n\nShip on Monday.\n\nThen tell the clients.\n`;
      const cards = hoop.submit(parseMarkdown(steps("Rollout"))).review_id;
      hoop.ask({ questions: [KEEP], anchor: { review_id: cards, words: "Ship on Monday" } });
      const answeredCard = hoop.ask({ questions: [KEEP], anchor: { review_id: cards, item: "S-1", line: 2 } }).review_id;
      hoop.answer(answeredCard, { question: "Q1", choice: "A", note: "Two clients still call it" });
      hoop.receiveAsk(answeredCard);
      hoop.ask({
        questions: [{ question: "Name it Rollout plan?", options: [{ label: "Yes", recommended: true }, { label: "No" }] }],
        anchor: { review_id: cards, item: "DOC", line: 1 },
      });
      hoop.submit({ ...parseMarkdown(steps("Rollout plan")), review_id: cards });
      // Each page, and the states a reviewer opens on it, are checked with axe and at phone width.
      // States named in `tab` are also checked from the keyboard.
      const pages: { name: string; path: string; ready: string; states: Record<string, (p: Page) => Promise<void>>; tab?: string[] }[] = [
        {
          name: "list",
          path: "/",
          // Pull requests and action items load after the reviews.
          ready: ".list:has(a.pr .badge) .action .badge",
          states: {
            // Sections head the page above the groups inside them, and Completed starts folded with its
            // count showing, then opens from the keyboard (#197).
            "completed open": async (p) => {
              const look = (sel: string) =>
                p
                  .locator(sel)
                  .first()
                  .evaluate((el) => {
                    const s = getComputedStyle(el);
                    return { size: parseFloat(s.fontSize), weight: Number(s.fontWeight) };
                  });
              const section = await look(".list .group h2");
              const group = await look(".list .session h3");
              assert.ok(section.size > group.size, `a section heading (${section.size}px) is larger than a group heading (${group.size}px)`);
              assert.ok(section.weight >= group.weight, "and at least as bold");
              const completed = p.getByRole("button", { name: /^Completed/ });
              assert.equal(await completed.getAttribute("aria-expanded"), "false");
              assert.match(await completed.innerText(), /^Completed\s+\d+$/);
              await completed.focus();
              await p.keyboard.press("Enter");
              await p.locator('[data-collapse="home:completed"][aria-expanded=true]').waitFor();
              await p.locator("#g-completed-body .session").first().waitFor();
            },
            // A session's name being edited in place, with a refused name in its alert.
            rename: async (p) => {
              await p.locator(".rename-btn").first().click();
              await p.locator(".rename input").fill(" ");
              await p.getByRole("button", { name: "Save" }).click();
              await p.locator(".rename-error", { hasText: "needs text" }).waitFor();
            },
            // Every session folded, each with its counts beside its name.
            "sessions collapsed": async (p) => {
              await p.keyboard.press("Escape");
              await p.getByRole("button", { name: "Collapse all" }).click();
              await p.locator(".session .fold-summary").first().waitFor();
            },
            "section collapsed": async (p) => {
              await p.getByRole("button", { name: /^Pending/ }).click();
              await p.locator('[data-collapse="home:pending"][aria-expanded=false]').waitFor();
            },
            // Notify me pressed, and the browser allows notifications.
            "notifications on": async (p) => {
              await p.context().grantPermissions(["notifications"]);
              await p.getByRole("button", { name: "Notify me" }).click();
              await p.locator('#notifyMe[aria-pressed="true"]').waitFor();
            },
            // Won't do on an action item, with an empty reason refused in its alert.
            "won't do reason": async (p) => {
              await p.getByRole("button", { name: "Won't do: Run the database migration" }).click();
              await p.getByRole("button", { name: "Send" }).click();
              await p.locator(".decline .rename-error", { hasText: "needs text" }).waitFor();
            },
          },
          tab: ["completed open", "sessions collapsed", "section collapsed", "notifications on", "won't do reason"],
        },
        {
          name: "review",
          path: `/r/${review_id}`,
          ready: ".top h1",
          states: {
            // The page checks also run with every comment hidden.
            "comments hidden": async (p) => {
              await p.locator("#hideComments").click();
              await p.locator("#app.comments-hidden").waitFor();
            },
            "comment box": async (p) => {
              await p.locator(".add-btn").nth(2).click();
              await p.locator("#cbody").waitFor();
            },
            "finish panel": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator("#finishBtn").click();
              await p.locator("#finishPop").waitFor();
            },
            "finish panel, approve": async (p) => {
              await p.locator("#v-approve").check();
              await p.locator("#v-approve:checked").waitFor();
            },
            history: async (p) => {
              await p.keyboard.press("Escape");
              await p.locator(".trail summary").click();
            },
            "changes tab": async (p) => {
              await p.locator("#tab-changes").click();
              await p.locator("#tab-changes[aria-selected=true]").waitFor();
            },
            // Claude submits a revision that rewrites a line with an unsent comment on it.
            "new revision bar": async (p) => {
              await p.locator("#tab-proposal").click();
              await p.getByRole("button", { name: "Comment on FR-1 line 1", exact: true }).click();
              await p.locator("#cbody").fill("Unsent.");
              await p.locator("#addComment").click();
              await p.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 300 }));
              await p.reload();
              await p.locator(".pending").waitFor(); // the page shows its revision before Claude submits the next
              const items = example().items.slice(0, 3);
              items[0].body = `Rewritten ${++revised}.\n${items[0].body.split("\n")[1]}`;
              hoop.receive(review_id);
              hoop.submit({ ...example(), review_id, items });
              await p.locator(".new-revision #showRevision").waitFor({ timeout: 5000 });
            },
            // The unsent comment turns Approve and Looks good, go off, with the reason beside them.
            "finish panel, approve off": async (p) => {
              await p.locator("#finishBtn").click();
              await p.locator("#approveWhy").waitFor();
            },
            "drafts from an earlier revision": async (p) => {
              await p.locator("#cancelFinish").click();
              await p.locator("#showRevision").click();
              await p.locator(".stale-drafts [data-place]").waitFor();
            },
          },
          tab: ["new revision bar", "finish panel, approve off", "drafts from an earlier revision"],
        },
        {
          name: "work",
          path: "/work",
          // The pull request's state comes on a later poll; the rows wait for it.
          ready: ".work-session .todo .why a[href$='/pull/1']",
          states: {
            "done todos open": async (p) => {
              await p.locator("details.done summary").click();
              await p.locator("details.done[open]").waitFor();
            },
            "last 5 minutes open": async (p) => {
              // The steps must be under five minutes old when the page reads them.
              writeTranscript();
              await p.locator("details.recent summary").click();
              await p.locator("details.recent[open] .steps li").first().waitFor();
            },
            "history open": async (p) => {
              await p.locator("details.history summary").click();
              await p.locator("details.history[open] .note").first().waitFor();
            },
            "finished agents and details open": async (p) => {
              await p.locator("details.finished > summary").click();
              await p.locator("details.finished[open] .agent-details > summary").first().click();
              await p.locator(".agent-details[open] dl").waitFor();
            },
            "parked open": async (p) => {
              await p.locator("details.parked summary").click();
              await p.locator("details.parked[open] .todo").waitFor();
            },
            "comment form": async (p) => {
              await p.locator('.todo[data-todo="3"] [data-act="comment"]').click();
              await p.locator(".steer-form textarea").waitFor();
            },
            "add form": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator('[data-act="add"]').click();
              await p.locator(".add-todo .steer-form input").waitFor();
            },
            "remove confirmation": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator('.todo[data-todo="3"] [data-act="remove"]').click();
              await p.locator(".confirm [data-confirm]").waitFor();
            },
            "stop confirmation": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator('.agent [data-act="stop"]').first().click();
              await p.locator(".confirm [data-confirm]").waitFor();
            },
            "sessions collapsed": async (p) => {
              await p.keyboard.press("Escape");
              await p.getByRole("button", { name: "Collapse all" }).click();
              await p.locator(".work-session .session-head .fold-summary").first().waitFor();
            },
            "todos and subagents collapsed": async (p) => {
              await p.getByRole("button", { name: "Expand all" }).click();
              await p.getByRole("button", { name: "Todos" }).first().click();
              await p.getByRole("button", { name: "Subagents" }).first().click();
              await p.locator(".part-head .fold-summary").nth(1).waitFor();
            },
          },
          tab: ["sessions collapsed", "todos and subagents collapsed"],
        },
        { name: "approved", path: `/r/${approved}`, ready: ".qbox .taken", states: {} },
        {
          name: "removed sections",
          path: `/r/${removedReview}`,
          ready: ".removed-threads .thread",
          states: {
            // The Changes tab lists the section the revision removed.
            "changes tab": async (p) => {
              await p.locator("#tab-changes").click();
              await p.locator(".removed-sections").getByText("Removed:").waitFor();
            },
          },
        },
        {
          name: "ask",
          path: `/r/${ask}`,
          ready: ".ask-q .receipt",
          states: {
            "other box": async (p) => {
              await p.locator('[data-q="Q2"][data-other]').click();
              await p.locator("#other-Q2").waitFor();
            },
            "earlier answers open": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator(".ask-history summary").click();
              await p.locator(".ask-history[open]").waitFor();
            },
          },
          tab: ["other box"],
        },
        { name: "ask withdrawn", path: `/r/${withdrawn}`, ready: ".ask .decided", states: {} },
        {
          name: "review with question cards",
          path: `/r/${cards}`,
          ready: ".ask-card .receipt",
          states: {
            "card other box": async (p) => {
              await p.locator(".ask-card [data-other]").first().click();
              await p.locator(".ask-card .ask-other input").waitFor();
            },
          },
          tab: ["card other box"],
        },
        {
          name: "build",
          path: `/r/${build}`,
          ready: ".diagram-frame.drawn",
          states: {
            "add menu": async (p) => {
              await p.locator(".add-block").first().click();
              await p.locator(".kinds").waitFor();
            },
            "editing a block": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator('[data-b-edit="b2"]').click();
              await p.locator(".btext").waitFor();
            },
            // The Subtitle field under the title (#226).
            "editing the subtitle": async (p) => {
              await p.keyboard.press("Escape");
              await p.getByRole("button", { name: "Edit Subtitle 2" }).click();
              await p.locator("input.bsub-in").waitFor();
            },
            "editing a heading": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator('[data-b-edit="b4"]').click();
              await p.locator("input.bhead-in").waitFor();
            },
            "generate note": async (p) => {
              // Tabbing through the page moved focus out of the editor, so Escape can't close it.
              // Several blocks can be open in Edit; close each.
              while (await p.locator("[data-b-cancel]").count()) await p.locator("[data-b-cancel]").first().click();
              await p.locator("[data-b-gen]").first().click();
              await p.locator(".bgen input").waitFor();
            },
            // Remove on a heading with a section asks whether the section goes too.
            "remove choice": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator('[data-b-remove="b4"]').click();
              await p.locator(".bremove").waitFor();
            },
            "section folded": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator('[data-b-fold="b4"]').click();
              await p.locator(".bfolded").waitFor();
            },
            "suggest outline notes": async (p) => {
              await p.locator('[data-b-fold="b4"]').click();
              await p.locator('[data-b-suggest="b1"]').click();
              await p.locator(".bgen textarea").waitFor();
            },
            "editing a suggestion": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator("[data-b-retitle]").first().click();
              await p.locator(".bprop-in").waitFor();
            },
            "generate again note": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator("[data-b-regen]").first().click();
              await p.locator(".bgen input[name=note]").waitFor();
            },
            "what it said before": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator(".bbefore summary").first().click();
              await p.locator(".bbefore[open] .bbefore-body").waitFor();
            },
            "comment form": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator("[data-b-comment]").first().click();
              await p.locator(".bcomment-form textarea").waitFor();
            },
            "edit all": async (p) => {
              await p.keyboard.press("Escape");
              await p.locator("#modeAll").click();
              await p.locator(".bblock.editing .bfmts").first().waitFor();
            },
          },
          tab: [
            "editing a block",
            "editing the subtitle",
            "editing a heading",
            "remove choice",
            "section folded",
            "suggest outline notes",
            "editing a suggestion",
            "generate again note",
            "what it said before",
            "comment form",
            "edit all",
          ],
        },
        {
          name: "document",
          path: `/r/${docReview}`,
          ready: ".diagram-frame.drawn",
          states: {
            "outline collapsed": async (p) => {
              await p.setViewportSize({ width: 1400, height: 900 });
              await p.getByRole("button", { name: "Collapse Aims" }).click();
            },
            "edit in place": async (p) => {
              await p.locator(".edit-btn").first().click();
              await p.locator(".composer.in-place #csugg").waitFor();
            },
            // The subtitle under the title takes comments from the keyboard (#226).
            "subtitle comment box": async (p) => {
              await p.locator("#cancelComment").click();
              assert.equal(await p.locator(".top .subtitle .anchor").innerText(), "For the platform team");
              await p.getByRole("button", { name: "Comment on the subtitle (applies to the whole document)" }).focus();
              await p.keyboard.press("Enter");
              await p.locator("#cbody").waitFor();
            },
            // Remove on a heading, from the keyboard: the section and its subsections show struck through (#225).
            "removal suggested": async (p) => {
              if (await p.locator("#cancelComment").count()) await p.locator("#cancelComment").click();
              await p.getByRole("button", { name: 'Comment on "Aims" heading (applies to everything under it)' }).click();
              await p.getByRole("button", { name: "Remove this heading and everything under it" }).focus();
              await p.keyboard.press("Enter");
              await p.locator('#toggleRemove[aria-pressed="true"]').waitFor();
              await p.locator("#addComment").click();
              await p.locator(".thread .removal").waitFor();
              const struck = await p.locator(".item.removing .item-head .anchor").allInnerTexts();
              assert.deepEqual(
                struck.map((t) => t.trim()),
                ["Aims", "Three", "Four", "Five", "Six"],
              );
              assert.equal(
                await p
                  .locator(".item.removing .item-head .anchor")
                  .first()
                  .evaluate((el) => getComputedStyle(el).textDecorationLine),
                "line-through",
              );
              // The heading says it in words too, not only by the strike-through.
              assert.equal(await p.locator("#item-S-1 .item-head .removal-tag").innerText(), "Suggested for removal");
            },
          },
          tab: ["subtitle comment box", "removal suggested"],
        },
      ];
      const problems: string[] = [];
      const fonts = new Set<string>();
      for (const colorScheme of ["light", "dark"] as const) {
        const context = await browser.newContext({ colorScheme, viewport: { width: 1400, height: 900 } });
        const outside: string[] = [];
        // Requests to any other host are blocked, and the page must still render fully.
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.hostname === "127.0.0.1") return route.continue();
          outside.push(url.href);
          return route.abort();
        });
        await serveMermaid(context);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const phone = async (where: string, name: string) => {
          await page.setViewportSize({ width: 400, height: 800 });
          const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (wide > 0) problems.push(`${where}: scrolls ${wide}px sideways at 400px`);
          if (!(await page.locator("header.frame .brand").isVisible())) problems.push(`${where}: frame hidden at 400px`);
          if (name === "review" && !(await page.locator("#finishBtn").isVisible())) problems.push(`${where}: finish button hidden at 400px`);
          if (name === "review" && !(await page.locator("#looksGood").isVisible())) problems.push(`${where}: Looks good, go hidden at 400px`);
          if (name === "work") await rowButtons(`${where} at 400px`, where === "work (light)" || where === "work (dark)");
          await page.setViewportSize({ width: 1400, height: 900 });
        };
        // On Work, each todo button sits at the same x in every row of a session, and Remove looks destructive.
        const rowButtons = async (where: string, required: boolean) => {
          const found = await page.evaluate(() =>
            // No named functions in here: the test's compiler would wrap them in a helper the page lacks.
            [...document.querySelectorAll(".work-session ol.todos")].map((list) => {
              const [comment, remove] = ["comment", "remove"].map((act) =>
                [...list.querySelectorAll(`:scope > .todo [data-act="${act}"]`)].map((b) => Math.round(b.getBoundingClientRect().right)),
              );
              const [removeColor, commentColor] = ['[data-act="remove"]', '[data-act="comment"]'].map((s) => {
                const el = list.querySelector(s);
                return el ? getComputedStyle(el).color : "";
              });
              return {
                comment: comment!,
                remove: remove!,
                removeColor,
                commentColor,
                danger: list.querySelector('[data-act="remove"]')?.classList.contains("danger") ?? false,
                // Rows at rest (not pointed at, no focus) whose first line takes more than three lines' height.
                tall: [...list.querySelectorAll(":scope > .todo")]
                  .filter((li) => !li.matches(":hover, :focus-within") && li.querySelector(".row")!.getBoundingClientRect().height > 72)
                  .map((li) => `${li.getAttribute("data-todo") ?? "added"} (${Math.round(li.querySelector(".row")!.getBoundingClientRect().height)}px)`),
                // Rows whose buttons wrap onto more than one line.
                wrapped: [...list.querySelectorAll(":scope > .todo .acts")]
                  .filter((acts) => new Set([...acts.children].map((b) => Math.round(b.getBoundingClientRect().top))).size > 1)
                  .map((acts) => acts.closest(".todo")?.getAttribute("data-todo")),
              };
            }),
          );
          if (required && !found.some((l) => l.comment.length > 1 && l.remove.length > 2))
            problems.push(`${where}: no list with a running todo and three queued ones`);
          for (const l of found) {
            if (new Set(l.comment).size > 1) problems.push(`${where}: Comment sits at different places in one list: ${l.comment.join(", ")}`);
            if (new Set(l.remove).size > 1) problems.push(`${where}: Remove sits at different places in one list: ${l.remove.join(", ")}`);
            if (l.wrapped.length) problems.push(`${where}: the buttons of todo ${l.wrapped.join(", ")} wrap onto two lines`);
            if (l.tall.length) problems.push(`${where}: todo rows take empty room for their buttons: ${l.tall.join(", ")}`);
            if (l.remove.length && (!l.danger || l.removeColor === l.commentColor)) problems.push(`${where}: Remove doesn't look destructive`);
          }
        };
        // Tab reaches every control, and each one shows a focus outline.
        const keyboard = async (where: string) => {
          const controls = await focusable(page);
          const tab = await tabThrough(page);
          if (!tab.wrapped) problems.push(`${where}: Tab didn't wrap within 200 stops`);
          const missed = controls.filter((k) => !tab.reached.has(k));
          if (missed.length) problems.push(`${where}: Tab missed ${missed.length} of ${controls.length} controls: ${missed.slice(0, 5).join(", ")}`);
          for (const label of tab.unlit) problems.push(`${where}: no focus outline on ${label}`);
        };
        for (const p of pages) {
          const where = `${p.name} (${colorScheme})`;
          await page.goto(base + p.path);
          await page.locator(p.ready).first().waitFor();
          await page.locator("header.frame").waitFor();

          // One type scale and one content width on every page.
          const look = await page.evaluate(() => {
            const body = getComputedStyle(document.body);
            const widths = [...document.querySelectorAll<HTMLElement>("header.frame, .top, .list")].map((el) => el.getBoundingClientRect().width);
            return { font: `${body.fontFamily} ${body.fontSize}`, widest: Math.max(...widths) };
          });
          fonts.add(look.font);
          if (look.widest > 1180) problems.push(`${where}: content is ${look.widest}px wide, over 1180px`);
          for (const problem of await headerAlignment(page)) problems.push(`${where}: ${problem}`);
          if (["review", "approved", "document"].includes(p.name)) for (const problem of await reviewLayout(page)) problems.push(`${where}: ${problem}`);

          for (const a of await axeProblems(page)) problems.push(`${where} axe ${a}`);
          for (const c of await colorRuleProblems(page)) problems.push(`${where}: ${c}`);
          if (p.name === "work") await rowButtons(where, true);
          await keyboard(where);
          await phone(where, p.name);

          for (const [state, open] of Object.entries(p.states)) {
            await open(page);
            for (const a of await axeProblems(page)) problems.push(`${where}, ${state}: axe ${a}`);
            for (const c of await colorRuleProblems(page)) problems.push(`${where}, ${state}: ${c}`);
            if (p.tab?.includes(state)) await keyboard(`${where}, ${state}`);
            await phone(`${where}, ${state}`, p.name);
          }
        }
        assert.deepEqual(outside, [], "no page asks another host for anything");
        assert.deepEqual(errors, []);
        await context.close();
      }
      assert.equal(fonts.size, 1, `every page uses one body font and size: ${[...fonts].join("; ")}`);
      assert.deepEqual(problems, []);
    },
    new Hoop(new Store(home)),
    { gh, npm: async () => "", sessions: () => [{ session: HOOKS["post-taskcreate"].session_id, pid: 1, status: "busy", cwd: "/tmp/proj" }] },
  );
});

test(
  "at 1440px a long review title stays on one line, with the controls at the header's right and a medium outline entry on one line",
  {
    skip: BROWSER_SKIP,
  },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const title = "Add quick questions, plan-to-work tracing and agent evals to hoop";
      const medium = "Linking a plan to its work and tests";
      const { review_id } = hoop.submit(parseMarkdown(`# ${title}\n\nWhy.\n\n## ${medium}\n\nShip it.\n`));
      hoop.review(review_id, { verdict: "comment", reviewer: "owner", comments: [{ item: "S-1", line: 1, body: "When?" }] });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${base}/r/${review_id}`);
      await page.locator("#hideComments").waitFor();
      const oneLine = (selector: string) =>
        page
          .locator(selector)
          .first()
          .evaluate((el) => el.getBoundingClientRect().height < parseFloat(getComputedStyle(el).lineHeight) * 1.5);
      assert.ok(await oneLine(".top h1"), "the title is one line tall");
      assert.ok(await oneLine(".outline .ol-t"), `"${medium}" is one line in the outline`);
      const row = (await page.locator(".title-row").boundingBox())!;
      const finish = (await page.locator("#finishBtn").boundingBox())!;
      assert.ok(Math.abs(row.x + row.width - (finish.x + finish.width)) < 2, "Finish your review ends at the header's right edge");
      assert.deepEqual([...(await headerAlignment(page)), ...(await reviewLayout(page))], []);
    }),
);

test("a code line uses the card's full width in the Proposal and Changes views, and prose keeps to its measure", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const prose =
      "A paragraph long enough to reach the reading measure on a wide screen, so its line stops well before the card's right edge does, as it should.";
    const fence = "```";
    const md = (cmd: string) => `# Deploy\n\nWhy.\n\n## Steps\n\n${prose}\n\n${fence}sh\n${cmd}\n${fence}\n`;
    const { review_id } = hoop.submit(parseMarkdown(md("deploy --env staging")));
    hoop.submit({ ...parseMarkdown(md("deploy --env production --region eu-west-1")), review_id });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".item .lines").first().waitFor();
    const widths = () =>
      page.evaluate(`[...document.querySelectorAll(".item .lines > .line")].map((l) => ({
        code: l.textContent.includes("deploy --env"),
        text: Math.round(l.querySelector(".text").getBoundingClientRect().width),
        column: Math.round(l.parentElement.getBoundingClientRect().width - l.querySelector(".gutter").getBoundingClientRect().width),
      }))`) as Promise<{ code: boolean; text: number; column: number }[]>;
    const proposal = await widths();
    assert.ok(proposal.some((l) => l.code));
    for (const l of proposal.filter((l) => l.code)) assert.ok(Math.abs(l.text - l.column) <= 1, `Proposal: a code line is ${l.text}px of ${l.column}px`);
    assert.ok(
      proposal.some((l) => !l.code && l.text < l.column - 100),
      "Proposal: prose keeps to its measure",
    );
    await page.locator("#tab-changes").click();
    await page.locator("#tab-changes[aria-selected=true]").waitFor();
    const changes = await widths();
    assert.ok(changes.some((l) => l.code));
    for (const l of changes.filter((l) => l.code)) assert.ok(Math.abs(l.text - l.column) <= 1, `Changes: a code line is ${l.text}px of ${l.column}px`);
  }),
);
