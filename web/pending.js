// What waits on the person, in every hoop tab (reviews and open action items): a count in the title and a dot on the favicon, and a
// browser notification for a new review while the tab is hidden, once the person turns them on.
import { icons } from "./icons.js";

const KEY = "hoop:notify";

/** Reviews waiting on the person: the latest revision has no review yet, and nothing replaced it. */
export const waiting = (list) => list.filter((m) => m.status_key === "awaiting_review" && !m.superseded_by);

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

function notify(m) {
  try {
    const n = new Notification(`New review: ${m.title}`, { tag: m.id, ...(m.summary ? { body: m.summary } : {}) });
    n.onclick = () => {
      window.focus();
      n.close();
      location.assign(`/r/${m.id}`);
    };
  } catch {
    // Some browsers only show notifications from a service worker; the title and favicon still count.
  }
}

/**
 * Asks for the reviews and action items every `every` ms, visible or not, and shows how many wait in
 * the title and favicon. Home passes `checkActions`, so hoop checks open items while it is open. A review that starts waiting while the tab is hidden shows a notification, if they are
 * on. The first answer only sets what is already there, so opening a tab never notifies.
 * `onList` gets each list of reviews and `onActions` each list of action items, for Home to show. It
 * also handles Home's Notify me.
 */
export function watchPending({ every = window.HOOP_PENDING_MS ?? 15_000, onList, onActions, checkActions = false } = {}) {
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
    if (seen && document.visibilityState === "hidden" && notifying()) for (const m of arrivals(seen, now)) notify(m);
    seen = new Set([...(seen ?? []), ...now.map(keyOf)]);
    onList?.(list);
    if (Array.isArray(actions)) onActions?.(actions);
  };
  ask();
  setInterval(ask, every);
}
