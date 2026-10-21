// Tree table for trackers: items nest by their Parent column; carets collapse, filters keep ancestors.
import { esc } from "/app.js";
import { renderLine } from "/inline.js";
import { statusChip } from "/status.js";

const collapsed = new Set(); // `${key}:${id}`
const filters = {}; // key -> { Type, Status }
let rerender = () => {};
export const onTreeChange = (fn) => {
  rerender = fn;
};

/** Orders rows depth first, keeping file order among siblings; an unknown parent (or a cycle) is a root. */
function ordered(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kids = new Map(),
    roots = [];
  const cyclic = (r) => {
    for (let at = r.parent, n = 0; at && n <= rows.length; at = byId.get(at)?.parent, n++) if (at === r.id) return true;
    return false;
  };
  for (const r of rows) {
    if (r.parent && byId.has(r.parent) && !cyclic(r)) (kids.get(r.parent) ?? kids.set(r.parent, []).get(r.parent)).push(r);
    else roots.push(r);
  }
  const out = [];
  const walk = (r, depth, ancestors) => {
    out.push({ ...r, depth, ancestors, hasKids: kids.has(r.id) });
    for (const k of kids.get(r.id) ?? []) walk(k, depth + 1, [...ancestors, r.id]);
  };
  roots.forEach((r) => walk(r, 0, []));
  return out;
}

const NOWRAP = new Set(["Start", "Done", "PR", "Due"]);
const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
// Item text formats through the line renderer, as prose.
const inline = (s) => renderLine(s.replace(/\\\|/g, "|"), [], { kind: "paragraph", indent: 0 });

/**
 * Renders rows ({ id, parent, cells: {column: text}, lead?, after?, pinned?, titleExtra? }) as a tree
 * table. `lead` is HTML for the first cell (e.g. a comment button), `after` HTML shown under the row
 * (e.g. threads), and `titleExtra` HTML after the title (e.g. flags).
 */
export function renderTree(key, columns, rows) {
  const f = (filters[key] ??= { Type: "", Status: "" });
  const shown = columns.filter((c) => c !== "Parent");
  const list = ordered(rows);
  const matches = (r) => (!f.Type || r.cells.Type === f.Type) && (!f.Status || r.cells.Status === f.Status);
  // Pinned rows (with comments or edits on them) stay visible through collapses and filters.
  const keep = new Set();
  for (const r of list)
    if (matches(r) || r.pinned) {
      keep.add(r.id);
      r.ancestors.forEach((a) => keep.add(a));
    }
  const visible = list.filter((r) => keep.has(r.id) && (r.pinned || !r.ancestors.some((a) => collapsed.has(`${key}:${a}`))));
  const options = (col) => [...new Set(rows.map((r) => r.cells[col]).filter(Boolean))].sort();
  const select = (col) =>
    columns.includes(col)
      ? `<label>${col} <select data-tree-filter="${esc(key)}" data-col="${col}" id="tf-${slug(key)}-${col}">
      <option value="">All</option>${options(col)
        .map((o) => `<option ${f[col] === o ? "selected" : ""}>${esc(o)}</option>`)
        .join("")}</select></label>`
      : "";
  const cell = (r, c) => {
    const v = r.cells[c] ?? "";
    if (c === "ID") {
      const open = !collapsed.has(`${key}:${r.id}`);
      const caret = r.hasKids
        ? `<button class="caret" data-tree-toggle="${esc(key)}" data-id="${esc(r.id)}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(r.id)}">${open ? "▾" : "▸"}</button>`
        : `<span class="caret"></span>`;
      return `<td class="tid" style="--depth:${r.depth}">${r.lead ?? ""}${caret}<span class="mono">${esc(v)}</span></td>`;
    }
    if (c === "Type" && v) return `<td><span class="tbadge t-${slug(v)}">${esc(v)}</span></td>`;
    if ((c === "Status" || c === "Phase") && v) return `<td>${statusChip(v)}</td>`;
    if (c === "Title" && r.titleExtra) return `<td>${inline(v)}${r.titleExtra}</td>`;
    return `<td${NOWRAP.has(c) ? ' class="nw"' : ""}>${inline(v)}</td>`;
  };
  return `<div class="tree">
    <div class="tree-tools">${select("Type")}${select("Status")}<span class="m">${visible.length} of ${rows.length} items</span></div>
    <div class="tree-scroll"><table class="tree-table">
      <thead><tr>${shown.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${visible.map((r) => `<tr class="trow" data-tree-id="${esc(r.id)}">${shown.map((c) => cell(r, c)).join("")}</tr>${r.after ? `<tr class="tafter"><td colspan="${shown.length}">${r.after}</td></tr>` : ""}`).join("")}</tbody>
    </table></div></div>`;
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-tree-toggle]");
  if (!b) return;
  const k = `${b.dataset.treeToggle}:${b.dataset.id}`;
  collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k);
  rerender();
});
document.addEventListener("change", (e) => {
  const s = e.target.closest?.("[data-tree-filter]");
  if (!s) return;
  (filters[s.dataset.treeFilter] ??= {})[s.dataset.col] = s.value;
  rerender();
});
