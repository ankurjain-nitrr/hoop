// The build page: a document the person and Claude build together, one block at a time. The person
// adds blocks with +, edits any block in place with a formatting toolbar, and moves or removes it. The
// page speaks in plain words: a `##` heading is "Heading 1", a `###` one "Heading 2", and no markdown
// shows outside a block's editor. The document reads as an outline: everything under a heading sits
// inside it, indented, and folds; a heading moves and can be removed with everything under it. The page asks for the build again every few seconds while visible, so
// Claude's changes show without a reload.
import { esc } from "/esc.js";
import { frame } from "/frame.js";
import { statusBadge } from "/status.js";
import { renderLine, renderTableRow } from "/inline.js";
import { headingLevel, ITEM, JOIN, parentOf, rowCells, swapRange, TABLE_DELIM, unitRange } from "/blocks.js";
import { diagramHtml, mountDiagrams } from "/diagram.js";
import { icons } from "/icons.js";
import { applyTool, headingSource, TOOLS } from "/format.js";

const app = document.getElementById("app");

/** The kinds of block + adds, in menu order, with the name people read. */
export const KINDS = [
  ["h1", "Title"],
  ["h2", "Heading 1"],
  ["h3", "Heading 2"],
  ["paragraph", "Paragraph"],
  ["list", "List"],
  ["table", "Table"],
  ["code", "Code"],
  ["diagram", "Diagram"],
];
const KIND_NAME = Object.fromEntries(KINDS);

/** A heading's name by its level: the `#` title is "Title", `##` is "Heading 1", `###` "Heading 2", and so on. */
const headingName = (level) => (level === 1 ? "Title" : `Heading ${level - 1}`);

/**
 * The page's state: the review view, the build, which block is being edited, which + menu, Generate
 * note or Remove choice is open, and which sections are folded (for as long as the page is open).
 */
const b = {
  view: null,
  build: null,
  info: undefined,
  editing: null,
  adding: null,
  generating: null,
  suggesting: null,
  retitling: null,
  removing: null,
  error: "",
  focus: null,
};
const folded = new Set();

/** Whether Claude can write under a block: a heading below the title. */
const isSection = (block) => block.kind === "h2" || block.kind === "h3";

/** What each request kind asks Claude for, as its queued and taken lines say it. */
const ASKED = {
  write: ["writes everything under this heading", "is writing everything under this heading"],
  outline: ["suggests an outline", "is suggesting an outline"],
  next: ["suggests the next heading", "is suggesting the next heading"],
  subsections: ["suggests subheadings", "is suggesting subheadings"],
};

/** The suggestions a heading offers, with the button text people read: an outline under a title, subheadings, the next heading after the last of its siblings. */
function suggestionsFor(block, i) {
  const level = headingLevel(block);
  if (level === 1) return [["outline", "Suggest an outline"]];
  if (level < 2) return [];
  const out = level < 6 ? [["subsections", "Suggest subheadings"]] : [];
  if (!swapRange(b.build.blocks, i, "down")) out.push(["next", "Suggest the next heading"]);
  return out;
}

/** What a heading waits for: each open request, queued or being worked on by Claude. */
function sectionStatus(block) {
  return (b.build.requests ?? [])
    .filter((x) => x.block === block.id && x.status !== "written")
    .map((r) => {
      const [queued, taken] = ASKED[r.kind ?? "write"];
      const text = r.status === "taken" ? `Claude ${taken}…` : `Queued: Claude ${queued} when its session next checks the build.`;
      return `<p class="bstatus" role="status">${icons.clock}<span>${esc(text)}</span>${r.note ? ` <span class="bnote">Note: ${esc(r.note)}</span>` : ""}</p>`;
    })
    .join("");
}

/** The form a Suggest button opens: optional notes for Claude, a larger box for an outline. */
function suggestForm(block, kind, label) {
  const id = esc(block.id);
  const field =
    kind === "outline"
      ? `<textarea id="bs-note-${id}" class="bnote-in" name="note" rows="3" maxlength="2000" placeholder="Purpose, key points, links"></textarea>`
      : `<input id="bs-note-${id}" class="bnote-in" name="note" maxlength="500" autocomplete="off" placeholder="For example: cover the risks">`;
  return `<form class="bgen" data-b-suggest-form="${id}" data-kind="${kind}">
    <label class="lab" for="bs-note-${id}">Notes for Claude (optional)</label>
    ${field}
    <div class="row end"><div><button type="button" class="btn small" data-b-suggest-cancel>Cancel</button><button type="submit" class="btn small primary">${esc(label)}</button></div></div>
  </form>`;
}

/**
 * Claude's suggested headings for one place in the outline, as dashed placeholders that change
 * nothing until accepted: each with Accept, Edit and Dismiss, and Accept all when there are several.
 * `inside` is true for an outline or subsections, which sit in the anchor's section.
 */
function proposalsHtml(anchor, inside) {
  const props = (b.build.proposals ?? []).filter((p) => p.anchor === anchor.id && (p.kind === "next") !== inside);
  if (!props.length) return "";
  const base = Math.min(...props.map((p) => p.level));
  const groups = [...new Set(props.map((p) => p.request))];
  const where = headingText(anchor.text);
  return groups
    .map((request) => {
      const list = props.filter((p) => p.request === request);
      const rows = list
        .map((p) => {
          const name = `suggested heading “${p.title}”`;
          const pid = esc(p.id);
          if (b.retitling === p.id)
            return `<div class="bprop editing bprop-d${Math.min(4, p.level - base)}" data-proposal="${pid}">
              <label class="lab" for="bp-${pid}">Title of the ${esc(name)}</label>
              <input id="bp-${pid}" class="bnote-in bprop-in" value="${esc(p.title)}" maxlength="200" autocomplete="off">
              <div class="row end"><div><button type="button" class="btn small" data-b-retitle-cancel>Cancel</button><button type="button" class="btn small primary" data-b-retitle-save="${pid}">Save</button></div></div>
            </div>`;
          return `<div class="bprop bprop-d${Math.min(4, p.level - base)}" data-proposal="${pid}">
            <div class="bprop-text"><span class="bprop-h"><span class="bprop-k">${headingName(p.level)}</span> ${esc(p.title)}</span>${p.note ? `<span class="bprop-note">${esc(p.note)}</span>` : ""}</div>
            <div class="bprop-acts"><button type="button" class="btn small primary" data-b-accept="${pid}" aria-label="${esc(`Accept ${name}`)}">Accept</button><button type="button" class="btn small" data-b-retitle="${pid}" aria-label="${esc(`Edit ${name}`)}">Edit</button><button type="button" class="btn small" data-b-dismiss="${pid}" aria-label="${esc(`Dismiss ${name}`)}">Dismiss</button></div>
          </div>`;
        })
        .join("");
      const all =
        list.length > 1
          ? `<button type="button" class="btn small" data-b-accept-all="${esc(request)}" aria-label="${esc(`Accept all ${list.length} suggested headings for “${where}”`)}">Accept all</button>`
          : "";
      return `<div class="bprops${inside ? " in" : ""}" role="group" aria-label="${esc(`Claude's suggested headings for “${where}”`)}">
        <div class="bprops-head"><span>Claude suggests</span>${all}</div>${rows}
      </div>`;
    })
    .join("");
}

/** The Generate form under a heading: an optional note for Claude. */
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

const headingText = (text) =>
  text
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/\s+#+\s*$/, "")
    .trim();

/** A block as people name it in a control's label: a heading's text, else its kind and place. */
function blockName(block, i) {
  const level = headingLevel(block);
  if (level) return `${headingName(level)} “${headingText(block.text)}”`;
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

/** The formatting buttons above a block's text box, each named for the block it formats. */
function toolbarHtml(id, name) {
  const buttons = TOOLS.map(
    ([tool, label]) =>
      `<button type="button" class="btn small bfmt bfmt-${tool}" data-b-tool="${tool}" data-b-for="${esc(id)}" aria-label="${esc(`${label} in ${name}`)}" title="${esc(label)}">${esc(label)}</button>`,
  ).join("");
  return `<div class="bfmts" role="group" aria-label="${esc(`Formatting for ${name}`)}">${buttons}</div>`;
}

/** One block: as it reads with its tools, or its text in a box, with the formatting buttons, while it is being edited. */
function blockRow(block, i) {
  const blocks = b.build.blocks;
  const name = blockName(block, i);
  const removeTool = `<button type="button" class="btn small btool" data-b-remove="${esc(block.id)}" aria-label="${esc(`Remove ${name}`)}" title="${esc(`Remove ${name}`)}"${asksToRemove(blocks, i) ? ` aria-expanded="${b.removing === block.id}"` : ""}>${icons.trash}</button>`;
  const by = block.generated ? '<span class="by gen">Generated</span>' : block.by === "claude" ? '<span class="by">Claude</span>' : "";
  if (b.editing === block.id) {
    const id = esc(block.id);
    const level = headingLevel(block);
    const rows = Math.min(20, Math.max(3, block.text.split("\n").length + 1));
    const prose = !level && block.kind !== "code" && block.kind !== "diagram";
    const box = level
      ? `<input id="bt-${id}" class="btext bhead-in" data-level="${level}" value="${esc(headingText(block.text))}" maxlength="300" autocomplete="off" aria-describedby="be-${id}">`
      : `<textarea id="bt-${id}" class="btext${prose ? "" : " mono"}" rows="${rows}" aria-describedby="be-${id}">${esc(block.text)}</textarea>`;
    return `<div class="bblock editing" data-block="${id}">
      <label class="lab" for="bt-${id}">Text of ${esc(name)}</label>
      ${prose ? toolbarHtml(block.id, name) : ""}${box}
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
  const asks = headingLevel(block) ? suggestionsFor(block, i) : [];
  const suggest = asks.length
    ? `<div class="bsuggest">${asks.map(([kind, label]) => `<button type="button" class="btn small" data-b-suggest="${esc(block.id)}" data-kind="${kind}" aria-expanded="${b.suggesting?.block === block.id && b.suggesting.kind === kind}" aria-label="${esc(`${label} for ${name}`)}">${icons.spark}<span>${esc(label)}</span></button>`).join("")}</div>`
    : "";
  const open = asks.find(([kind]) => b.suggesting?.block === block.id && b.suggesting.kind === kind);
  const extra = headingLevel(block)
    ? `${sectionStatus(block)}${b.generating === block.id ? generateForm(block, name) : ""}${suggest}${open ? suggestForm(block, open[0], open[1]) : ""}`
    : "";
  return `<div class="bblock kind-${block.kind}${block.generated ? " generated" : ""}" data-block="${esc(block.id)}">
    <div class="bbody">${blockHtml(block)}${extra}</div>
    <div class="btools">${by}${section}${tool(`data-b-edit="${esc(block.id)}"`, "edit", `Edit ${name}`)}${tool(`data-b-move="${esc(block.id)}" data-b-to="up"`, "up", `Move ${name} up`, !swapRange(blocks, i, "up"))}${tool(`data-b-move="${esc(block.id)}" data-b-to="down"`, "down", `Move ${name} down`, !swapRange(blocks, i, "down"))}${removeTool}</div>
    ${b.removing === block.id ? removeChoice(block, name) : ""}
  </div>`;
}

/** Whether removing block `i` asks first: a heading with blocks under it. */
const asksToRemove = (blocks, i) => unitRange(blocks, i)[1] - i > 1;

/** The choice Remove opens on a heading with blocks under it: take them with it, or leave them to the heading above. */
function removeChoice(block, name) {
  const id = esc(block.id);
  return `<div class="bremove" role="group" aria-label="${esc(`Remove ${name}`)}">
    <button type="button" class="btn small danger" data-b-remove-section="${id}">Remove this heading and everything under it</button>
    <button type="button" class="btn small" data-b-remove-heading="${id}">Remove only the heading</button>
    <button type="button" class="btn small" data-b-remove-cancel>Cancel</button>
  </div>`;
}

/**
 * Blocks `from` to `to` as an outline: each heading's section, up to the next heading at its level or
 * above, sits in a fold under it, indented, with the + after the heading adding to that section.
 */
function outlineHtml(from, to) {
  const blocks = b.build.blocks;
  let html = "";
  for (let i = from; i < to; ) {
    const block = blocks[i];
    const name = blockName(block, i);
    if (!headingLevel(block)) {
      html += blockRow(block, i) + adderHtml(block.id, name);
      i++;
      continue;
    }
    const end = unitRange(blocks, i)[1];
    const open = !folded.has(block.id);
    const body = `bs-${esc(block.id)}`;
    const toggle = `<button type="button" class="btn small bfold" data-b-fold="${esc(block.id)}" aria-expanded="${open}" aria-controls="${body}" aria-label="${esc(`${open ? "Collapse" : "Expand"} ${name}`)}" title="${open ? "Collapse" : "Expand"}">${open ? icons.collapse : icons.expand}</button>`;
    const count = end - i - 1;
    const summary = open || !count ? "" : `<p class="bfolded">${count} ${count === 1 ? "block" : "blocks"} folded</p>`;
    html += `<div class="bsec bsec-${headingLevel(block)}" data-section="${esc(block.id)}">
      <div class="bsec-head">${toggle}${blockRow(block, i)}</div>${summary}
      <div class="bsec-body" id="${body}"${open ? "" : " hidden"}>${adderHtml(block.id, name)}${outlineHtml(i + 1, end)}</div>${proposalsHtml(block, true)}
    </div>${proposalsHtml(block, false)}`;
    i = end;
  }
  return html;
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
  const rows = outlineHtml(0, blocks.length);
  app.innerHTML = frame(
    "",
    `<header class="top">
      <div class="title-row"><h1>${esc(meta.title)}</h1><div class="actions"><button type="button" class="btn primary" id="finishBuild" title="Turn the build into a review of the whole document">Finish and review</button></div></div>
      <div class="sub">${statusBadge("building")}${who ? `<span class="owner">with ${esc(who)}</span>` : ""}</div>
    </header>
    <main class="build">
      <p class="build-help">Build the document here with Claude. Add a title, a heading, a paragraph, a list, a table, code or a diagram with +. Edit any of them, with buttons for bold, italic, links, lists, tables and code, and move or remove them. A heading holds everything under it, up to the next heading of the same size or larger: it moves with it, and folds it. Suggest asks Claude for headings, which join the document only when you accept them. Generate asks Claude to write everything under a heading; Undo puts back what was there. Finish turns it into a review of the whole document.</p>
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
    if (el?.classList.contains("btext")) el.select();
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
    b.suggesting = null;
    b.retitling = null;
    b.removing = null;
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
  if (t.id === "finishBuild") return finish();
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
      const blocks = b.build.blocks;
      for (let k = parentOf(blocks, blocks.indexOf(added)); k >= 0; k = parentOf(blocks, k)) folded.delete(blocks[k].id);
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
  else if (d.bTool) format(d.bFor, d.bTool);
  else if (d.bSuggest) {
    const same = b.suggesting?.block === d.bSuggest && b.suggesting.kind === d.kind;
    b.suggesting = same ? null : { block: d.bSuggest, kind: d.kind };
    b.focus = same ? `[data-b-suggest="${CSS.escape(d.bSuggest)}"][data-kind="${d.kind}"]` : `#bs-note-${CSS.escape(d.bSuggest)}`;
    paint();
  } else if (t.hasAttribute("data-b-suggest-cancel")) closeSuggest();
  else if (d.bAccept || d.bAcceptAll) {
    const before = new Set(b.build.blocks.map((x) => x.id));
    await change(d.bAccept ? { op: "accept", proposal: d.bAccept } : { op: "accept_all", request: d.bAcceptAll });
    // Focus goes to the next suggestion waiting, else to the first new heading.
    const next = document.querySelector("[data-b-accept]");
    const added = b.build.blocks.find((x) => !before.has(x.id));
    b.focus = next ? sel("data-b-accept", next.dataset.bAccept) : added ? sel("data-b-edit", added.id) : null;
    if (b.focus) paint();
  } else if (d.bDismiss) {
    change({ op: "dismiss", proposal: d.bDismiss }, () => {
      const next = document.querySelector("[data-b-accept]");
      return next ? sel("data-b-accept", next.dataset.bAccept) : null;
    });
  } else if (d.bRetitle) {
    b.retitling = d.bRetitle;
    b.focus = `#bp-${CSS.escape(d.bRetitle)}`;
    paint();
  } else if (d.bRetitleSave) retitle(d.bRetitleSave);
  else if (t.hasAttribute("data-b-retitle-cancel")) closeRetitle();
  else if (t.hasAttribute("data-b-cancel")) cancel();
  else if (d.bMove) change({ op: "move", block: d.bMove, to: d.bTo }, () => sel("data-b-edit", d.bMove));
  else if (d.bGen) {
    b.generating = b.generating === d.bGen ? null : d.bGen;
    b.focus = b.generating ? `#bn-${CSS.escape(d.bGen)}` : sel("data-b-gen", d.bGen);
    paint();
  } else if (t.hasAttribute("data-b-gen-cancel")) closeGenerate();
  else if (d.bUndo) change({ op: "undo", block: d.bUndo }, () => sel("data-b-gen", d.bUndo));
  else if (d.bFold) {
    if (folded.has(d.bFold)) folded.delete(d.bFold);
    else folded.add(d.bFold);
    b.focus = sel("data-b-fold", d.bFold);
    paint();
  } else if (d.bRemove) {
    const blocks = b.build.blocks;
    const i = blocks.findIndex((x) => x.id === d.bRemove);
    // A heading with a section asks whether its section goes too.
    if (asksToRemove(blocks, i)) {
      b.removing = b.removing === d.bRemove ? null : d.bRemove;
      b.focus = b.removing ? sel("data-b-remove-section", d.bRemove) : sel("data-b-remove", d.bRemove);
      paint();
    } else remove(d.bRemove, false);
  } else if (d.bRemoveSection) remove(d.bRemoveSection, true);
  else if (d.bRemoveHeading) remove(d.bRemoveHeading, false);
  else if (t.hasAttribute("data-b-remove-cancel")) closeRemove();
});

/** Removes a block, or a heading with its section; focus goes to the + before it. */
function remove(id, section) {
  const blocks = b.build.blocks;
  const i = blocks.findIndex((x) => x.id === id);
  const before = blocks[i - 1]?.id ?? "";
  change({ op: "remove", block: id, ...(section ? { section: true } : {}) }, () => sel("data-b-add", before));
}

function closeRemove() {
  const id = b.removing;
  b.removing = null;
  b.focus = id ? sel("data-b-remove", id) : null;
  paint();
}

/** Turns the build into a review, then shows the review page. */
async function finish() {
  try {
    await api(`/api/reviews/${b.view.meta.id}/finish`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    location.reload();
  } catch (err) {
    b.error = err.message;
    b.focus = "#finishBuild";
    paint();
  }
}

function closeSuggest() {
  const s = b.suggesting;
  b.suggesting = null;
  b.focus = s ? `[data-b-suggest="${CSS.escape(s.block)}"][data-kind="${s.kind}"]` : null;
  paint();
}

function retitle(id) {
  const title = document.getElementById(`bp-${id}`)?.value ?? "";
  change({ op: "retitle", proposal: id, title }, () => (b.retitling ? `#bp-${CSS.escape(id)}` : sel("data-b-accept", id)));
}

function closeRetitle() {
  const id = b.retitling;
  b.retitling = null;
  b.error = "";
  b.focus = id ? sel("data-b-accept", id) : null;
  paint();
}

function closeGenerate() {
  const id = b.generating;
  b.generating = null;
  b.focus = id ? sel("data-b-gen", id) : null;
  paint();
}

document.addEventListener("submit", (e) => {
  const ask = e.target.closest?.("[data-b-suggest-form]");
  if (ask) {
    e.preventDefault();
    const block = ask.dataset.bSuggestForm;
    const kind = ask.dataset.kind;
    const note = ask.querySelector(".bnote-in").value.trim();
    change({ op: "suggest", block, kind, ...(note ? { note } : {}) }, () => `[data-b-suggest="${CSS.escape(block)}"][data-kind="${kind}"]`);
    return;
  }
  const form = e.target.closest?.("[data-b-gen-form]");
  if (!form) return;
  e.preventDefault();
  const block = form.dataset.bGenForm;
  const note = form.querySelector("input").value.trim();
  change({ op: "generate", block, ...(note ? { note } : {}) }, () => sel("data-b-gen", block));
});

function save(id) {
  const box = document.getElementById(`bt-${id}`);
  const text = headingSource(Number(box?.dataset.level) || 0, box?.value ?? "");
  change({ op: "edit", block: id, text }, () => (b.editing ? `#bt-${CSS.escape(id)}` : sel("data-b-edit", id)));
}

/** Applies a formatting button to the block's text box, keeping focus there with the new selection. */
function format(id, tool) {
  const box = document.getElementById(`bt-${id}`);
  if (!box) return;
  const next = applyTool(tool, box.value, box.selectionStart, box.selectionEnd);
  box.value = next.text;
  box.focus();
  box.setSelectionRange(next.start, next.end);
  box.rows = Math.min(20, Math.max(box.rows, next.text.split("\n").length + 1));
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
  if (e.target.closest?.(".bblock.editing")) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.target.classList.contains("btext") && e.key === "Enter" && (e.metaKey || e.ctrlKey || e.target.tagName === "INPUT")) {
      e.preventDefault();
      save(b.editing);
    }
  } else if (e.target.classList?.contains("bprop-in") && (e.key === "Enter" || e.key === "Escape")) {
    e.preventDefault();
    if (e.key === "Enter") retitle(b.retitling);
    else closeRetitle();
  } else if (e.key === "Escape" && b.suggesting !== null) {
    e.preventDefault();
    closeSuggest();
  } else if (e.key === "Escape" && b.removing !== null) {
    e.preventDefault();
    closeRemove();
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
  const busy = () => b.editing || b.generating || b.suggesting || b.retitling || b.removing;
  if (document.visibilityState !== "visible" || busy()) return;
  const build = await api(`/api/reviews/${b.view.meta.id}/build`).catch(() => undefined);
  if (!build || build.version === b.build.version || busy()) return;
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
