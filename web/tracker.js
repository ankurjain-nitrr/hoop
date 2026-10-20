// The tracker page: the repository's tracker (or a change's) as a tree table. Each item opens into
// its block, with a count of its definition of done's met points; an item without a description or
// a definition of done is flagged. Rows for change requests, which trackers no longer hold, show apart.
import { api, esc, frame, state, $ } from "/app.js";
import { blockKinds } from "/blocks.js";
import { renderLine } from "/inline.js";
import { onTreeChange, renderTree } from "/tree.js";

const open = new Set();
const view = { project: "" };

/** An item's block as formatted lines, or the note that it has none. */
function blockHtml(block) {
  if (!block) return `<div class="tblock"><p class="tblock-none">No definition of done yet.</p></div>`;
  const lines = block.text.split("\n").slice(1);
  const kinds = blockKinds(lines);
  let k = 0;
  const html = lines
    .map((l) => {
      if (!l.trim()) return "";
      const kind = kinds[k++];
      return `<div class="tblock-line">${renderLine(l, [], kind)}</div>`;
    })
    .join("");
  return `<div class="tblock">${html}${block.has_dod ? "" : '<p class="tblock-none">No definition of done yet.</p>'}</div>`;
}

/** The flags and the definition of done's count, after an item's title. */
function marks(block) {
  if (!block) return ' <span class="tflag">No block</span>';
  const flags = [
    !block.has_description ? '<span class="tflag">No description</span>' : "",
    !block.has_dod ? '<span class="tflag">No definition of done</span>' : "",
  ].join(" ");
  const count = block.has_dod ? ` <span class="tcount" title="Definition of done points met">${block.met} of ${block.points}</span>` : "";
  return `${count} ${flags}`.trimEnd();
}

export async function renderTracker() {
  const params = new URLSearchParams(location.search);
  // The page offers each open repository, and keeps the chosen key in its address.
  const repos = state.info?.repos ?? [],
    key = params.get("repo");
  const repo = repos.find((r) => r.key === key) ?? repos[0];
  // Without the info, the key in the address still names the repository; the server checks it.
  const chosen = repos.length ? repo?.key : key;
  const scope = chosen ? `repo=${encodeURIComponent(chosen)}` : "";
  const files = await api(`/api/trackers?${scope}`);
  // A file named for a repository that closed belongs to that repository, not to this one.
  const asked = key && repos.length && repo?.key !== key ? null : params.get("file");
  const file = asked || files[0];
  let t = null,
    error = "";
  if (file) {
    try {
      t = await api(`/api/tracker?${scope}&file=${encodeURIComponent(file)}`);
    } catch (err) {
      error = err.message;
    }
  }
  const projects = t ? [...new Set(t.items.map((i) => i.project))].sort() : [];
  const draw = () => {
    const items = t ? t.items.filter((i) => !view.project || i.project === view.project) : [];
    const row = (i) => {
      const opened = open.has(`${file}:${i.id}`);
      const block = t.blocks?.[i.id];
      return {
        id: i.id,
        parent: i.parent,
        cells: i.cells,
        lead: `<button class="tblock-btn" data-block="${esc(i.id)}" aria-expanded="${opened}" aria-label="${opened ? "Hide" : "Show"} the block of ${esc(i.id)}">${opened ? "−" : "+"}</button>`,
        titleExtra: marks(block),
        after: opened ? blockHtml(block) : "",
      };
    };
    const work = items.filter((i) => !i.legacy_change).map(row);
    const legacy = items.filter((i) => i.legacy_change).map(row);
    const body = t
      ? `${renderTree(file, t.columns, work)}${
          legacy.length
            ? `<section class="legacy" aria-labelledby="legacy-title"><h2 id="legacy-title">Change request rows</h2><p class="m">Change requests now show on the <a href="/changes">change request page</a>. The next fold removes these rows.</p>${renderTree(`${file}#legacy`, t.columns, legacy)}</section>`
            : ""
        }`
      : `<p class="empty">${esc(error || "No tracker in this repository yet. Add docs/TRACKER.md with a table that has ID and Parent columns.")}</p>`;
    $("#app").innerHTML = frame(
      "tracker",
      `<div class="tracker-page">
      <header class="tracker-head"><h1>Tracker</h1>
        ${repos.length > 1 ? `<label>Repository <select id="tracker-repo">${repos.map((r) => `<option value="${esc(r.key)}" ${r.key === repo?.key ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>` : ""}
        ${files.length ? `<label>File <select id="tracker-file">${files.map((f) => `<option ${f === file ? "selected" : ""}>${esc(f)}</option>`).join("")}</select></label>` : ""}
        ${projects.length > 1 ? `<label>Project <select id="tracker-project"><option value="">All</option>${projects.map((p) => `<option ${p === view.project ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></label>` : ""}</header>
      ${body}</div>`,
      repo,
      state.info,
    );
    $("#tracker-repo")?.addEventListener("change", (e) => {
      location.search = `?repo=${encodeURIComponent(e.target.value)}`;
    });
    $("#tracker-project")?.addEventListener("change", (e) => {
      view.project = e.target.value;
      draw();
      $("#tracker-project")?.focus();
    });
    $("#tracker-file")?.addEventListener("change", (e) => {
      location.search = `?${chosen ? `repo=${encodeURIComponent(chosen)}&` : ""}file=${encodeURIComponent(e.target.value)}`;
    });
  };
  onTreeChange(draw);
  draw();
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-block]");
    if (!b) return;
    const key = `${file}:${b.dataset.block}`;
    if (open.has(key)) open.delete(key);
    else open.add(key);
    draw();
    document.querySelector(`[data-block="${CSS.escape(b.dataset.block)}"]`)?.focus();
  });
}
