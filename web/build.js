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
import { headingLevel, ITEM, JOIN, parentOf, rowCells, SUBTITLE, swapRange, TABLE_DELIM, unitRange } from "/blocks.js";
import { diagramHtml, mountDiagrams } from "/diagram.js";
import { icons } from "/icons.js";
import { applyTool, headingSource, TABLE_TOOLS, TOOLS } from "/format.js";
import { blockActions, changeBar, commentForm, regenForm, requestLine, threadsHtml } from "/revise.js";

const app = document.getElementById("app");

/** The kinds of block + adds, in menu order, with the name people read. */
export const KINDS = [
  ["h1", "Title"],
  ["subtitle", "Subtitle"],
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
 * The page's state: the review view, the build, which blocks are in Edit mode (the rest are in
 * Preview) with the text typed in each, which + menu, Generate note, Generate again or Comment form
 * or Remove choice is open, the words last selected in a block, and which sections are folded (for
 * as long as the page is open).
 */
const b = {
  view: null,
  build: null,
  info: undefined,
  editing: new Set(),
  drafts: {},
  adding: null,
  generating: null,
  regenerating: null,
  commenting: null,
  picked: null,
  pressed: null,
  errorAt: null,
  errors: [],
  finishError: "",
  commentText: "",
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

/** A subtitle's words, without the emphasis markers around them. */
const subtitleText = (text) => {
  const m = text.trim().match(SUBTITLE);
  return m ? (m[1] ?? m[2]) : text.trim();
};

/** A subtitle's markdown from the words in its box, with the marker it had (`*` for a new one). */
const subtitleSource = (old, words) => {
  const text = words.replace(/\s+/g, " ").trim();
  // Words that hold the marker take the other one, so the line stays one line of emphasis.
  const had = old.trim().startsWith("_") ? "_" : "*";
  const mark = text.includes(had) ? (had === "_" ? "*" : "_") : had;
  return text ? `${mark}${text}${mark}` : "";
};

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
  if (block.kind === "subtitle") return `<p class="bsub">${renderLine(subtitleText(t), [], { kind: "paragraph", indent: 0 })}</p>`;
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

/** Whether + after block `after` offers a subtitle: right under a title that starts the document, while it has none. */
function subtitleFits(after) {
  const blocks = b.build.blocks;
  return blocks[0]?.kind === "h1" && blocks[0].id === after && blocks[1]?.kind !== "subtitle";
}

/** The + between blocks, and its menu of block kinds when open. `after` is the block before it, or "" at the top. */
function adderHtml(after, name) {
  const open = b.adding === after;
  const label = after ? `Add a block after ${name}` : "Add a block at the top";
  const menu = open
    ? `<div class="kinds" role="group" aria-label="Kind of block">${KINDS.filter(([k]) => k !== "subtitle" || subtitleFits(after))
        .map(([k, n]) => `<button type="button" class="btn small" data-b-kind="${k}" data-b-after="${esc(after)}">${n}</button>`)
        .join("")}</div>`
    : "";
  return `<div class="adder"><button type="button" class="btn small add-block" data-b-add="${esc(after)}" aria-expanded="${open}" aria-label="${esc(label)}">${icons.plus}</button>${menu}</div>`;
}

/** The key formatting shortcuts go with: Cmd on a Mac, else Ctrl. */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd" : "Ctrl";

/**
 * Whether a key press is the formatting shortcut's modifier alone: Cmd on a Mac, where Ctrl+B and
 * Ctrl+K are text bindings of their own, else Ctrl; never while an input method is composing.
 */
const modKey = (e) => !e.isComposing && !e.altKey && !e.shiftKey && (MOD === "Cmd" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/** The formatting buttons above a block's text box, each named for the block it formats; a table's cells take only inline ones. */
function toolbarHtml(id, name, kind) {
  const buttons = TOOLS.filter(([tool]) => kind !== "table" || TABLE_TOOLS.includes(tool))
    .map(([tool, label, key]) => {
      const keys = key ? ` aria-keyshortcuts="${MOD === "Cmd" ? "Meta" : "Control"}+${key.toUpperCase()}"` : "";
      const title = key ? `${label} (${MOD}+${key.toUpperCase()})` : label;
      return `<button type="button" class="btn small bfmt bfmt-${tool}" data-b-tool="${tool}" data-b-for="${esc(id)}" aria-label="${esc(`${label} in ${name}`)}" title="${esc(title)}"${keys}>${esc(label)}</button>`;
    })
    .join("");
  return `<div class="bfmts" role="group" aria-label="${esc(`Formatting for ${name}`)}">${buttons}</div>`;
}

/** One block: as it reads with its tools, or its text in a box, with the formatting buttons, while it is being edited. */
function blockRow(block, i) {
  const blocks = b.build.blocks;
  const name = blockName(block, i);
  const removeTool = `<button type="button" class="btn small btool" data-b-remove="${esc(block.id)}" aria-label="${esc(`Remove ${name}`)}" title="${esc(`Remove ${name}`)}"${asksToRemove(blocks, i) ? ` aria-expanded="${b.removing === block.id}"` : ""}>${icons.trash}</button>`;
  const by = block.generated ? '<span class="by gen">Generated</span>' : block.by === "claude" ? '<span class="by">Claude</span>' : "";
  if (b.editing.has(block.id)) {
    const id = esc(block.id);
    const level = headingLevel(block);
    const sub = block.kind === "subtitle";
    const text = b.drafts[block.id] ?? (level ? headingText(block.text) : sub ? subtitleText(block.text) : block.text);
    const rows = Math.min(20, Math.max(3, text.split("\n").length + 1));
    const prose = !level && !sub && block.kind !== "code" && block.kind !== "diagram";
    const box = level
      ? `<input id="bt-${id}" class="btext bhead-in" data-level="${level}" value="${esc(text)}" maxlength="300" autocomplete="off" aria-describedby="be-${id}">`
      : sub
        ? `<input id="bt-${id}" class="btext bsub-in" value="${esc(text)}" maxlength="300" autocomplete="off" aria-describedby="be-${id}">`
        : `<textarea id="bt-${id}" class="btext${prose ? "" : " mono"}" rows="${rows}" aria-describedby="be-${id}">${esc(text)}</textarea>`;
    return `<div class="bblock editing" data-block="${id}">
      <label class="lab" for="bt-${id}">Text of ${esc(name)}</label>
      ${prose ? toolbarHtml(block.id, name, block.kind) : ""}${box}
      <p id="be-${id}" class="berr" role="alert">${b.errorAt === block.id ? esc(b.error) : ""}</p>
      <div class="row end"><div><button type="button" class="btn small" data-b-cancel="${id}" aria-label="${esc(`Cancel editing ${name}`)}">Cancel</button><button type="button" class="btn small primary" data-b-save="${id}" aria-label="${esc(`Preview ${name}`)}" title="Save and show it formatted">Preview</button></div></div>
    </div>`;
  }
  const tool = (attr, icon, label, disabled = false) =>
    `<button type="button" class="btn small btool" ${attr} aria-label="${esc(label)}" title="${esc(label)}"${disabled ? " disabled" : ""}>${icons[icon]}</button>`;
  const written = (b.build.undo ?? []).includes(block.id);
  const gen = written ? "Generate again" : "Generate";
  const section = isSection(block)
    ? `<button type="button" class="btn small bgen-btn" data-b-gen="${esc(block.id)}" aria-label="${esc(`${gen} ${name}`)}">${icons.spark}<span>${gen}</span></button>${written ? tool(`data-b-undo="${esc(block.id)}"`, "undo", `Undo Claude's text in ${name}`) : ""}`
    : "";
  const asks = headingLevel(block) ? suggestionsFor(block, i) : [];
  const suggest = asks.length
    ? `<div class="bsuggest">${asks.map(([kind, label]) => `<button type="button" class="btn small" data-b-suggest="${esc(block.id)}" data-kind="${kind}" aria-expanded="${b.suggesting?.block === block.id && b.suggesting.kind === kind}" aria-label="${esc(`${label} for ${name}`)}">${icons.spark}<span>${esc(label)}</span></button>`).join("")}</div>`
    : "";
  const open = asks.find(([kind]) => b.suggesting?.block === block.id && b.suggesting.kind === kind);
  const extra = headingLevel(block)
    ? `${sectionStatus(block)}${b.generating === block.id ? generateForm(block, name) : ""}${suggest}${open ? suggestForm(block, open[0], open[1]) : ""}`
    : blockExtras(block, i, name);
  const changed = (b.build.changes ?? []).some((c) => c.blocks.includes(block.id));
  return `<div class="bblock kind-${block.kind}${block.generated ? " generated" : ""}${changed ? " changed" : ""}" data-block="${esc(block.id)}">
    <div class="bbody">${blockHtml(block)}${extra}</div>
    <div class="btools">${by}${section}${tool(`data-b-edit="${esc(block.id)}"`, "edit", `Edit ${name}`)}${tool(`data-b-move="${esc(block.id)}" data-b-to="up"`, "up", `Move ${name} up`, !swapRange(blocks, i, "up"))}${tool(`data-b-move="${esc(block.id)}" data-b-to="down"`, "down", `Move ${name} down`, !swapRange(blocks, i, "down"))}${removeTool}</div>
    ${b.removing === block.id ? removeChoice(block, name) : ""}
  </div>`;
}

/**
 * What sits under a block in Preview that isn't a heading: Claude's change waiting on it, where its
 * requests stand, Generate again (on a block Claude wrote) and Comment with their forms, and its
 * comment threads.
 */
function blockExtras(block, i, name) {
  const blocks = b.build.blocks;
  // The bar sits on the change's first block that is still there.
  const change = (b.build.changes ?? []).find((c) => c.blocks.find((id) => blocks.some((x) => x.id === id)) === block.id);
  const p = parentOf(blocks, i);
  const parent = p >= 0 && isSection(blocks[p]) ? { id: blocks[p].id, title: headingText(blocks[p].text) } : undefined;
  const waiting = (b.build.requests ?? [])
    .filter((r) => r.block === block.id)
    .map(requestLine)
    .join("");
  const open = b.regenerating === block.id ? "regen" : b.commenting?.block === block.id ? "comment" : "";
  const form =
    open === "regen"
      ? regenForm(block, name, parent)
      : open === "comment"
        ? commentForm(block, name, b.commenting.selection, b.commentText, b.errorAt === `comment:${block.id}` ? b.error : "")
        : "";
  const threads = (b.build.threads ?? []).filter((t) => t.block === block.id);
  const replied = threads.some((t) => t.replies.at(-1)?.by === "claude") ? '<p class="bstatus">Claude replied.</p>' : "";
  // One live region per block, there even when empty, so a screen reader hears each new status.
  const live = `<div class="blive" role="status" id="bl-${esc(block.id)}">${waiting}${replied}</div>`;
  return `${change ? changeBar(change, block, name, blockHtml) : ""}${live}${blockActions(block, name, open)}${form}${threadsHtml(threads, name)}`;
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

/**
 * What the person would otherwise lose sight of: their unsaved text for blocks that are gone (Claude
 * rewrote their section while they were open), and open comments on removed blocks, each with
 * Resolve, as on the review page.
 */
function orphansHtml() {
  const here = new Set(b.build.blocks.map((x) => x.id));
  const edits = [...b.editing].filter((id) => !here.has(id) && b.drafts[id] !== undefined);
  const threads = (b.build.threads ?? []).filter((t) => !here.has(t.block));
  const editsHtml = edits
    .map(
      (id, k) => `<div class="bblock editing orphan" data-block="${esc(id)}">
        <label class="lab" for="bt-${esc(id)}">Your unsaved text ${k + 1}, for a block that is gone</label>
        <textarea id="bt-${esc(id)}" class="btext" rows="${Math.min(20, Math.max(3, b.drafts[id].split("\n").length + 1))}">${esc(b.drafts[id])}</textarea>
        <div class="row end"><button type="button" class="btn small" data-b-cancel="${esc(id)}" aria-label="${esc(`Discard your unsaved text ${k + 1}`)}">Discard</button></div>
      </div>`,
    )
    .join("");
  return `${edits.length ? `<section class="borphans" aria-labelledby="bo-edits"><h2 id="bo-edits">Unsaved text for removed blocks</h2><p class="bnote">Copy what you need into a block, then discard it.</p>${editsHtml}</section>` : ""}${
    threads.length
      ? `<section class="borphans" aria-labelledby="bo-threads"><h2 id="bo-threads">On removed blocks</h2>${threadsHtml(threads, "a removed block")}</section>`
      : ""
  }`;
}

/** Keeps the text typed in each open editor, so a redraw doesn't lose it. */
function keepDrafts() {
  for (const box of app.querySelectorAll(".btext")) {
    const id = box.closest("[data-block]")?.dataset.block;
    if (id && b.editing.has(id)) b.drafts[id] = box.value;
  }
}

function paint() {
  keepDrafts();
  const { meta } = b.view;
  const blocks = b.build.blocks;
  document.title = `${meta.title} · hoop`;
  const who = b.view.session?.label ?? meta.owner;
  const rows = outlineHtml(0, blocks.length);
  app.innerHTML = frame(
    "",
    `<header class="top">
      <div class="title-row"><h1>${esc(meta.title)}</h1><div class="actions"><button type="button" class="btn primary" id="finishBuild" title="Turn the build into a review of the whole document" aria-describedby="finishErr">Finish and review</button><p class="berr" id="finishErr" role="alert">${esc(b.finishError)}</p></div></div>
      <div class="sub">${statusBadge("building")}${who ? `<span class="owner">with ${esc(who)}</span>` : ""}</div>
    </header>
    <main class="build">
      <p class="build-help">Build the document here with Claude. Add a title, a heading, a paragraph, a list, a table, code or a diagram with +. Edit any of them, with buttons for bold, italic, links, lists, tables and code, and move or remove them. A heading holds everything under it, up to the next heading of the same size or larger: it moves with it, and folds it. Suggest asks Claude for headings, which join the document only when you accept them. Generate asks Claude to write everything under a heading; Undo puts back what was there. Generate again asks Claude to write a block of its own again; Accept or Undo each block Claude rewrites. Blocks show as they will read; Edit opens one, and Preview shows it formatted again. Select words in a block and press Comment to ask Claude to change them, or to ask a question. Finish turns it into a review of the whole document.</p>
      <div class="build-modes"><button type="button" class="btn small" id="modeAll">${b.editing.size ? "Preview all" : "Edit all"}</button></div>
      ${b.error && !b.errorAt ? `<p class="berr" role="alert">${esc(b.error)}</p>` : ""}
      ${b.errors.length ? `<ul class="berr berrs" role="alert">${b.errors.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
      ${orphansHtml()}
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
    b.errorAt = null;
    if (body.op === "edit") closeEditor(body.block);
    b.adding = null;
    b.generating = null;
    b.regenerating = null;
    b.commenting = null;
    b.suggesting = null;
    b.retitling = null;
    b.removing = null;
  } catch (err) {
    b.error = err.message;
    b.errorAt = body.op === "edit" ? body.block : null;
  }
  b.focus = focus?.() ?? null;
  paint();
}

const sel = (attr, id) => `[${attr}="${CSS.escape(id)}"]`;

/** Puts a block back in Preview, forgetting what was typed in it. */
function closeEditor(id) {
  b.editing.delete(id);
  delete b.drafts[id];
}

/** Opens a block in Edit mode. */
function openEditor(id) {
  b.editing.add(id);
  b.focus = `#bt-${CSS.escape(id)}`;
  paint();
}

/** The text an open block's box would save: a heading's words as markdown, an unchanged heading exactly as it was. */
function boxText(block, value) {
  if (block.kind === "subtitle") return value === subtitleText(block.text) ? block.text : subtitleSource(block.text, value);
  const level = headingLevel(block);
  return level && value === headingText(block.text) ? block.text : headingSource(level, value);
}

/**
 * Edit all opens every block; Preview all saves each open block whose text changed, one after
 * another, and shows them formatted. A block whose text is refused stays open with the reason.
 */
async function switchAll() {
  if (!b.editing.size) {
    for (const x of b.build.blocks) b.editing.add(x.id);
    b.focus = "#modeAll";
    return paint();
  }
  keepDrafts();
  b.errors = [];
  // The blocks as the person opened them, to tell a changed draft from an untouched one.
  const was = new Map(b.build.blocks.map((x) => [x.id, x]));
  for (const id of [...b.editing]) {
    const block = b.build.blocks.find((x) => x.id === id);
    const draft = b.drafts[id];
    const before = was.get(id);
    // An unsaved draft is never dropped: a block that is gone keeps its text in an editor of its own.
    if (!block) {
      const changed = draft !== undefined && (!before || boxText(before, draft) !== before.text);
      if (changed) b.errors.push("A block you were editing is gone, so your text for it waits under “Unsaved text for removed blocks”.");
      else closeEditor(id);
      continue;
    }
    const text = draft === undefined ? block.text : boxText(block, draft);
    if (text === block.text) {
      closeEditor(id);
      continue;
    }
    try {
      b.build = await send({ op: "edit", block: id, text });
      closeEditor(id);
    } catch (err) {
      b.errors.push(err.message);
    }
  }
  // Claude may have changed the build meanwhile; show it as it is, with the drafts still open.
  if (b.errors.length) b.build = (await api(`/api/reviews/${b.view.meta.id}/build`).catch(() => undefined)) ?? b.build;
  b.focus = b.errors.length ? ".borphans .btext, .bblock.editing .btext" : "#modeAll";
  paint();
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t || !b.build) return;
  const d = t.dataset;
  if (!b.editing.size) b.error = "";
  if (t.id !== "finishBuild") b.finishError = "";
  if (t.id === "finishBuild") return finish();
  if (t.id === "modeAll") return switchAll();
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
      openEditor(added.id);
    }
  } else if (d.bEdit) {
    b.error = "";
    openEditor(d.bEdit);
  } else if (d.bSave) save(d.bSave);
  else if (d.bComment) {
    const same = b.commenting?.block === d.bComment;
    const pick = b.pressed ?? b.picked;
    const mine = pick?.block === d.bComment;
    b.commenting = same ? null : { block: d.bComment, selection: mine ? pick.text : "", ...(mine ? { occurrence: pick.occurrence } : {}) };
    b.commentText = "";
    b.regenerating = null;
    b.pressed = null;
    b.focus = same ? sel("data-b-comment", d.bComment) : `#bc-${CSS.escape(d.bComment)}`;
    paint();
  } else if (t.hasAttribute("data-b-comment-cancel")) closeForm();
  else if (d.bResolve) {
    const thread = (b.build.threads ?? []).find((x) => x.id === d.bResolve);
    change({ op: "resolve", thread: d.bResolve }, () => (thread ? sel("data-b-comment", thread.block) : null));
  } else if (d.bTool) format(d.bFor, d.bTool);
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
  else if (d.bCancel) cancel(d.bCancel);
  else if (d.bMove) change({ op: "move", block: d.bMove, to: d.bTo }, () => sel("data-b-edit", d.bMove));
  else if (d.bGen) {
    b.generating = b.generating === d.bGen ? null : d.bGen;
    b.focus = b.generating ? `#bn-${CSS.escape(d.bGen)}` : sel("data-b-gen", d.bGen);
    paint();
  } else if (t.hasAttribute("data-b-gen-cancel")) closeGenerate();
  else if (d.bUndo) change({ op: "undo", block: d.bUndo }, () => sel("data-b-gen", d.bUndo));
  else if (d.bRegen) {
    b.regenerating = b.regenerating === d.bRegen ? null : d.bRegen;
    b.commenting = null;
    b.focus = b.regenerating ? `#br-${CSS.escape(d.bRegen)}` : sel("data-b-regen", d.bRegen);
    paint();
  } else if (t.hasAttribute("data-b-regen-cancel")) closeForm();
  else if (d.bKeep) change({ op: "accept_change", block: d.bKeep }, () => sel("data-b-edit", d.bKeep));
  else if (d.bUnchange) {
    const c = b.build.changes.find((x) => x.blocks.includes(d.bUnchange));
    change({ op: "undo_change", block: d.bUnchange }, () => (c ? sel("data-b-edit", c.before[0].id) : null));
  } else if (d.bFold) {
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

/**
 * Turns the build into a review, then shows the review page. Everything is settled first: open edits
 * saved or cancelled, Claude's changes accepted or undone, comments resolved. A refusal shows beside
 * Finish and focus goes to the first thing it names.
 */
async function finish() {
  keepDrafts();
  const unsaved = [...b.editing].find((id) => {
    const block = b.build.blocks.find((x) => x.id === id);
    return !block || (b.drafts[id] !== undefined && boxText(block, b.drafts[id]) !== block.text);
  });
  if (unsaved) {
    b.finishError = "Save or cancel your open edits first";
    b.focus = `#bt-${CSS.escape(unsaved)}`;
    return paint();
  }
  try {
    await api(`/api/reviews/${b.view.meta.id}/finish`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    location.reload();
  } catch (err) {
    b.finishError = err.message;
    b.focus = /waiting change/.test(err.message) ? "[data-b-keep]" : /open comment/.test(err.message) ? "[data-b-resolve]" : "#finishBuild";
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

/** Closes the open Generate again or Comment form, with focus back on its button. */
function closeForm() {
  const focus = b.regenerating ? sel("data-b-regen", b.regenerating) : b.commenting ? sel("data-b-comment", b.commenting.block) : null;
  b.regenerating = null;
  b.commenting = null;
  b.focus = focus;
  paint();
}

/** The words selected in one block in Preview, with the block, or null. */
function selected() {
  const s = document.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  // Only the block's own text counts, not its tools, status or threads.
  const at = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest(".bblock:not(.editing) .bbody > :first-child");
  const start = at(s.anchorNode);
  if (!start || start !== at(s.focusNode)) return null;
  const norm = (x) => x.replace(/\s+/g, " ");
  const text = norm(s.toString()).trim();
  if (!text) return null;
  // Which occurrence of the words this is, so Claude can tell repeated words apart.
  const before = document.createRange();
  before.setStart(start, 0);
  before.setEnd(s.getRangeAt(0).startContainer, s.getRangeAt(0).startOffset);
  const upTo = norm(before.toString()).length;
  const all = norm(start.textContent);
  let occurrence = 0;
  for (let k = all.indexOf(text); k >= 0 && k < upTo; k = all.indexOf(text, k + 1)) occurrence++;
  return { block: start.closest("[data-block]").dataset.block, text, occurrence };
}

// The words selected in a block, for a comment on them. Pressing Comment can clear the selection
// before its click, so the press keeps what was selected as it began.
document.addEventListener("selectionchange", () => {
  b.picked = selected();
});
document.addEventListener("pointerdown", (e) => {
  if (e.target.closest?.("[data-b-comment]")) b.pressed = selected() ?? b.picked;
});

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
  const again = e.target.closest?.("[data-b-regen-form]");
  if (again) {
    e.preventDefault();
    const block = again.dataset.bRegenForm;
    const note = again.querySelector("input[name=note]").value.trim();
    const all = again.querySelector("input[name=all]")?.checked;
    const target = all ? again.dataset.heading : block;
    // Everything under the heading is Generate on the heading; else Claude writes this block again.
    change({ op: all ? "generate" : "rewrite", block: target, ...(note ? { note } : {}) }, () => sel(all ? "data-b-gen" : "data-b-regen", target));
    return;
  }
  const said = e.target.closest?.("[data-b-comment-form]");
  if (said) {
    e.preventDefault();
    const block = said.dataset.bCommentForm;
    const comment = said.querySelector("textarea").value;
    const { selection, occurrence } = b.commenting ?? {};
    // A refused comment keeps its text, with the reason beside the form.
    b.commentText = comment;
    change({ op: "comment", block, comment, ...(selection ? { selection, ...(occurrence !== undefined ? { occurrence } : {}) } : {}) }, () => {
      if (b.error) b.errorAt = `comment:${block}`;
      else b.commentText = "";
      return b.commenting ? `#bc-${CSS.escape(block)}` : sel("data-b-comment", block);
    });
    return;
  }
  const form = e.target.closest?.("[data-b-gen-form]");
  if (!form) return;
  e.preventDefault();
  const block = form.dataset.bGenForm;
  const note = form.querySelector("input").value.trim();
  change({ op: "generate", block, ...(note ? { note } : {}) }, () => sel("data-b-gen", block));
});

/** Preview on an open block: saves its text when it changed, and shows it formatted. */
function save(id) {
  const box = document.getElementById(`bt-${id}`);
  const block = b.build.blocks.find((x) => x.id === id);
  if (!block || !box) return;
  // An unchanged heading keeps its text exactly, closing #s and spacing included.
  const text = boxText(block, box.value);
  if (text === block.text) return cancel(id);
  change({ op: "edit", block: id, text }, () => (b.editing.has(id) ? `#bt-${CSS.escape(id)}` : sel("data-b-edit", id)));
}

/** Applies a formatting button to the block's text box, keeping focus there with the new selection. */
function format(id, tool) {
  const box = document.getElementById(`bt-${id}`);
  if (!box) return;
  const kind = b.build.blocks.find((x) => x.id === id)?.kind;
  const next = applyTool(tool, box.value, box.selectionStart, box.selectionEnd, { inline: kind === "table" });
  box.value = next.text;
  box.focus();
  box.setSelectionRange(next.start, next.end);
  box.rows = Math.min(20, Math.max(box.rows, next.text.split("\n").length + 1));
}

/** Leaves Edit mode on a block without saving. */
function cancel(id) {
  if (!id) return;
  closeEditor(id);
  b.error = "";
  b.errorAt = null;
  b.focus = sel("data-b-edit", id);
  paint();
}

document.addEventListener("keydown", (e) => {
  if (!b.build) return;
  const box = e.target.closest?.(".bblock.editing");
  const editing = box?.dataset.block;
  if (editing) {
    // Escape never throws away text for a block that is gone; only Discard does.
    if (e.key === "Escape" && !box.classList.contains("orphan")) {
      e.preventDefault();
      cancel(editing);
    } else if (e.target.classList.contains("btext") && e.key === "Enter" && (e.metaKey || e.ctrlKey || e.target.tagName === "INPUT")) {
      e.preventDefault();
      save(editing);
    } else if (modKey(e) && e.target.classList.contains("btext")) {
      // Mod+B, Mod+I and Mod+K press Bold, Italic and Link, when the block has them.
      const tool = TOOLS.find(([, , key]) => key && key === e.key.toLowerCase())?.[0];
      const id = e.target.closest("[data-block]").dataset.block;
      if (tool && app.querySelector(`[data-b-tool="${tool}"][data-b-for="${CSS.escape(id)}"]`)) {
        e.preventDefault();
        format(id, tool);
      }
    }
  } else if (e.target.classList?.contains("bprop-in") && (e.key === "Enter" || e.key === "Escape")) {
    e.preventDefault();
    if (e.key === "Enter") retitle(b.retitling);
    else closeRetitle();
  } else if (e.key === "Escape" && (b.regenerating !== null || b.commenting !== null)) {
    e.preventDefault();
    closeForm();
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
  const busy = () => b.editing.size || b.generating || b.regenerating || b.commenting || b.suggesting || b.retitling || b.removing;
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
