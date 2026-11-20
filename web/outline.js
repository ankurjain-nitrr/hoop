// The outline as a tree: each section sits inside its parent, up to five levels under the title.
// A section with sections in it folds them, as every disclosure does (web/fold.js).
import { esc } from "/esc.js";
import { foldButton, foldHidden } from "/fold.js";
import { plainText } from "/inline.js";

/** @typedef {{ id: string, title: string, level?: number }} Item A section in the outline: its ID, its heading's words and level. */
/** @typedef {{ item: Item, depth: number, children: Node[] }} Node A section in the tree, with the sections nested in it. */

/**
 * An item's depth under the title: heading levels two to six are depths one to five, and no level is depth one.
 * @param {{ level?: number }} item
 */
export const depthOf = (item) => Math.min(5, Math.max(1, (item.level || 2) - 1));

/**
 * The items as a tree: each node holds its item, its depth and the sections nested in it.
 * @param {Item[]} items
 */
function outlineTree(items) {
  /** @type {Node[]} */
  const roots = [],
    stack = [];
  for (const item of items) {
    const node = { item, depth: depthOf(item), children: [] };
    while ((stack.at(-1)?.depth ?? 0) >= node.depth) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  return roots;
}

/**
 * The outline's HTML; `link(item)` gives each section's link. A section's subsections fold under its
 * disclosure, kept by `scope` (the review's ID) and the section's ID.
 * @template {Item} T
 * @param {T[]} items
 * @param {(item: T) => string} link
 * @param {string} scope
 */
export function outlineHtml(items, link, scope) {
  /** @type {(nodes: Node[], attrs?: string) => string} */
  const walk = (nodes, attrs = "") =>
    `<ul class="ol-list"${attrs}>${nodes
      .map((n) => {
        if (!n.children.length)
          return `<li><div class="ol-row"><span class="ol-toggle" aria-hidden="true"></span>${link(/** @type {T} */ (n.item))}</div></li>`;
        const key = `outline:${scope}:${n.item.id}`;
        const body = `ol-${n.item.id}`;
        const toggle = foldButton(key, body, "", "item", { label: `Sections in ${plainText(n.item.title)}`, here: true });
        return `<li><div class="ol-row">${toggle}${link(/** @type {T} */ (n.item))}</div>${walk(n.children, ` id="${esc(body)}"${foldHidden(key)}`)}</li>`;
      })
      .join("")}</ul>`;
  return walk(outlineTree(items));
}
