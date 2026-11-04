// The page frame: the product name, the links to Home and Work and the version.
// Every page wraps its body in it, so each page shows the same header.
import { esc } from "./esc.js";
import { icons } from "./icons.js";

const LINKS = [
  { key: "home", href: "/", label: "Home", icon: "home" },
  { key: "work", href: "/work", label: "Work", icon: "list" },
];

/**
 * Wraps a page body. `current` marks the page's link. A missing `info` shows no version. The Work
 * link shows once a session on this machine has recorded todos or subagents (`info.work`), and on
 * the Work page itself, which its address always reaches.
 */
export function frame(current, body, info) {
  const links = LINKS.filter((l) => l.key !== "work" || current === "work" || info?.work !== false)
    .map((l) => `<a href="${l.href}"${l.key === current ? ' aria-current="page"' : ""}>${icons[l.icon]}<span>${l.label}</span></a>`)
    .join("");
  const version = info?.release
    ? `<span class="frame-version mono" title="The hoop version serving these pages">v${esc(info.release)}${info.code ? ` · ${esc(info.code.slice(0, 7))}` : ""}</span>`
    : "";
  return `<header class="frame"><a class="brand" href="/">hoop</a><nav aria-label="Main">${links}</nav>${version}</header>${body}`;
}

/**
 * Says something to screen readers, from a region outside the part the page repaints. A region made
 * for the first message gets it a moment later, since screen readers skip text that arrives with it;
 * a message said in that moment replaces it, so the newest one is what's heard. A message the region
 * already holds is cleared and written again a moment later, since screen readers skip text that
 * doesn't change.
 */
export function announce(text) {
  const live = document.getElementById("page-live");
  if (live?.dataset.pending !== undefined) live.dataset.pending = text;
  else if (live && live.textContent !== text) live.textContent = text;
  else if (live) {
    live.textContent = "";
    sayLater(live, text);
  }
  if (live) return;
  const made = Object.assign(document.createElement("div"), { id: "page-live", className: "visually-hidden" });
  made.setAttribute("role", "status");
  document.body.append(made);
  sayLater(made, text);
}

/** Writes `text` into the live region `live` a moment from now; a message said meanwhile replaces it. */
function sayLater(live, text) {
  live.dataset.pending = text;
  setTimeout(() => {
    live.textContent = live.dataset.pending;
    delete live.dataset.pending;
  }, 100);
}

/** The banner's words when hoop's pages stopped answering. */
export const PAGES_STOPPED = "The pages stopped. Any hoop command or a new session starts them again.";

/** Shows `text` in the banner at the top of the page, or clears the banner when it is empty. */
export function setBanner(text) {
  const banner = document.getElementById("banner");
  if (!banner || banner.textContent === text) return;
  const was = banner.textContent;
  banner.textContent = text;
  banner.classList.toggle("banner", Boolean(text));
  if (text) return announce(text);
  // A warning that cleared leaves nothing in the live region that says it still holds.
  const live = document.getElementById("page-live");
  if (live && (live.textContent === was || live.dataset.pending === was)) {
    live.textContent = "";
    if (live.dataset.pending !== undefined) live.dataset.pending = "";
  }
}
