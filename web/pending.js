// What waits on the person, in every hoop tab (reviews and open action items): a count in the title and a dot on the favicon, and a
// browser notification for a new review, or work that waits on them or stalls, while the tab is hidden, once the person turns them on.
import { agentHealth, counts, todoState } from "./activity.js";
import { icons } from "./icons.js";

const KEY = "hoop:notify";

/** How many reviews waited on the person at the last count, or undefined before the first. */
let lastCount;
export const waitingNow = () => lastCount;

/** Reviews waiting on the person: the latest revision has no review yet, and nothing replaced it; and quick questions with a question unanswered. */
export const waiting = (list) => list.filter((m) => (m.status_key === "awaiting_review" || m.status_key === "question") && !m.superseded_by);

/** Action items waiting on the person: the open ones. */
export const openActions = (items) => items.filter((a) => a.state === "open");

/** A page title with the count in front, as "(2) hoop"; the bare title when nothing waits. */
export function countedTitle(title, n) {
  const bare = title.replace(/^\(\d+\) /, "");
  return n > 0 ? `(${n}) ${bare}` : bare;
}

/** The favicon as an SVG data URL: a ring, with a dot when anything waits. */
export function faviconHref(n) {
  const dot = n > 0 ? "<circle id='dot' cx='24' cy='8' r='7' fill='%23d93025'/>" : "";
  return `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='14' cy='18' r='10' fill='none' stroke='%23a85d07' stroke-width='5'/>${dot}</svg>`;
}

/** A review's revision, which a new review or a new revision waiting again gives a new key. */
const keyOf = (m) => `${m.id}:${m.revisions}`;

/** The reviews in `now` that `seen` hasn't had. */
export const arrivals = (seen, now) => now.filter((m) => !seen.has(keyOf(m)));

/** What a pull request needs from the person: merging, its conflicts fixed, or its failed checks looked at. */
const prNeed = (p) => (p.state !== "open" ? "" : p.ready ? "Ready to merge" : p.conflicts ? "Conflicts" : p.checks === "failing" ? "Checks failed" : "");

/** The pull requests in `now` whose need changed since `before` (url → need), as notifications to show. */
export function prAlerts(before, now) {
  return now.flatMap((p) => {
    const need = prNeed(p);
    return need && before.get(p.url) !== need ? [{ title: `${need}: ${p.title || `${p.repo}#${p.number}`}`, tag: p.url, url: p.url }] : [];
  });
}

/**
 * The todos and subagents on the Work page that wait on the person or stalled, as notifications to
 * show: `{ key, title, body }`, where `key` names the item and its state. A todo whose state comes
 * from its subagent counts once, as the todo; an ended session's work counts only for a while, as
 * the page's counts do. Waiting on a hoop review or question is left out: that review already
 * notifies as a new review.
 */
export function workAlerts(sessions, now) {
  const c = counts(sessions, now);
  return ["waiting", "stalled"].flatMap((state) =>
    c[state].flatMap((row) => {
      const s = sessions.find((x) => x.id === row.session);
      const todo = row.kind === "todo" ? s?.todos.find((t) => t.id === row.id) : undefined;
      const agent = row.kind === "agent" ? s?.agents.find((a) => a.id === row.id) : undefined;
      if (!s || !(todo || agent)) return [];
      const st = todo ? todoState(s, todo, now) : undefined;
      const by = agent ?? (st?.agent ? s.agents.find((a) => a.id === st.agent) : undefined);
      const doing = by ? by.doing : s.doing;
      if (state === "waiting" && (st?.link?.href.startsWith("/r/") || doing?.waiting === "review")) return [];
      const what = todo ? todo.text : (agent.description ?? "A subagent");
      const note = todo ? st?.note : agentHealth(agent, now)?.note;
      return [
        {
          key: `${row.session}:${row.kind}:${row.id}:${state}`,
          title: `${state === "waiting" ? "Waiting on you" : "Stalled"}: ${what}`,
          body: [s.name ?? "Unnamed session", note].filter(Boolean).join(" · "),
        },
      ];
    }),
  );
}

/** How long a Work alert must be gone before it notifies again, so a state that flickers (a wait between two hoop_wait calls) notifies once. */
export const ALERT_FORGET_MS = 60_000;

/**
 * The alerts to show now: those `seen` (key → when last seen) doesn't hold. It records every alert
 * as seen at `now`, and forgets one gone for ALERT_FORGET_MS.
 */
export function newAlerts(seen, alerts, now) {
  const fresh = alerts.filter((a) => !seen.has(a.key));
  for (const a of alerts) seen.set(a.key, now);
  for (const [key, at] of seen) if (now - at >= ALERT_FORGET_MS) seen.delete(key);
  return fresh;
}

/** The person isn't looking at this tab: it is hidden, or another window or app has focus. */
const away = () => document.visibilityState === "hidden" || !document.hasFocus();

const stored = () => {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
};
const store = (on) => {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {}
};
const supported = () => typeof Notification === "function";

/** Whether the person turned notifications on here, and the browser still allows them. */
export const notifying = () => supported() && Notification.permission === "granted" && stored();

/** Home's Notify me toggle, or nothing where the browser has no notifications. */
export function notifyHtml() {
  if (!supported()) return "";
  const on = notifying();
  const blocked = Notification.permission === "denied";
  return `<span class="notify"><button type="button" class="btn small" id="notifyMe" aria-pressed="${on}" aria-describedby="notifyNote" title="Show a notification when a new review arrives, or work waits on you or stalls, while this tab is hidden">${on ? icons.check : ""}Notify me</button><span id="notifyNote" class="notify-note">${
    blocked ? "Notifications are blocked in this browser's site settings." : ""
  }</span></span>`;
}

/** Turns notifications on, asking the browser for permission only now, or off. */
async function toggle() {
  if (notifying()) store(false);
  else store((await Notification.requestPermission()) === "granted");
  const el = document.querySelector(".notify");
  if (el) {
    el.outerHTML = notifyHtml();
    document.getElementById("notifyMe")?.focus();
  }
}

function notify(title, tag, body, open) {
  try {
    const n = new Notification(title, { tag, ...(body ? { body } : {}) });
    n.onclick = () => {
      window.focus();
      n.close();
      open();
    };
  } catch {
    // Some browsers only show notifications from a service worker; the title and favicon still count.
  }
}

/**
 * Asks for the reviews and action items every `every` ms, visible or not, and shows how many wait in
 * the title and favicon. Home passes `checkActions`, so hoop checks open items while it is open. A
 * review that starts waiting, a pull request that becomes ready to merge, gets conflicts or fails
 * its checks, or a todo or subagent that comes to wait on the person or stalls (`workEvery`, read only
 * while notifications are on), shows a notification while the person is away from the tab, if they are on. The first
 * answer only sets what is already there, so opening a tab never notifies.
 * `onList` gets each list of reviews and `onActions` each list of action items, for Home to show. It
 * also handles Home's Notify me.
 */
export function watchPending({
  every = window.HOOP_PENDING_MS ?? 15_000,
  prsEvery = window.HOOP_PRS_MS ?? 60_000,
  workEvery = window.HOOP_WORK_ALERT_MS ?? 15_000,
  onList,
  onActions,
  checkActions = false,
} = {}) {
  let count = 0;
  let seen;
  const icon = document.querySelector("link[rel=icon]") ?? document.head.appendChild(Object.assign(document.createElement("link"), { rel: "icon" }));
  const paintTitle = () => {
    const t = countedTitle(document.title, count);
    if (t !== document.title) document.title = t;
  };
  // Each page sets its own title as it renders; the count goes back in front of it.
  const title = document.querySelector("title");
  if (title) new MutationObserver(paintTitle).observe(title, { childList: true, characterData: true, subtree: true });
  document.addEventListener("click", (e) => {
    if (e.target.closest?.("#notifyMe")) toggle();
  });
  const get = (path) =>
    fetch(path)
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined);
  const ask = async () => {
    const [list, actions] = await Promise.all([get("/api/reviews"), get(`/api/actions${checkActions ? "?check=1" : ""}`)]);
    if (!Array.isArray(list)) return;
    const now = waiting(list);
    count = now.length + (Array.isArray(actions) ? openActions(actions).length : 0);
    paintTitle();
    icon.href = faviconHref(count);
    icon.dataset.count = String(count);
    lastCount = count;
    document.dispatchEvent(new CustomEvent("hoop:waiting", { detail: count }));
    if (seen && away() && notifying())
      for (const m of arrivals(seen, now)) notify(`${m.ask ? "New question" : "New review"}: ${m.title}`, m.id, m.summary, () => location.assign(`/r/${m.id}`));
    seen = new Set([...(seen ?? []), ...now.map(keyOf)]);
    onList?.(list);
    if (Array.isArray(actions)) onActions?.(actions);
  };
  ask();
  setInterval(ask, every);
  // Pull request states come from gh through the pages, which keep each for a minute.
  let needs;
  const askPrs = async () => {
    const prs = await fetch("/api/prs")
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined);
    if (!Array.isArray(prs)) return;
    if (needs && away() && notifying()) for (const a of prAlerts(needs, prs)) notify(a.title, a.tag, "", () => window.open(a.url, "_blank", "noopener"));
    needs = new Map(prs.map((p) => [p.url, prNeed(p)]));
  };
  askPrs();
  setInterval(askPrs, prsEvery);
  // The Work page's todos and subagents are read only while notifications are on: a todo or
  // subagent that comes to wait on the person, or stalls, notifies once each time it does.
  let alerted;
  const askWork = async () => {
    if (!notifying()) {
      alerted = undefined;
      return;
    }
    const work = await get("/api/work");
    if (!Array.isArray(work?.sessions)) return;
    const first = !alerted;
    alerted ??= new Map();
    const fresh = newAlerts(alerted, workAlerts(work.sessions, Date.now()), Date.now());
    if (!first && away()) for (const a of fresh) notify(a.title, a.key, a.body, () => location.assign("/work"));
  };
  askWork();
  setInterval(askWork, workEvery);
}
