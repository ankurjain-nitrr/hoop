// The page frame: the product name, the link to the reviews, and the repository in use.
// Every page wraps its body in it, so each page shows the same header.
import { esc } from "./esc.js";
import { icons } from "./icons.js";

const LINKS = [{ key: "reviews", href: "/", label: "Reviews", icon: "document" }];

/**
 * Wraps a page body. `current` marks the page's link. A missing `repo` shows no repository name,
 * missing `info` shows no version, and `info.login` names who is signed in with GitHub.
 */
export function frame(current, body, repo, info) {
  const links = LINKS.map((l) => `<a href="${l.href}"${l.key === current ? ' aria-current="page"' : ""}>${icons[l.icon]}<span>${l.label}</span></a>`).join("");
  const version = info?.release
    ? `<span class="frame-version mono" title="The hoop version serving these pages">v${esc(info.release)}${info.code ? ` · ${esc(info.code.slice(0, 7))}` : ""}</span>`
    : "";
  const who = info?.login ? `<span class="frame-user mono" title="Signed in with GitHub">${icons.github}<span>${esc(info.login)}</span></span>` : "";
  return `<header class="frame"><a class="brand" href="/">hoop</a><nav aria-label="Main">${links}</nav>${repo?.name ? `<span class="frame-repo mono" title="Repository">${esc(repo.name)}</span>` : ""}${who}${version}</header>${body}`;
}
