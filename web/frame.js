// The page frame: the product name, links to the reviews and the tracker, and the repository in use.
// Every page wraps its body in it, so each page shows the same header.
import { esc } from "./esc.js";
import { icons } from "./icons.js";

const LINKS = [
  { key: "reviews", href: "/", label: "Reviews", icon: "document" },
  { key: "tracker", href: "/tracker", label: "Tracker", icon: "tracker" },
];

/** Wraps a page body. `current` marks the page's link; a missing `repo` shows no repository name. */
export function frame(current, body, repo) {
  const links = LINKS.map((l) =>
    `<a href="${l.href}"${l.key === current ? ' aria-current="page"' : ""}>${icons[l.icon]}<span>${l.label}</span></a>`).join("");
  return `<header class="frame"><a class="brand" href="/">hoop</a><nav aria-label="Main">${links}</nav>${repo?.name ? `<span class="frame-repo mono" title="Repository">${esc(repo.name)}</span>` : ""}</header>${body}`;
}
