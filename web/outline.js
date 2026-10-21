// The outline as a tree: each section sits inside its parent, up to five levels under the title.
// A section with sections in it expands and collapses; the state lasts as long as the page.
import { esc } from "/esc.js";

/** An item's depth under the title: heading levels two to six are depths one to five, and no level is depth one. */
export const depthOf = (item) => Math.min(5, Math.max(1, (item.level || 2) - 1));

/** The items as a tree: each node holds its item, its depth and the sections nested in it. */
export function outlineTree(items) {
  const roots = [],
    stack = [];
  for (const item of items) {
    const node = { item, depth: depthOf(item), children: [] };
    while (stack.length && stack.at(-1).depth >= node.depth) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  return roots;
}

const collapsed = new Set();
let changed = () => {};

/** Runs `fn` when a section in the outline expands or collapses. */
export const onOutlineChange = (fn) => (changed = fn);

/** The outline's HTML; `link(item)` gives each section's link. */
export function outlineHtml(items, link) {
  const walk = (nodes) =>
    `<ul class="ol-list">${nodes
      .map((n) => {
        const open = !collapsed.has(n.item.id);
        const toggle = n.children.length
          ? `<button class="ol-toggle" data-outline-toggle="${esc(n.item.id)}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(n.item.title)}">${open ? "▾" : "▸"}</button>`
          : `<span class="ol-toggle" aria-hidden="true"></span>`;
        return `<li><div class="ol-row">${toggle}${link(n.item)}</div>${n.children.length && open ? walk(n.children) : ""}</li>`;
      })
      .join("")}</ul>`;
  return walk(outlineTree(items));
}

document.addEventListener("click", (e) => {
  const t = e.target.closest?.("[data-outline-toggle]");
  if (!t) return;
  const id = t.dataset.outlineToggle;
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  changed();
  document.querySelector(`[data-outline-toggle="${CSS.escape(id)}"]`)?.focus();
});
