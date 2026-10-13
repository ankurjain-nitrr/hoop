// The tracker page: the repository's tracker (or a change's) as a tree table.
import { api, esc, $ } from "/app.js";
import { onTreeChange, renderTree } from "/tree.js";

export async function renderTracker() {
  const file = new URLSearchParams(location.search).get("file") || "docs/TRACKER.md";
  const [files, t] = await Promise.all([api("/api/trackers"), api(`/api/tracker?file=${encodeURIComponent(file)}`)]);
  const rows = t.items.map((i) => ({ id: i.id, parent: i.parent, cells: i.cells }));
  const draw = () => {
    $("#app").innerHTML = `<div class="tracker-page">
      <header class="tracker-head"><h1>Tracker</h1>
        <label>File <select id="tracker-file">${files.map((f) => `<option ${f === file ? "selected" : ""}>${esc(f)}</option>`).join("")}</select></label>
        <a href="/">All reviews</a></header>
      ${renderTree(file, t.columns, rows)}</div>`;
    $("#tracker-file").addEventListener("change", (e) => { location.search = `?file=${encodeURIComponent(e.target.value)}`; });
  };
  onTreeChange(draw);
  draw();
}
