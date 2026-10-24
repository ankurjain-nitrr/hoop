// What waits on the person, in every hoop tab: a count in the title and a dot on the favicon, and a
// browser notification for a new review while the tab is hidden, once the person turns them on.
import { icons } from "./icons.js";

const KEY = "hoop:notify";

/** Reviews waiting on the person: the latest revision has no review yet, and nothing replaced it. */
export const waiting = (list) => list.filter((m) => m.status_key === "awaiting_review" && !m.superseded_by);

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
  return `<span class="notify"><button type="button" class="btn small" id="notifyMe" aria-pressed="${on}" aria-describedby="notifyNote" title="Show a notification when a new review arrives while this tab is hidden">${on ? icons.check : ""}Notify me</button><span id="notifyNote" class="notify-note">${
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
 * Asks for the reviews every `every` ms, visible or not, and shows how many wait in the title and
 * favicon. A review that starts waiting, or a pull request that becomes ready to merge, gets
 * conflicts or fails its checks, shows a notification while the person is away from the tab, if
 * they are on. The first answer only sets what is already there, so opening a tab never notifies.
 * `onList` gets each list, for Home to show. It also handles Home's Notify me.
 */
export function watchPending({ every = window.HOOP_PENDING_MS ?? 15_000, prsEvery = window.HOOP_PRS_MS ?? 60_000, onList } = {}) {
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
  const ask = async () => {
    const list = await fetch("/api/reviews")
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined);
    if (!Array.isArray(list)) return;
    const now = waiting(list);
    count = now.length;
    paintTitle();
    icon.href = faviconHref(count);
    icon.dataset.count = String(count);
    if (seen && away() && notifying())
      for (const m of arrivals(seen, now)) notify(`New review: ${m.title}`, m.id, m.summary, () => location.assign(`/r/${m.id}`));
    seen = new Set([...(seen ?? []), ...now.map(keyOf)]);
    onList?.(list);
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
}
