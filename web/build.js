// The build page: a document the person and Claude build together, one block at a time. The person
// adds blocks with +, edits any block's markdown in place, and moves or removes it. The page asks for
// the build again every few seconds while visible, so Claude's changes show without a reload.
import { esc } from "/esc.js";
import { frame } from "/frame.js";
import { statusBadge } from "/status.js";
import { renderLine, renderTableRow } from "/inline.js";
import { ITEM, JOIN, rowCells, TABLE_DELIM } from "/blocks.js";
import { diagramHtml, mountDiagrams } from "/diagram.js";
import { icons } from "/icons.js";

const app = document.getElementById("app");

/** The kinds of block + adds, in menu order, with the name people read. */
export const KINDS = [
  ["h1", "Title"],
  ["h2", "Section"],
  ["h3", "Subsection"],
  ["paragraph", "Paragraph"],
  ["list", "List"],
  ["table", "Table"],
  ["code", "Code"],
  ["diagram", "Diagram"],
];
const KIND_NAME = Object.fromEntries(KINDS);

/** The page's state: the review view, the build, which block is being edited, which + menu is open. */
const b = { view: null, build: null, info: undefined, editing: null, adding: null, generating: null, error: "", focus: null };

/** Whether Claude can write a block's section: a section or subsection heading. */
const isSection = (block) => block.kind === "h2" || block.kind === "h3";

/** What the section under a heading waits for: a queued request, or Claude writing it. */
function sectionStatus(block) {
  const r = (b.build.requests ?? []).filter((x) => x.block === block.id && x.status !== "written").at(-1);
  if (!r) return "";
  const text = r.status === "taken" ? "Claude is writing this section…" : "Queued: Claude writes this section when its session next checks the build.";
  return `<p class="bstatus" role="status">${icons.clock}<span>${esc(text)}</span>${r.note ? ` <span class="bnote">Note: ${esc(r.note)}</span>` : ""}</p>`;
}

/** The Generate form under a section heading: an optional note for Claude. */
function generateForm(block, name) {
  const id = esc(block.id);
  return `<form class="bgen" data-b-gen-form="${id}">
    <label class="lab" for="bn-${id}">Note for Claude on ${esc(name)} (optional)</label>
    <input id="bn-${id}" class="bnote-in" name="note" maxlength="500" autocomplete="off" placeholder="For example: focus on cloud spend">
    <div class="row end"><div><button type="button" class="btn small" data-b-gen-cancel>Cancel</button><button type="submit" class="btn small primary">Generate</button></div></div>
  </form>`;
}

/** Calls the local API and returns the parsed reply; errors carry the reply's message. */
async function api(path, init = {}) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
const send = (body) =>
  api(`/api/reviews/${b.view.meta.id}/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const headingText = (text) => text.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\s+#+\s*$/, "");

/** A block as people name it in a control's label: a heading's text, else its kind and place. */
function blockName(block, i) {
  if (block.kind === "h1" || block.kind === "h2" || block.kind === "h3") return `${KIND_NAME[block.kind]} “${headingText(block.text)}”`;
  return `${KIND_NAME[block.kind] ?? "Block"} ${i + 1}`;
}

/** A table block as a table: the first row is the header, the delimiter row sets each column's alignment. */
function tableHtml(text) {
  const rows = text.split("\n");
  const delim = rows.findIndex((r) => TABLE_DELIM.test(r));
  const align = delim < 0 ? [] : rowCells(rows[delim]).map((c) => c.text);
  const style = (k) => {
    const a = align[k] ?? "";
    return a.startsWith(":") && a.endsWith(":") ? ' style="text-align:center"' : a.endsWith(":") ? ' style="text-align:right"' : "";
  };
  const body = rows
    .filter((_, n) => n !== delim)
    .map((r, n) => {
      const cells = renderTableRow(r) ?? [esc(r)];
      const tag = n === 0 && delim > 0 ? "th" : "td";
      return `<tr>${cells.map((c, k) => `<${tag}${style(k)}>${c}</${tag}>`).join("")}</tr>`;
    })
    .join("");
  return `<div class="md-table-wrap"><table class="md-table"><tbody>${body}</tbody></table></div>`;
}

/** A list block's items: each starts with a marker, and its continuation lines join it. */
function listItems(text) {
  const items = [];
  for (const line of text.split("\n")) {
    if (ITEM.test(line) || !items.length) items.push(line);
    else items[items.length - 1] += JOIN + line;
  }
  return items;
}

/** A block as it reads: headings, prose, lists, tables, code and diagrams. */
export function blockHtml(block) {
  const t = block.text;
  if (block.kind === "h1" || block.kind === "h2" || block.kind === "h3") {
    // The page's own title is the h1, so the document's headings sit one level below it.
    const tag = { h1: "h2", h2: "h3", h3: "h4" }[block.kind];
    return `<${tag} class="bh bh-${block.kind}">${renderLine(headingText(t), [], { kind: "paragraph", indent: 0 })}</${tag}>`;
  }
  if (block.kind === "diagram") return diagramHtml(t.split("\n").join(JOIN));
  if (block.kind === "code") {
    const lines = t.split("\n");
    const inner = lines.slice(1, lines.length > 1 && /^\s{0,3}(```|~~~)/.test(lines.at(-1)) ? -1 : undefined);
    return `<pre class="bcode"><code>${esc(inner.join("\n"))}</code></pre>`;
  }
  if (block.kind === "table") return tableHtml(t);
  if (block.kind === "list")
    return `<div class="blist">${listItems(t)
      .map((item) => `<div class="bline">${renderLine(item, [], { kind: "list", indent: item.match(/^\s*/)[0].length })}</div>`)
      .join("")}</div>`;
  return `<p class="bpara">${renderLine(t.split("\n").join(JOIN), [], { kind: "paragraph", indent: 0 })}</p>`;
}

/** The + between blocks, and its menu of block kinds when open. `after` is the block before it, or "" at the top. */
function adderHtml(after, name) {
  const open = b.adding === after;
  const label = after ? `Add a block after ${name}` : "Add a block at the top";
  const menu = open
    ? `<div class="kinds" role="group" aria-label="Kind of block">${KINDS.map(([k, n]) => `<button type="button" class="btn small" data-b-kind="${k}" data-b-after="${esc(after)}">${n}</button>`).join("")}</div>`
    : "";
  return `<div class="adder"><button type="button" class="btn small add-block" data-b-add="${esc(after)}" aria-expanded="${open}" aria-label="${esc(label)}">${icons.plus}</button>${menu}</div>`;
}

/** One block: as it reads with its tools, or its markdown in a text box while it is being edited. */
function blockRow(block, i, count) {
  const name = blockName(block, i);
  const by = block.generated ? '<span class="by gen">Generated</span>' : block.by === "claude" ? '<span class="by">Claude</span>' : "";
  if (b.editing === block.id) {
    const rows = Math.min(20, Math.max(3, block.text.split("\n").length + 1));
    return `<div class="bblock editing" data-block="${esc(block.id)}">
      <label class="lab" for="bt-${esc(block.id)}">Markdown of ${esc(name)}</label>
      <textarea id="bt-${esc(block.id)}" class="btext mono" rows="${rows}" aria-describedby="be-${esc(block.id)}">${esc(block.text)}</textarea>
      <p id="be-${esc(block.id)}" class="berr" role="alert">${esc(b.error)}</p>
      <div class="row end"><div><button type="button" class="btn small" data-b-cancel>Cancel</button><button type="button" class="btn small primary" data-b-save="${esc(block.id)}">Save</button></div></div>
    </div>`;
  }
  const tool = (attr, icon, label, disabled = false) =>
    `<button type="button" class="btn small btool" ${attr} aria-label="${esc(label)}" title="${esc(label)}"${disabled ? " disabled" : ""}>${icons[icon]}</button>`;
  const written = (b.build.undo ?? []).includes(block.id);
  const section = isSection(block)
    ? `${tool(`data-b-gen="${esc(block.id)}"`, "spark", `${written ? "Regenerate" : "Generate"} ${name}`)}${written ? tool(`data-b-undo="${esc(block.id)}"`, "undo", `Undo Claude's text in ${name}`) : ""}`
    : "";
  const extra = isSection(block) ? `${sectionStatus(block)}${b.generating === block.id ? generateForm(block, name) : ""}` : "";
  return `<div class="bblock kind-${block.kind}${block.generated ? " generated" : ""}" data-block="${esc(block.id)}">
    <div class="bbody">${blockHtml(block)}${extra}</div>
    <div class="btools">${by}${section}${tool(`data-b-edit="${esc(block.id)}"`, "edit", `Edit ${name}`)}${tool(`data-b-move="${esc(block.id)}" data-b-to="up"`, "up", `Move ${name} up`, i === 0)}${tool(`data-b-move="${esc(block.id)}" data-b-to="down"`, "down", `Move ${name} down`, i === count - 1)}${tool(`data-b-remove="${esc(block.id)}"`, "trash", `Remove ${name}`)}</div>
  </div>`;
}

/** The build's changes, newest first. */
function historyHtml(steps) {
  if (!steps.length) return "";
  const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const rows = [...steps]
    .reverse()
    .map(
      (s) =>
        `<li><span class="who">${esc(s.by === "claude" ? "Claude" : s.by === "person" ? "You" : s.by)}</span> ${esc(s.what)} <span class="m">${esc(when(s.at))}</span></li>`,
    )
    .join("");
  return `<details class="trail build-trail"><summary>History (${steps.length})</summary><ol>${rows}</ol></details>`;
}

function paint() {
  const { meta } = b.view;
  const blocks = b.build.blocks;
  document.title = `${meta.title} · hoop`;
  const who = b.view.session?.label ?? meta.owner;
  const rows = blocks.map((block, i) => blockRow(block, i, blocks.length) + adderHtml(block.id, blockName(block, i))).join("");
  app.innerHTML = frame(
    "",
    `<header class="top">
      <div class="title-row"><h1>${esc(meta.title)}</h1><div class="actions"></div></div>
      <div class="sub">${statusBadge("building")}${who ? `<span class="owner">with ${esc(who)}</span>` : ""}</div>
    </header>
    <main class="build">
      <p class="build-help">Build the document here with Claude. Add a block with +, edit any block, and move or remove it. Generate asks Claude to write a section; Undo puts back what was there. It exports as markdown, exactly as written.</p>
      ${b.error && !b.editing ? `<p class="berr" role="alert">${esc(b.error)}</p>` : ""}
      ${adderHtml("", "")}
      <div class="blocks">${rows || '<p class="empty">No blocks yet. Add one with +.</p>'}</div>
      ${historyHtml(b.build.steps)}
    </main>`,
    b.info,
  );
  mountDiagrams(app);
  const focus = b.focus;
  b.focus = null;
  if (focus) {
    const el = app.querySelector(focus);
    el?.focus();
    if (el instanceof HTMLTextAreaElement) el.select();
  }
}

/** Sends a change, then shows the build the server returns; a refusal shows beside the block. */
async function change(body, focus) {
  try {
    b.build = await send(body);
    b.error = "";
    b.editing = null;
    b.adding = null;
    b.generating = null;
  } catch (err) {
    b.error = err.message;
  }
  b.focus = focus?.() ?? null;
  paint();
}

const sel = (attr, id) => `[${attr}="${CSS.escape(id)}"]`;

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t || !b.build) return;
  const d = t.dataset;
  if (!b.editing) b.error = "";
  if (d.bAdd !== undefined) {
    b.adding = b.adding === d.bAdd ? null : d.bAdd;
    b.focus = b.adding === null ? sel("data-b-add", d.bAdd) : `[data-b-kind][data-b-after="${CSS.escape(d.bAdd)}"]`;
    paint();
  } else if (d.bKind) {
    const before = new Set(b.build.blocks.map((x) => x.id));
    await change({ op: "add", kind: d.bKind, ...(d.bAfter ? { after: d.bAfter } : {}) });
    // A new block opens for editing, with its starting text selected.
    const added = b.build.blocks.find((x) => !before.has(x.id));
    if (added) {
      b.editing = added.id;
      b.focus = `#bt-${CSS.escape(added.id)}`;
      paint();
    }
  } else if (d.bEdit) {
    b.editing = d.bEdit;
    b.error = "";
    b.focus = `#bt-${CSS.escape(d.bEdit)}`;
    paint();
  } else if (d.bSave) save(d.bSave);
  else if (t.hasAttribute("data-b-cancel")) cancel();
  else if (d.bMove) change({ op: "move", block: d.bMove, to: d.bTo }, () => sel("data-b-edit", d.bMove));
  else if (d.bGen) {
    b.generating = b.generating === d.bGen ? null : d.bGen;
    b.focus = b.generating ? `#bn-${CSS.escape(d.bGen)}` : sel("data-b-gen", d.bGen);
    paint();
  } else if (t.hasAttribute("data-b-gen-cancel")) closeGenerate();
  else if (d.bUndo) change({ op: "undo", block: d.bUndo }, () => sel("data-b-gen", d.bUndo));
  else if (d.bRemove) {
    const i = b.build.blocks.findIndex((x) => x.id === d.bRemove);
    const before = b.build.blocks[i - 1]?.id ?? "";
    change({ op: "remove", block: d.bRemove }, () => sel("data-b-add", before));
  }
});

function closeGenerate() {
  const id = b.generating;
  b.generating = null;
  b.focus = id ? sel("data-b-gen", id) : null;
  paint();
}

document.addEventListener("submit", (e) => {
  const form = e.target.closest?.("[data-b-gen-form]");
  if (!form) return;
  e.preventDefault();
  const block = form.dataset.bGenForm;
  const note = form.querySelector("input").value.trim();
  change({ op: "generate", block, ...(note ? { note } : {}) }, () => sel("data-b-gen", block));
});

function save(id) {
  const text = document.getElementById(`bt-${id}`)?.value ?? "";
  change({ op: "edit", block: id, text }, () => (b.editing ? `#bt-${CSS.escape(id)}` : sel("data-b-edit", id)));
}

function cancel() {
  const id = b.editing;
  b.editing = null;
  b.error = "";
  b.focus = id ? sel("data-b-edit", id) : null;
  paint();
}

document.addEventListener("keydown", (e) => {
  if (!b.build) return;
  if (e.target.classList?.contains("btext")) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save(b.editing);
    }
  } else if (e.key === "Escape" && b.generating !== null) {
    e.preventDefault();
    closeGenerate();
  } else if (e.key === "Escape" && b.adding !== null) {
    const at = b.adding;
    b.adding = null;
    b.focus = sel("data-b-add", at);
    paint();
  }
});

/** Asks for the build again, and shows it when it changed, unless the person is typing in a block. */
async function refresh() {
  // A typed block or note would be lost to a redraw, so the page waits until it is saved or closed.
  if (document.visibilityState !== "visible" || b.editing || b.generating) return;
  const build = await api(`/api/reviews/${b.view.meta.id}/build`).catch(() => undefined);
  if (!build || build.version === b.build.version || b.editing || b.generating) return;
  b.build = build;
  const active = document.activeElement;
  const keep = [...(active?.attributes ?? [])].find((a) => a.name.startsWith("data-b-") && a.value);
  b.focus = keep ? sel(keep.name, keep.value) : null;
  paint();
}

/** Shows a build from its review view, and asks for changes every few seconds while visible. */
export function renderBuild(view, info) {
  b.view = view;
  b.build = view.build;
  b.info = info;
  paint();
  setInterval(refresh, window.HOOP_BUILD_MS ?? 2000);
  document.addEventListener("visibilitychange", refresh);
}
