import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Page } from "playwright-core";
import { example, tempHome, BROWSER_SKIP, serveMermaid, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { trackPr } from "../src/prs.js";
import { readFileSync } from "node:fs";
import { workHook } from "../src/work.js";
import { addChanges } from "../src/steer.js";

// The Work page shows a busy session's todos, done ones folded, and its subagents.
const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
function seedWork(home: string) {
  for (const [id, subject] of [
    ["1", "Read the code"],
    ["2", "Run the test suite"],
    ["3", "Open a pull request"],
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
  workHook(home, HOOKS["pre-agent"]);
  workHook(home, HOOKS["subagent-start"]);
  workHook(home, HOOKS["subagent-stop"]);
  // A running agent takes a comment and a stop.
  workHook(home, { ...HOOKS["subagent-start"], agent_id: "a9running00000000" });
  // A person's changes, waiting for the gate since the session takes no messages.
  addChanges(home, HOOKS["post-taskcreate"].session_id, [{ kind: "comment", todo: "3", text: "Draft first" }], { by: "owner", reachable: false });
}

// Home lists pull requests in each state, from gh's own JSON.
const GH = JSON.parse(readFileSync(new URL("./fixtures/gh-pr-view.json", import.meta.url), "utf8"));
const PRS: Record<string, unknown> = {
  "https://github.com/acme/shop/pull/1": GH.ready,
  "https://github.com/acme/shop/pull/2": { ...GH.failing, mergeable: "CONFLICTING" },
  "https://github.com/acme/shop/pull/3": GH.review_requested,
  "https://github.com/acme/shop/pull/4": GH.merged,
  "https://github.com/acme/shop/pull/5": undefined,
};
const gh = async (args: string[]) => {
  if (args[0] === "api") return "octocat\n";
  const v = PRS[args[2]!];
  if (!v) throw new Error("gh: not signed in");
  return JSON.stringify(v);
};

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/** Serious and critical axe findings on the page, as "rule: target" strings. */
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
 * Marks every control that Tab must reach, and returns how many there are: every visible link,
 * button, field and select. A radio group is one stop, because the arrow keys move inside it.
 */
const markFocusable = (page: Page) =>
  page.evaluate(() => {
    const radios = new Set<string>();
    let n = 0;
    for (const el of document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")) {
      el.removeAttribute("data-tabk");
      if (el.tabIndex < 0 || (el as HTMLButtonElement).disabled || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
      // A closed disclosure keeps its contents out of the Tab order, as it should.
      if (el.closest("details:not([open])") && !el.closest("summary")) continue;
      const r = el as HTMLInputElement;
      if (r.type === "radio") {
        if (radios.has(r.name)) continue;
        radios.add(r.name);
        for (const g of document.querySelectorAll<HTMLElement>(`input[type=radio][name="${CSS.escape(r.name)}"]`)) g.dataset.tabk = String(n);
      }
      el.dataset.tabk = String(n++);
    }
    return n;
  });

/**
 * Tabs until focus wraps around, and returns the marked controls it reached and any stop without a
 * focus outline. It fails when `max` stops pass without a wrap, so a long page can't hide a gap.
 */
async function tabThrough(page: Page, max = 200) {
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
        key: el.dataset.tabk ?? `unmarked ${el.tagName}`,
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
      // A document with nested sections, a renamed section, a table and a diagram.
      const docMd = (h: string) =>
        `# Plan\n\nIntro.\n\n## ${h}\n\nA.\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\nDeep text.\n\n## Costs\n\n| Item | Cost |\n|---|--:|\n| Servers | 40 |\n\n## Flow\n\n\`\`\`mermaid\nflowchart LR\n  a[Start] --> b[End]\n\`\`\`\n`;
      // An approval that took a recommended option says so on the question.
      const approved = hoop.submit(parseMarkdown("# Pick\n\n## Question: Which store?\n\n- A. Files (recommended)\n- B. SQLite\n")).review_id;
      hoop.review(approved, { verdict: "approved", reviewer: "owner", answers: [{ item: "S-1", choice: "a", recommended: true }] });
      const docReview = hoop.submit(parseMarkdown(docMd("Goals"), {})).review_id;
      hoop.submit({ ...parseMarkdown(docMd("Aims"), {}), review_id: docReview });
      // A build with every kind of block.
      const build = hoop.startBuild(
        "# Cutting cloud cost\n\nWhat this helps decide.\n\n## Summary\n\n## Where the money goes\n\n### Compute\n\n- Servers\n- Storage\n\n| Item | Cost |\n|---|--:|\n| Servers | 40 |\n\n```sh\naws ce get-cost\n```\n\n```mermaid\nflowchart LR\n  a[Spend] --> b[Cut]\n```\n",
      ).review_id;
      // Claude wrote one section, and the person asked for another.
      hoop.buildWrite(build, "b3", "Compute is **most** of it.");
      hoop.buildChange(build, { op: "generate", block: "b5", note: "list the biggest" });
      // Claude suggested subsections, which wait to be accepted.
      hoop.buildChange(build, { op: "suggest", block: "b4", kind: "subsections" });
      hoop.buildSuggest(build, "g2", [{ heading: "### Storage", note: "Disks, buckets and backups." }, { heading: "### Egress" }]);
      // Each page, and the states a reviewer opens on it, are checked with axe and at phone width.
      // States named in `tab` are also checked from the keyboard.
      const pages: { name: string; path: string; ready: string; states: Record<string, (p: Page) => Promise<void>>; tab?: string[] }[] = [
        {
          name: "list",
          path: "/",
          ready: ".list a.pr .badge",
          states: {
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
          },
          tab: ["sessions collapsed", "section collapsed", "notifications on"],
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
              hoop.submit({ ...example(), review_id, items });
              await p.locator(".new-revision #showRevision").waitFor({ timeout: 5000 });
            },
            "drafts from an earlier revision": async (p) => {
              await p.locator("#showRevision").click();
              await p.locator(".stale-drafts [data-place]").waitFor();
            },
          },
          tab: ["new revision bar", "drafts from an earlier revision"],
        },
        {
          name: "work",
          path: "/work",
          ready: ".work-session .agent",
          states: {
            "done todos open": async (p) => {
              await p.locator("details.done summary").click();
              await p.locator("details.done[open]").waitFor();
            },
            "history open": async (p) => {
              await p.locator("details.history summary").click();
              await p.locator("details.history[open] .note").waitFor();
            },
            "comment form": async (p) => {
              await p.locator('.todo[data-todo="3"] [data-act="comment"]').click();
              await p.locator(".steer-form textarea").waitFor();
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
              await p.locator("[data-b-edit]").nth(1).click();
              await p.locator(".btext").waitFor();
            },
            "generate note": async (p) => {
              await p.keyboard.press("Escape");
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
          },
          tab: ["remove choice", "section folded", "suggest outline notes", "editing a suggestion"],
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
          },
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
          await page.setViewportSize({ width: 1400, height: 900 });
        };
        // Tab reaches every control, and each one shows a focus outline.
        const keyboard = async (where: string) => {
          const count = await markFocusable(page);
          const tab = await tabThrough(page);
          if (!tab.wrapped) problems.push(`${where}: Tab didn't wrap within 200 stops`);
          const missed = Array.from({ length: count }, (_, i) => String(i)).filter((k) => !tab.reached.has(k));
          if (missed.length) problems.push(`${where}: Tab missed ${missed.length} of ${count} controls`);
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

          for (const a of await axeProblems(page)) problems.push(`${where} axe ${a}`);
          await keyboard(where);
          await phone(where, p.name);

          for (const [state, open] of Object.entries(p.states)) {
            await open(page);
            for (const a of await axeProblems(page)) problems.push(`${where}, ${state}: axe ${a}`);
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
    { gh, sessions: () => [{ session: HOOKS["post-taskcreate"].session_id, pid: 1, status: "busy", cwd: "/tmp/proj" }] },
  );
});
