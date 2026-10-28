// The page frame: the product name, the links to Home and Work and the version.
// Every page wraps its body in it, so each page shows the same header.
import { esc } from "./esc.js";
import { icons } from "./icons.js";

const LINKS = [
  { key: "home", href: "/", label: "Home", icon: "home" },
  { key: "work", href: "/work", label: "Work", icon: "list" },
];

/**
 * Wraps a page body. `current` marks the page's link. A missing `info` shows no version.
 */
export function frame(current, body, info) {
  const links = LINKS.map((l) => `<a href="${l.href}"${l.key === current ? ' aria-current="page"' : ""}>${icons[l.icon]}<span>${l.label}</span></a>`).join("");
  const version = info?.release
    ? `<span class="frame-version mono" title="The hoop version serving these pages">v${esc(info.release)}${info.code ? ` · ${esc(info.code.slice(0, 7))}` : ""}</span>`
    : "";
  return `<header class="frame"><a class="brand" href="/">hoop</a><nav aria-label="Main">${links}</nav>${version}</header>${body}`;
}

/**
 * Says something to screen readers, from a region outside the part the page repaints. A region made
 * for the first message gets it a moment later, since screen readers skip text that arrives with it.
 */
export function announce(text) {
  const live = document.getElementById("page-live");
  if (live) {
    live.textContent = text;
    return;
  }
  const made = Object.assign(document.createElement("div"), { id: "page-live", className: "visually-hidden" });
  made.setAttribute("role", "status");
  document.body.append(made);
  setTimeout(() => (made.textContent = text), 100);
}

/** The banner's words when hoop's pages stopped answering. */
export const PAGES_STOPPED = "The pages stopped. Any hoop command or a new session starts them again.";

/** Shows the banner that says the pages stopped; the next answer from the pages clears it. */
function showStopped() {
  const banner = document.getElementById("banner");
  if (!banner) return;
  banner.textContent = PAGES_STOPPED;
  banner.classList.add("banner");
}

/**
 * `fetch` for the pages' own API. A request the pages never answer throws in plain words instead of
 * the browser's "Failed to fetch", and an action (any method but GET) shows the stopped banner at
 * once; a background GET leaves that to the regular check, so a page waking from sleep doesn't warn.
 */
export async function request(path, init = {}) {
  try {
    return await fetch(path, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    if ((init.method ?? "GET") !== "GET") showStopped();
    throw new Error("hoop's pages aren't answering. Any hoop command or a new session starts them again; then try again.");
  }
}
