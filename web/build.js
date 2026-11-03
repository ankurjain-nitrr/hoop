// The build page: a document the person and Claude build together, one block at a time. The person
// adds blocks with +, edits any block in place with a formatting toolbar, and moves or removes it. The
// page speaks in plain words: a `##` heading is "Heading 1", a `###` one "Heading 2", and no markdown
// shows outside a block's editor. The document reads as an outline: everything under a heading sits
// inside it, indented, and folds; a heading moves and can be removed with everything under it. The page asks for the build again every few seconds while visible, so
// Claude's changes show without a reload.
import { esc } from "/esc.js";
import { announce, frame } from "/frame.js";
import { api, post } from "/api.js";
import { statusBadge } from "/status.js";
import { readAt, span } from "/activity.js";
import { plainText, PROSE, renderLine, renderTableRow, titleHtml } from "/inline.js";
import { headingLevel, ITEM, JOIN, parentOf, QUOTE, rowCells, SUBTITLE, swapRange, TABLE_DELIM, unitRange } from "/blocks.js";
import { diagramHtml, mountDiagrams } from "/diagram.js";
import { icons } from "/icons.js";
import { applyTool, headingSource, TABLE_TOOLS, TOOLS } from "/format.js";
import { blockActions, changeBar, commentForm, regenForm, requestLine, threadsHtml } from "/revise.js";
import { contextPanel, sourcesHtml } from "/context.js";
import { draftHtml, finishConfirm, refineButtons } from "/build-drafts.js";
import { notesHtml, pickedVersion, versionLabel, versionsButton, versionsPanel } from "/build-history.js";
import { longHint, MAC, MOD, sendKey } from "/send.js";

const app = document.getElementById("app");

/** The kinds of block + adds, in menu order, with the name people read. */
const KINDS = [
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
 * or Remove choice is open, the words last selected in a block, the link or path typed to add as
 * context, whether the brief is open, which section's versions are open and the version picked
 * there, the block a note's link jumped to, and which sections are folded (for as long as the page is open).
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
  // Where a refused change's error shows: a block's ID while it is open, "undo-remove" or
  // "undo-dismiss" under that Undo, "comment:<block>" in a Comment form, or "at:<selector>" under the
  // control that sent it (`origin`, the button pressed or the form sent last).
  errorAt: null,
  origin: null,
  errors: [],
  finishError: "",
  commentText: "",
  suggesting: null,
  retitling: null,
  removing: null,
  // The suggested heading the person just dismissed, `{ id, title, anchor }`, which Undo puts back.
  dismissed: null,
  error: "",
  focus: null,
  ctxText: "",
  ctxError: "",
  briefing: false,
  briefError: "",
  confirmFinish: false,
  versions: null,
  jumped: null,
};
const folded = new Set();

/** Whether Claude can write under a block: a heading below the title. */
const isSection = (block) => block.kind === "h2" || block.kind === "h3";

/** What each request kind asks Claude for, as its queued and taken lines say it. */
const ASKED = {
  write: ["writes everything under this heading", "is writing everything under this heading"],
  continue: ["adds to the text under this heading", "is adding to the text under this heading"],
  outline: ["suggests an outline", "is suggesting an outline"],
  next: ["suggests the next heading", "is suggesting the next heading"],
  subsections: ["suggests subheadings", "is suggesting subheadings"],
};

/** The button each request kind came from, as its Withdraw names it: "Withdraw Generate on Heading 1 “Costs”". */
const ASKED_BY = {
  write: "Generate on",
  continue: "Continue writing on",
  outline: "Suggest an outline for",
  next: "Suggest the next heading for",
  subsections: "Suggest subheadings for",
};

/** Whether the heading at `i` has nothing under it, not even a subheading. */
const emptyAt = (blocks, i) => unitRange(blocks, i)[1] === i + 1;

/**
 * What a heading asks Claude for besides Generate, with the button text people read: Continue
 * writing on a section with text, an outline under a title, subheadings, the next heading after the
 * last of its siblings.
 */
function suggestionsFor(block, i) {
  const level = headingLevel(block);
  if (level === 1) return [["outline", "Suggest an outline"]];
  if (level < 2) return [];
  // Continue writing adds to text that is there, and not while Claude's draft would replace it.
  const out = emptyAt(b.build.blocks, i) || draftOn(block)?.kind === "write" ? [] : [["continue", "Continue writing"]];
  if (level < 6) out.push(["subsections", "Suggest subheadings"]);
  if (!swapRange(b.build.blocks, i, "down")) out.push(["next", "Suggest the next heading"]);
  return out;
}

/** Whether a request still waits on Claude: queued, or taken and not answered. */
const isOpen = (r) => r.status === "queued" || r.status === "taken";

/** Claude's draft waiting on a heading, if any. */
const draftOn = (block) => (b.build.drafts ?? []).find((d) => d.section === block.id);

/** The headings Generate all writes: each section with nothing under it, no request open and no draft waiting. */
function emptySections() {
  const blocks = b.build.blocks;
  return blocks.filter((x, i) => isSection(x) && emptyAt(blocks, i) && !draftOn(x) && !(b.build.requests ?? []).some((r) => r.block === x.id && isOpen(r)));
}

/** The open request of `kind` (undefined for Generate) on a heading, which holds its button pending until Claude answers or the person withdraws it. */
const pendingOn = (block, kind) => (b.build.requests ?? []).find((r) => r.block === block.id && r.kind === kind && isOpen(r));

/**
 * How long a request has waited, and whether Claude's session is listening: waiting on the build now,
 * or when it last checked. A request Claude took but didn't answer in time says it is queued again.
 */
function waitText(r, now = Date.now()) {
  const asked = span(now - Date.parse(r.at));
  if (r.status === "taken") return `Asked ${asked} ago · Claude took it ${span(now - Date.parse(r.taken_at))} ago`;
  const c = b.build.claude ?? {};
  let listening = "Claude's session hasn't checked the build yet";
  if (c.listening) listening = "Claude's session is checking the build";
  else if (c.checked) listening = `Claude's session hasn't checked the build since ${readAt(c.checked)}`;
  return `${r.retried ? "Claude didn't answer in time, so it's queued again · " : ""}Queued ${asked} ago · ${listening}`;
}

/** The line under a request saying how long it has waited, outside the live region, so its ticking clock isn't read out. */
const waitLine = (r) => `<p class="bwait" data-b-wait="${esc(r.id)}">${esc(waitText(r))}</p>`;

/** Updates each request's waiting line in place, between redraws. */
function tick() {
  for (const p of app.querySelectorAll("[data-b-wait]")) {
    const r = (b.build.requests ?? []).find((x) => x.id === p.dataset.bWait);
    if (r) p.textContent = waitText(r);
  }
}

/**
 * What a heading waits for: each open request, queued (muted) or being worked on by Claude (live),
 * how long it has waited, and Withdraw.
 */
function sectionStatus(block, name) {
  return (b.build.requests ?? [])
    .filter((x) => x.block === block.id && isOpen(x))
    .map((r) => {
      const [queued, taken] = ASKED[r.kind ?? "write"];
      const text = r.status === "taken" ? `Claude ${taken}…` : `Queued: Claude ${queued}.`;
      const withdraw = `<button type="button" class="btn small" data-b-withdraw="${esc(r.id)}" data-b-on="${esc(block.id)}" data-kind="${r.kind ?? "write"}" aria-label="${esc(`Withdraw ${ASKED_BY[r.kind ?? "write"]} ${name}`)}">Withdraw</button>`;
      return `<div class="bpending"><p class="bstatus ${r.status}" role="status">${icons.clock}<span>${esc(text)}</span>${r.note ? ` <span class="bnote">Note: ${esc(r.note)}</span>` : ""}</p><div class="bwait-row">${waitLine(r)}${withdraw}</div></div>`;
    })
    .join("");
}

/** A heading's button for a request that is pending (`r`): it can't be pressed until Claude answers or the person withdraws it. */
const pendingButton = (r, label, name) =>
  `<button type="button" class="btn small icon-label bpend-btn ${r.status}" disabled aria-label="${esc(`${label} ${name}: pending`)}">${icons.clock}<span>Pending</span></button>`;

/** The form a Suggest button opens: optional notes for Claude, a larger box for an outline. */
function suggestForm(block, kind, label) {
  const id = esc(block.id);
  const field =
    kind === "outline"
      ? `<textarea id="bs-note-${id}" class="bnote-in" name="note" rows="3" maxlength="2000" data-send="long" aria-describedby="bs-hint-${id}" placeholder="Purpose, key points, links"></textarea>${longHint(`bs-hint-${id}`, "sends")}`
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
  const where = headingWords(anchor.text);
  return groups
    .map((request) => {
      const list = props.filter((p) => p.request === request);
      const rows = list
        .map((p) => {
          const name = `suggested heading “${plainText(p.title)}”`;
          const pid = esc(p.id);
          if (b.retitling === p.id)
            return `<div class="bprop editing bprop-d${Math.min(4, p.level - base)}" data-proposal="${pid}">
              <label class="lab" for="bp-${pid}">Title of the ${esc(name)}</label>
              <input id="bp-${pid}" class="bnote-in bprop-in" value="${esc(p.title)}" maxlength="200" autocomplete="off">
              <div class="row end"><div><button type="button" class="btn small" data-b-retitle-cancel>Cancel</button><button type="button" class="btn small primary" data-b-retitle-save="${pid}">Save</button></div></div>
            </div>`;
          return `<div class="bprop bprop-d${Math.min(4, p.level - base)}" data-proposal="${pid}">
            <div class="bprop-text"><span class="bprop-h"><span class="bprop-k">${headingName(p.level)}</span> <span class="fmt">${titleHtml(p.title)}</span></span>${p.note ? `<span class="bprop-note">${esc(p.note)}</span>` : ""}</div>
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

/** The Generate form under a heading: an optional note for Claude, and the one-press refinements once it has text or a draft. */
function generateForm(block, name, again) {
  const id = esc(block.id);
  return `<form class="bgen" data-b-gen-form="${id}">
    <label class="lab" for="bn-${id}">Note for Claude on ${esc(name)} (optional)</label>
    <input id="bn-${id}" class="bnote-in" name="note" maxlength="500" autocomplete="off" placeholder="For example: focus on cloud spend">
    ${again ? refineButtons(block.id, name, "gen") : ""}
    <div class="row end"><div><button type="button" class="btn small" data-b-gen-cancel>Cancel</button><button type="submit" class="btn small primary">Generate</button></div></div>
  </form>`;
}

/** Whether a heading's Generate form offers the refinements: it has text, Claude wrote under it, or Claude's draft waits on it. */
function refinable(block) {
  const i = b.build.blocks.indexOf(block);
  return (b.build.undo ?? []).includes(block.id) || !emptyAt(b.build.blocks, i) || Boolean(draftOn(block));
}

const send = (body) => post(`/api/reviews/${b.view.meta.id}/build`, body);

const headingText = (text) =>
  text
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/\s+#+\s*$/, "")
    .trim();

/** A heading's words as a control's label names them: plain text, without markdown markers. */
const headingWords = (text) => plainText(headingText(text));

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
  const other = had === "_" ? "*" : "_";
  const mark = text.includes(had) ? other : had;
  return text ? `${mark}${text}${mark}` : "";
};

/** A block as people name it in a control's label: a heading's text, else its kind and place. */
function blockName(block, i) {
  const level = headingLevel(block);
  if (level) return `${headingName(level)} “${headingWords(block.text)}”`;
  return `${KIND_NAME[block.kind] ?? "Block"} ${i + 1}`;
}

/** A table cell's style from its column's delimiter cell: `:-:` centres it, `-:` aligns it right. */
function alignStyle(a) {
  if (a.startsWith(":") && a.endsWith(":")) return ' style="text-align:center"';
  return a.endsWith(":") ? ' style="text-align:right"' : "";
}

/** A table block as a table: the first row is the header, the delimiter row sets each column's alignment. */
function tableHtml(text) {
  const rows = text.split("\n");
  const delim = rows.findIndex((r) => TABLE_DELIM.test(r));
  const align = delim < 0 ? [] : rowCells(rows[delim]).map((c) => c.text);
  const style = (k) => alignStyle(align[k] ?? "");
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

/** A list item's continuation line: indented under the item, so a `>` there stays in the item. */
const UNDER_ITEM = /^\s{2,}\S/;

/**
 * A prose, list or table block's runs of lines as the review page reads them: each `>` line is a
 * quote of its own, and the lines after a quote start a new list, or else a paragraph. A `>` line
 * indented under a list item stays in the item.
 */
function runsOf(kind, lines) {
  const runs = [];
  let run = null;
  for (const line of lines) {
    if (QUOTE.test(line) && !(run?.kind === "list" && UNDER_ITEM.test(line))) {
      runs.push({ kind: "quote", lines: [line] });
      run = null;
    } else if (run) run.lines.push(line);
    else {
      const after = ITEM.test(line) ? "list" : "paragraph";
      run = { kind: runs.length ? after : kind, lines: [line] };
      runs.push(run);
    }
  }
  return runs;
}

/** Each run's HTML by its kind; a run of any other kind reads as a paragraph. */
const RUN_HTML = {
  quote: (lines) => `<p class="bquote-line">${renderLine(lines[0], [], { kind: "quote", indent: 0 })}</p>`,
  table: (lines) => tableHtml(lines.join("\n")),
  list: (lines) =>
    `<div class="blist">${listItems(lines.join("\n"))
      .map((item) => `<div class="bline">${renderLine(item, [], { kind: "list", indent: item.match(/^\s*/)[0].length })}</div>`)
      .join("")}</div>`,
  paragraph: (lines) => `<p class="bpara">${renderLine(lines.join(JOIN), [], PROSE)}</p>`,
};

/**
 * A prose, list or table block as it reads, with its quote lines as quotes. Several runs share one
 * wrapper, so a selection still sits in the block's own text.
 */
function flowHtml(block) {
  const runs = runsOf(block.kind, block.text.split("\n"));
  const html = runs.map((r) => (Object.hasOwn(RUN_HTML, r.kind) ? RUN_HTML[r.kind] : RUN_HTML.paragraph)(r.lines)).join("");
  return runs.length === 1 ? html : `<div class="bflow">${html}</div>`;
}

/** A block as it reads: headings, prose, lists, tables, code and diagrams. */
function blockHtml(block) {
  const t = block.text;
  if (block.kind === "h1" || block.kind === "h2" || block.kind === "h3") {
    // The page's own title is the h1, so the document's headings sit one level below it.
    const tag = { h1: "h2", h2: "h3", h3: "h4" }[block.kind];
    return `<${tag} class="bh bh-${block.kind}">${renderLine(headingText(t), [], PROSE)}</${tag}>`;
  }
  if (block.kind === "subtitle") return `<p class="bsub">${renderLine(subtitleText(t), [], PROSE)}</p>`;
  if (block.kind === "diagram") return diagramHtml(t.split("\n").join(JOIN));
  if (block.kind === "code") {
    const lines = t.split("\n");
    const inner = lines.slice(1, lines.length > 1 && /^\s{0,3}(```|~~~)/.test(lines.at(-1)) ? -1 : undefined);
    return `<pre class="bcode"><code>${esc(inner.join("\n"))}</code></pre>`;
  }
  return flowHtml(block);
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

/**
 * Whether a key press is the formatting shortcut's modifier alone: ⌘ on a Mac, where Ctrl+B and
 * Ctrl+K are text bindings of their own, else Ctrl; never while an input method is composing.
 */
const modKey = (e) => !e.isComposing && !e.altKey && !e.shiftKey && (MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/** The formatting buttons above a block's text box, each named for the block it formats; a table's cells take only inline ones. */
function toolbarHtml(id, name, kind) {
  const buttons = TOOLS.filter(([tool]) => kind !== "table" || TABLE_TOOLS.includes(tool))
    .map(([tool, label, key]) => {
      const keys = key ? ` aria-keyshortcuts="${MAC ? "Meta" : "Control"}+${key.toUpperCase()}"` : "";
      const title = key ? `${label} (${MOD}+${key.toUpperCase()})` : label;
      return `<button type="button" class="btn small bfmt bfmt-${tool}" data-b-tool="${tool}" data-b-for="${esc(id)}" aria-label="${esc(`${label} in ${name}`)}" title="${esc(title)}"${keys}>${esc(label)}</button>`;
    })
    .join("");
  return `<div class="bfmts" role="group" aria-label="${esc(`Formatting for ${name}`)}">${buttons}</div>`;
}

/** Who wrote a block, beside its tools: Generated, Claude, or nothing for the person. */
function byHtml(block) {
  if (block.generated) return '<span class="by gen">Generated</span>';
  return block.by === "claude" ? '<span class="by">Claude</span>' : "";
}

/** The words a block's box opens with: a heading's or subtitle's words, else its markdown. */
function editorText(block, level) {
  if (level) return headingText(block.text);
  return block.kind === "subtitle" ? subtitleText(block.text) : block.text;
}

/** An open block's text box: one line for a heading or subtitle, else a text area, monospaced for code and diagrams. */
function editorBox(block, text, prose) {
  const id = esc(block.id);
  const level = headingLevel(block);
  if (level)
    return `<input id="bt-${id}" class="btext bhead-in" data-level="${level}" value="${esc(text)}" maxlength="300" autocomplete="off" aria-describedby="be-${id}">`;
  if (block.kind === "subtitle")
    return `<input id="bt-${id}" class="btext bsub-in" value="${esc(text)}" maxlength="300" autocomplete="off" aria-describedby="be-${id}">`;
  const rows = Math.min(20, Math.max(3, text.split("\n").length + 1));
  return `<textarea id="bt-${id}" class="btext${prose ? "" : " mono"}" rows="${rows}" aria-describedby="bh-${id} be-${id}">${esc(text)}</textarea>${longHint(`bh-${id}`, "previews")}`;
}

/** A block in Edit mode: its text in a box, with the formatting buttons when it is prose. */
function editorRow(block, name) {
  const id = esc(block.id);
  const level = headingLevel(block);
  const text = b.drafts[block.id] ?? editorText(block, level);
  const prose = !level && !["subtitle", "code", "diagram"].includes(block.kind);
  return `<div class="bblock editing" data-block="${id}">
      <label class="lab" for="bt-${id}">Text of ${esc(name)}</label>
      ${prose ? toolbarHtml(block.id, name, block.kind) : ""}${editorBox(block, text, prose)}
      <p id="be-${id}" class="berr" role="alert">${b.errorAt === block.id ? esc(b.error) : ""}</p>
      <div class="row end"><div><button type="button" class="btn small" data-b-cancel="${id}" aria-label="${esc(`Cancel editing ${name}`)}">Cancel</button><button type="button" class="btn small primary" data-b-save="${id}" aria-label="${esc(`Preview ${name}`)}" title="Save and show it formatted">Preview</button></div></div>
    </div>`;
}

/** One of a block's icon tools. */
const toolButton = (attr, icon, label, disabled = false) =>
  `<button type="button" class="btn small btool" ${attr} aria-label="${esc(label)}" title="${esc(label)}"${disabled ? " disabled" : ""}>${icons[icon]}</button>`;

/** Generate on a section's heading (Generate again once Claude has written it or its draft waits), and Undo once the person saved Claude's text. */
function sectionTools(block, name) {
  if (!isSection(block)) return "";
  const written = (b.build.undo ?? []).includes(block.id);
  const gen = written || draftOn(block) ? "Generate again" : "Generate";
  const pending = pendingOn(block);
  const button = pending
    ? pendingButton(pending, gen, name)
    : `<button type="button" class="btn small icon-label" data-b-gen="${esc(block.id)}" aria-label="${esc(`${gen} ${name}`)}">${icons.spark}<span>${gen}</span></button>`;
  return `${button}${written ? toolButton(`data-b-undo="${esc(block.id)}"`, "undo", `Undo Claude's text in ${name}`) : ""}`;
}

/** Generate all on the title, while some section has nothing under it and nothing waiting on it. */
function generateAllButton(block) {
  const n = emptySections().length;
  if (headingLevel(block) !== 1 || !n) return "";
  const label = `Generate all: write ${n} empty ${n === 1 ? "heading" : "headings"}`;
  return `<button type="button" class="btn small icon-label" data-b-gen-all="${esc(block.id)}" aria-label="${esc(label)}" title="${esc(label)}">${icons.spark}<span>Generate all</span></button>`;
}

/** Claude's draft waiting on a heading, with the documents it drew it from. */
function draftPanel(block, name, inBody) {
  const d = draftOn(block);
  // A draft that adds to the heading's text shows where saving puts it, in the open section's body;
  // one that replaces the section, or one in a folded section, shows under the heading.
  if (!d || (d.kind === "continue" && !folded.has(block.id)) !== inBody) return "";
  // The draft's blocks follow the heading, so the sources line reads them as its text.
  return draftHtml(d, block, name, blockHtml, sourcesHtml([block, ...d.blocks], 0, headingLevel));
}

/** What sits under a heading in Preview: where its section stands, Claude's draft, the Generate note, and Suggest, Continue writing and Generate all with the open form. */
function headingExtras(block, i, name) {
  const asks = suggestionsFor(block, i);
  const asking = (kind) => b.suggesting?.block === block.id && b.suggesting.kind === kind;
  const button = ([kind, label]) => {
    const pending = pendingOn(block, kind);
    return pending
      ? pendingButton(pending, label, `for ${name}`)
      : `<button type="button" class="btn small icon-label" data-b-suggest="${esc(block.id)}" data-kind="${kind}" aria-expanded="${asking(kind)}" aria-label="${esc(`${label} for ${name}`)}">${icons.spark}<span>${esc(label)}</span></button>`;
  };
  const all = generateAllButton(block);
  const suggest = asks.length || all ? `<div class="bsuggest">${all}${asks.map(button).join("")}</div>` : "";
  const open = asks.find(([kind]) => asking(kind) && !pendingOn(block, kind));
  const gen = b.generating === block.id && !pendingOn(block) ? generateForm(block, name, refinable(block)) : "";
  return `${sourcesHtml(b.build.blocks, i, headingLevel)}${notesHtml(b.build.notes ?? [], block, name, placeOf)}${sectionStatus(block, name)}${draftPanel(block, name, false)}${gen}${suggest}${open ? suggestForm(block, open[0], open[1]) : ""}${versionsHtml(block, i, name)}`;
}

/** A section's versions: the disclosure with their count, and the list with what changed since the one picked while it is open. */
function versionsHtml(block, i, name) {
  const history = isSection(block) ? b.build.history?.[block.id] : undefined;
  const open = b.versions?.section === block.id && Boolean(history?.versions.length);
  const current = b.build.blocks.slice(i + 1, unitRange(b.build.blocks, i)[1]);
  return `${versionsButton(block, name, history, open)}${open ? versionsPanel(block, name, history, current, b.versions, blockHtml) : ""}`;
}

/** A block as a note names it: its kind and place with the heading it is under, or, in a draft, the draft and its heading. */
function placeOf(id) {
  const blocks = b.build.blocks;
  const i = blocks.findIndex((x) => x.id === id);
  if (i < 0) {
    const d = (b.build.drafts ?? []).find((x) => x.blocks.some((y) => y.id === id));
    const h = d && blocks.findIndex((x) => x.id === d.section);
    return h >= 0 ? `Claude's draft for ${blockName(blocks[h], h)}` : "a block that is gone";
  }
  const p = parentOf(blocks, i);
  return `${blockName(blocks[i], i)}${p >= 0 ? ` under “${headingWords(blocks[p].text)}”` : ""}`;
}

/** One block: as it reads with its tools, or its text in a box, with the formatting buttons, while it is being edited. */
function blockRow(block, i) {
  const blocks = b.build.blocks;
  const name = blockName(block, i);
  if (b.editing.has(block.id)) return editorRow(block, name);
  const removeTool = `<button type="button" class="btn small btool" data-b-remove="${esc(block.id)}" aria-label="${esc(`Remove ${name}`)}" title="${esc(`Remove ${name}`)}"${asksToRemove(blocks, i) ? ` aria-expanded="${b.removing === block.id}"` : ""}>${icons.trash}</button>`;
  const by = byHtml(block);
  const section = sectionTools(block, name);
  const extra = headingLevel(block) ? headingExtras(block, i, name) : blockExtras(block, i, name);
  const changed = (b.build.changes ?? []).some((c) => c.blocks.includes(block.id));
  // The block a note's link jumped to takes focus, and shows it.
  const jumped = b.jumped === block.id;
  return `<div class="bblock kind-${block.kind}${block.generated ? " generated" : ""}${changed ? " changed" : ""}${jumped ? " jumped" : ""}" id="bk-${esc(block.id)}"${jumped ? ' tabindex="-1"' : ""} data-block="${esc(block.id)}">
    <div class="bbody">${blockHtml(block)}${extra}</div>
    <div class="btools">${by}${section}${toolButton(`data-b-edit="${esc(block.id)}"`, "edit", `Edit ${name}`)}${toolButton(`data-b-move="${esc(block.id)}" data-b-to="up"`, "up", `Move ${name} up`, !swapRange(blocks, i, "up"))}${toolButton(`data-b-move="${esc(block.id)}" data-b-to="down"`, "down", `Move ${name} down`, !swapRange(blocks, i, "down"))}${removeTool}</div>
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
  const parent = p >= 0 && isSection(blocks[p]) ? { id: blocks[p].id, title: headingWords(blocks[p].text) } : undefined;
  const requests = (b.build.requests ?? []).filter((r) => r.block === block.id && isOpen(r));
  const waiting = requests.map(requestLine).join("");
  const waits = requests.map(waitLine).join("");
  const open = openForm(block);
  const form = formHtml(open, block, name, parent);
  const threads = (b.build.threads ?? []).filter((t) => t.block === block.id);
  const replied = threads.some((t) => t.replies.at(-1)?.by === "claude") ? '<p class="bstatus">Claude replied.</p>' : "";
  // One live region per block, there even when empty, so a screen reader hears each new status.
  const live = `<div class="blive" role="status" id="bl-${esc(block.id)}">${waiting}${replied}</div>`;
  return `${notesHtml(b.build.notes ?? [], block, name, placeOf)}${change ? changeBar(change, block, name, blockHtml) : ""}${live}${waits}${blockActions(block, name, open)}${form}${threadsHtml(threads, name)}`;
}

/** Which form is open under a block: "regen" for Generate again, "comment" for Comment, else "". */
function openForm(block) {
  if (b.regenerating === block.id) return "regen";
  return b.commenting?.block === block.id ? "comment" : "";
}

/** The open form under a block, if any. */
function formHtml(open, block, name, parent) {
  if (open === "regen") return regenForm(block, name, parent);
  if (open !== "comment") return "";
  return commentForm(block, name, b.commenting.selection, b.commentText, b.errorAt === `comment:${block.id}` ? b.error : "");
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
 * Where the Undo line after a removal shows: after the block the removed blocks followed (`end`:
 * after that heading's whole section), where Undo puts them back: after the block before them, else
 * before the block after them, or at the top (`id` null). A removed heading's line sits at its own level, beside the section it
 * followed, and a folded section shows it after the section, never hidden inside it.
 */
function removedSpot(r) {
  const blocks = b.build.blocks;
  const at = (id) => blocks.findIndex((x) => x.id === id);
  // Where Undo puts the blocks back: after the block before them, else before the block after them.
  let i = r.after === null ? -1 : at(r.after);
  if (r.after !== null && i < 0) i = (r.before === null ? blocks.length : at(r.before)) - 1;
  if (i < 0) return { id: null, end: false };
  let spot = { id: blocks[i].id, end: false };
  for (let p = i; p >= 0; p = parentOf(blocks, p)) {
    const level = headingLevel(blocks[p]);
    const hidden = p !== i && folded.has(blocks[p].id);
    if (level && (hidden || (r.level && level >= r.level))) spot = { id: blocks[p].id, end: true };
  }
  return spot;
}

/**
 * An Undo line: what happened, Undo with its name, described by its error line, which follows it.
 * `key` names the error line's ID; `cls` adds a class to the line (`in`, to sit with Claude's
 * suggestions inside a section).
 */
const undoLine = (said, attr, label, error, key, cls = "") =>
  `<p class="undo-line${cls ? ` ${cls}` : ""}">${said}<button type="button" class="btn small" ${attr} aria-label="${esc(label)}" aria-describedby="${key}-err">Undo</button></p><p class="berr${cls ? ` ${cls}` : ""}" id="${key}-err" role="alert">${esc(error)}</p>`;

/**
 * Right after a removal, at `removedSpot`, here when `id` and `end` name it: what went, and Undo,
 * which puts it back. It goes with the person's next change.
 */
/** A removal's words as the page says them, the heading they name in curly quotes: formatted as HTML, or plain. */
function removedWords(what, html = false) {
  return what
    .split(/"([^"]*)"/)
    .map((part, k) => {
      if (k % 2) return `“${html ? titleHtml(part) : plainText(part)}”`;
      return html ? esc(part) : part;
    })
    .join("");
}

function removedHtml(id, end = false) {
  const r = b.build.removed;
  if (!r) return "";
  const spot = removedSpot(r);
  if (spot.id !== id || spot.end !== end) return "";
  return undoLine(
    `Removed <span class="fmt">${removedWords(r.what, true)}</span>.`,
    "data-b-undo-remove",
    `Undo: put back ${removedWords(r.what)}`,
    b.errorAt === "undo-remove" ? b.error : "",
    "undo-remove",
  );
}

/**
 * Right after a suggested heading under `anchor` was dismissed, where Claude's suggestions for it
 * were (`inside` the section for an outline or subsections, after it for the next heading): which,
 * and Undo, which puts it back.
 */
function dismissedHtml(anchor, inside) {
  const d = b.dismissed;
  if (!d || d.anchor !== anchor.id || d.inside !== inside) return "";
  const error = b.errorAt === "undo-dismiss" ? b.error : "";
  return undoLine(
    `Dismissed the suggested heading “<span class="fmt">${titleHtml(d.title)}</span>”.`,
    `data-b-undo-dismiss="${esc(d.id)}"`,
    `Undo: put back the suggested heading “${plainText(d.title)}”`,
    error,
    "undo-dismiss",
    inside ? "in" : "",
  );
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
      html += blockRow(block, i) + removedHtml(block.id) + adderHtml(block.id, name);
      i++;
      continue;
    }
    const end = unitRange(blocks, i)[1];
    html += sectionHtml(block, i, end, name);
    i = end;
  }
  return html;
}

/** A heading at `i` with its section, blocks `i + 1` to `end`, in a fold under it. */
function sectionHtml(block, i, end, name) {
  const open = !folded.has(block.id);
  const body = `bs-${esc(block.id)}`;
  const toggle = `<button type="button" class="btn small bfold" data-b-fold="${esc(block.id)}" aria-expanded="${open}" aria-controls="${body}" aria-label="${esc(`${open ? "Collapse" : "Expand"} ${name}`)}" title="${open ? "Collapse" : "Expand"}">${open ? icons.collapse : icons.expand}</button>`;
  const count = end - i - 1;
  const summary = open || !count ? "" : `<p class="bfolded">${count} ${count === 1 ? "block" : "blocks"} folded</p>`;
  // The heading's own text ends at its first subheading.
  let own = i + 1;
  while (own < end && !headingLevel(b.build.blocks[own])) own++;
  return `<div class="bsec bsec-${headingLevel(block)}" data-section="${esc(block.id)}">
      <div class="bsec-head">${toggle}${blockRow(block, i)}</div>${removedHtml(block.id)}${summary}
      <div class="bsec-body" id="${body}"${open ? "" : " hidden"}>${adderHtml(block.id, name)}${outlineHtml(i + 1, own)}${draftPanel(block, name, true)}${outlineHtml(own, end)}</div>${proposalsHtml(block, true)}${dismissedHtml(block, true)}
    </div>${removedHtml(block.id, true)}${proposalsHtml(block, false)}${dismissedHtml(block, false)}`;
}

/** Who made a change in the history: Claude, You, or the person by name. */
function whoDid(by) {
  if (by === "claude") return "Claude";
  return by === "person" ? "You" : by;
}

/** The build's changes, newest first. */
function historyHtml(steps) {
  if (!steps.length) return "";
  const rows = [...steps]
    .reverse()
    .map((s) => `<li><span class="who">${esc(whoDid(s.by))}</span> ${esc(s.what)} <span class="m">${esc(readAt(s.at))}</span></li>`)
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
  document.title = `${plainText(meta.title)} · hoop`;
  const who = b.view.session?.label ?? meta.owner;
  const rows = removedHtml(null) + outlineHtml(0, blocks.length);
  app.innerHTML = frame(
    "",
    `<header class="top">
      <div class="title-row"><h1 class="fmt">${renderLine(meta.title, [], PROSE)}</h1><div class="actions"><button type="button" class="btn primary" id="finishBuild" title="Turn the build into a review of the whole document" aria-describedby="finishErr">Finish and review</button>${b.confirmFinish ? "" : `<p class="berr" id="finishErr" role="alert">${esc(b.finishError)}</p>`}</div></div>
      ${b.confirmFinish ? finishConfirm((b.build.drafts ?? []).length, b.finishError) : ""}
      <div class="sub">${statusBadge("building")}${who ? `<span class="owner">with ${esc(who)}</span>` : ""}</div>
    </header>
    <main class="build">
      ${contextPanel(b.build, b)}
      <p class="build-help">Build the document here with Claude. Add a title, a heading, a paragraph, a list, a table, code or a diagram with +. Edit any of them, with buttons for bold, italic, links, lists, tables and code, and move or remove them. A heading holds everything under it, up to the next heading of the same size or larger: it moves with it, and folds it. Suggest asks Claude for headings, which join the document only when you accept them. Generate asks Claude to write everything under a heading, Generate all on the title asks for every empty heading, and Continue writing asks for more after a heading's text. Claude's text arrives as a draft beside the heading: Save puts it in the document, Discard leaves the heading as it was, and Undo puts back what was there before you saved it. Generate again asks Claude to write a block of its own again, in your words or with Shorter, Longer, Simpler or More detail; Save or Discard each block Claude rewrites. Blocks show as they will read; Edit opens one, and Preview shows it formatted again. Select words in a block and press Comment to ask Claude to change them, or to ask a question. Versions on a heading lists the earlier text under it, Claude's and yours: pick one to see what changed since, and Save puts it back, keeping the text it replaces as a version. When Claude writes something that contradicts other text it wrote, its note sits under the heading, naming both places; Resolve removes it for good, and Claude raises it again if it still applies. Finish turns it into a review of the whole document.</p>
      <div class="build-modes"><button type="button" class="btn small" id="modeAll">${b.editing.size ? "Preview all" : "Edit all"}</button></div>
      ${b.error && !b.errorAt ? errorLine() : ""}
      ${b.errors.length ? `<ul class="berr berrs" role="alert">${b.errors.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
      ${orphansHtml()}
      ${adderHtml("", "")}
      <div class="blocks">${rows || '<p class="empty">No blocks yet. Add one with +.</p>'}</div>
      ${historyHtml(b.build.steps)}
    </main>`,
    b.info,
  );
  mountDiagrams(app);
  placeError();
  const focus = b.focus;
  b.focus = null;
  if (focus) {
    // One selector, or several in order of preference: the first that shows takes focus.
    const el = [focus]
      .flat()
      .map((s) => app.querySelector(s))
      .find((x) => x?.getClientRects().length);
    el?.focus();
    if (el?.classList.contains("btext")) el.select();
  }
}

/** A block's Edit, or, when a folded section hides it, the outermost folded section's fold button. */
function shownControl(id) {
  const blocks = b.build.blocks;
  let target = sel("data-b-edit", id);
  for (
    let p = parentOf(
      blocks,
      blocks.findIndex((x) => x.id === id),
    );
    p >= 0;
    p = parentOf(blocks, p)
  )
    if (folded.has(blocks[p].id)) target = sel("data-b-fold", blocks[p].id);
  return target;
}

/** Where a refused change's error shows, by op: beside its open block, under Undo, else under the control that sent it. */
const ERROR_AT = { edit: (body) => body.block, undo_remove: () => "undo-remove", undo_dismiss: () => "undo-dismiss" };

/** The error line for `b.error`, outside a block's own. */
const errorLine = () => `<p class="berr" id="bat-err" role="alert">${esc(b.error)}</p>`;

/** The groups of controls an error line follows, so it sits under the row the control is in. */
const CONTROL_ROWS = ".row, .btools, .bsuggest, .bacts, .bprop-acts, .bprops-head, .bremove, .kinds, .bwait-row, .bctx-acts";

/**
 * Puts the error line of a change refused at `at:<selector>` directly under the control that sent
 * it: in its form above the form's buttons, else after the row of buttons it sits in. With the
 * control gone, the line shows under Edit all.
 */
function placeError() {
  if (!b.error || !b.errorAt?.startsWith("at:")) return;
  const el = app.querySelector(b.errorAt.slice(3));
  const row = el?.matches("form") ? el.querySelector(".row.end") : el?.closest(CONTROL_ROWS);
  if (row && el.matches("form")) row.insertAdjacentHTML("beforebegin", errorLine());
  else (row ?? el ?? app.querySelector(".build-modes"))?.insertAdjacentHTML("afterend", errorLine());
}

/** A selector for a control by its data attributes, so the page finds it again after it redraws; null when it has none. */
function controlSelector(el) {
  const attrs = [...el.attributes].filter((a) => a.name.startsWith("data-"));
  return attrs.length ? `${el.tagName.toLowerCase()}${attrs.map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join("")}` : null;
}

/** Where focus goes after a refusal under a control: a form's field, else the control itself. */
const errorFocus = (at) => [`${at} textarea`, `${at} input:not([type=checkbox])`, at];

/**
 * Sends a change, then shows the build the server returns; a refusal shows beside the open block,
 * or under the control that sent it, with focus there.
 */
async function change(body, focus) {
  const from = b.origin;
  b.origin = null;
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
    // Undo after a dismissal lasts until the person's next change.
    b.dismissed = null;
  } catch (err) {
    b.error = err.message;
    b.errorAt = ERROR_AT[body.op]?.(body) ?? (from ? `at:${from}` : null);
  }
  const next = focus?.() ?? null;
  // A refusal under a control keeps focus there; where that control is gone, focus goes where it would have.
  b.focus = b.error && b.errorAt?.startsWith("at:") ? [...errorFocus(b.errorAt.slice(3)), next].flat().filter(Boolean) : next;
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

/** Preview all on one open block, `before` as the person opened it: saves its draft when it changed, else closes it. */
async function saveOpen(id, before) {
  const block = b.build.blocks.find((x) => x.id === id);
  const draft = b.drafts[id];
  // An unsaved draft is never dropped: a block that is gone keeps its text in an editor of its own.
  if (!block) {
    const changed = draft !== undefined && (!before || boxText(before, draft) !== before.text);
    if (changed) b.errors.push("A block you were editing is gone, so your text for it waits under “Unsaved text for removed blocks”.");
    else closeEditor(id);
    return;
  }
  const text = draft === undefined ? block.text : boxText(block, draft);
  if (text === block.text) return closeEditor(id);
  try {
    b.build = await send({ op: "edit", block: id, text });
    closeEditor(id);
  } catch (err) {
    b.errors.push(err.message);
  }
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
  for (const id of [...b.editing]) await saveOpen(id, was.get(id));
  // Claude may have changed the build meanwhile; show it as it is, with the drafts still open.
  if (b.errors.length) b.build = (await api(`/api/reviews/${b.view.meta.id}/build`).catch(() => undefined)) ?? b.build;
  b.focus = b.errors.length ? ".borphans .btext, .bblock.editing .btext" : "#modeAll";
  paint();
}

document.addEventListener("click", async (e) => {
  const link = e.target.closest?.("a[data-b-jump]");
  if (link && b.build) {
    e.preventDefault();
    return jump(link.dataset.bJump);
  }
  const t = e.target.closest("button");
  if (!t || !b.build) return;
  b.jumped = null;
  const d = t.dataset;
  b.origin = controlSelector(t);
  if (!b.editing.size) b.error = "";
  if (t.id !== "finishBuild" && t.id !== "finishAnyway") b.finishError = "";
  if (t.id === "finishBuild") return finish();
  if (t.id === "finishAnyway") return finish(true);
  if (t.id === "modeAll") return switchAll();
  // The first key in CLICKS that the button has names what it does; a bare one counts even when empty.
  const key = Object.keys(CLICKS).find((k) => (BARE.has(k) ? d[k] !== undefined : d[k]));
  if (key) return CLICKS[key](d);
});

/** The attributes that name what their button does without a value. */
const BARE = new Set([
  "bAdd",
  "bCommentCancel",
  "bSuggestCancel",
  "bRetitleCancel",
  "bGenCancel",
  "bRegenCancel",
  "bRemoveCancel",
  "bBriefCancel",
  "bFinishCancel",
  "bUndoRemove",
]);

/** What each button does, by the data attribute that names it, in the order they are looked for. */
const CLICKS = {
  bAdd(d) {
    b.adding = b.adding === d.bAdd ? null : d.bAdd;
    b.focus = b.adding === null ? sel("data-b-add", d.bAdd) : `[data-b-kind][data-b-after="${CSS.escape(d.bAdd)}"]`;
    paint();
  },
  async bKind(d) {
    const before = new Set(b.build.blocks.map((x) => x.id));
    await change({ op: "add", kind: d.bKind, ...(d.bAfter ? { after: d.bAfter } : {}) });
    // A new block opens for editing, with its starting text selected.
    const added = b.build.blocks.find((x) => !before.has(x.id));
    if (added) {
      const blocks = b.build.blocks;
      for (let k = parentOf(blocks, blocks.indexOf(added)); k >= 0; k = parentOf(blocks, k)) folded.delete(blocks[k].id);
      openEditor(added.id);
    }
  },
  bEdit(d) {
    b.error = "";
    openEditor(d.bEdit);
  },
  bSave: (d) => save(d.bSave),
  bComment(d) {
    const same = b.commenting?.block === d.bComment;
    const pick = b.pressed ?? b.picked;
    const mine = pick?.block === d.bComment;
    b.commenting = same ? null : { block: d.bComment, selection: mine ? pick.text : "", ...(mine ? { occurrence: pick.occurrence } : {}) };
    b.commentText = "";
    b.regenerating = null;
    b.pressed = null;
    b.focus = same ? sel("data-b-comment", d.bComment) : `#bc-${CSS.escape(d.bComment)}`;
    paint();
  },
  bCommentCancel: () => closeForm(),
  bResolve(d) {
    const thread = (b.build.threads ?? []).find((x) => x.id === d.bResolve);
    change({ op: "resolve", thread: d.bResolve }, () => (thread ? sel("data-b-comment", thread.block) : null));
  },
  bTool: (d) => format(d.bFor, d.bTool),
  bSuggest(d) {
    const same = b.suggesting?.block === d.bSuggest && b.suggesting.kind === d.kind;
    b.suggesting = same ? null : { block: d.bSuggest, kind: d.kind };
    b.focus = same ? `[data-b-suggest="${CSS.escape(d.bSuggest)}"][data-kind="${d.kind}"]` : `#bs-note-${CSS.escape(d.bSuggest)}`;
    paint();
  },
  bSuggestCancel: () => closeSuggest(),
  async bAccept(d) {
    const before = new Set(b.build.blocks.map((x) => x.id));
    await change(d.bAccept ? { op: "accept", proposal: d.bAccept } : { op: "accept_all", request: d.bAcceptAll });
    // Focus goes to the next suggestion waiting, else to the first new heading.
    const next = document.querySelector("[data-b-accept]");
    const added = b.build.blocks.find((x) => !before.has(x.id));
    if (next) b.focus = sel("data-b-accept", next.dataset.bAccept);
    else b.focus = added ? sel("data-b-edit", added.id) : null;
    if (b.focus) paint();
  },
  bAcceptAll: (d) => CLICKS.bAccept(d),
  bDismiss(d) {
    const p = (b.build.proposals ?? []).find((x) => x.id === d.bDismiss);
    change({ op: "dismiss", proposal: d.bDismiss }, () => {
      if (!b.error && p) {
        b.dismissed = { id: p.id, title: p.title, anchor: p.anchor, inside: p.kind !== "next" };
        announce(`Dismissed the suggested heading “${plainText(p.title)}”. Undo puts it back.`);
      }
      // The page still shows the dismissed one: focus goes to another waiting, else to Undo.
      const next = document.querySelector(`[data-b-accept]:not(${sel("data-b-accept", d.bDismiss)})`);
      return next ? sel("data-b-accept", next.dataset.bAccept) : sel("data-b-undo-dismiss", d.bDismiss);
    });
  },
  // Undo, right after a dismissal or a removal: the suggested heading waits again, or the blocks go back.
  // A refusal keeps the Undo line, with its error under it, and focus on Undo.
  bUndoDismiss(d) {
    const title = b.dismissed?.title;
    change({ op: "undo_dismiss", proposal: d.bUndoDismiss }, () => {
      if (!b.error) announce(`Put back the suggested heading “${plainText(title)}”.`);
      return [sel("data-b-accept", d.bUndoDismiss), sel("data-b-undo-dismiss", d.bUndoDismiss)];
    });
  },
  bUndoRemove() {
    const first = b.build.blocks.length;
    const what = removedWords(b.build.removed?.what ?? "");
    change({ op: "undo_remove" }, () => {
      const back = b.build.steps.at(-1)?.block;
      if (b.error) return "[data-b-undo-remove]";
      announce(`Put back ${what}.`);
      return back && b.build.blocks.length > first ? shownControl(back) : "[data-b-undo-remove]";
    });
  },
  bRetitle(d) {
    b.retitling = d.bRetitle;
    b.focus = `#bp-${CSS.escape(d.bRetitle)}`;
    paint();
  },
  bRetitleSave: (d) => retitle(d.bRetitleSave),
  bRetitleCancel: () => closeRetitle(),
  bCancel: (d) => cancel(d.bCancel),
  bMove: (d) => change({ op: "move", block: d.bMove, to: d.bTo }, () => sel("data-b-edit", d.bMove)),
  bGen(d) {
    b.generating = b.generating === d.bGen ? null : d.bGen;
    b.focus = b.generating ? `#bn-${CSS.escape(d.bGen)}` : sel("data-b-gen", d.bGen);
    paint();
  },
  bGenCancel: () => closeGenerate(),
  // Withdraw on a pending request frees its heading; focus goes back to the button it held.
  bWithdraw: (d) =>
    change({ op: "withdraw", request: d.bWithdraw }, () =>
      d.kind === "write" ? sel("data-b-gen", d.bOn) : `[data-b-suggest="${CSS.escape(d.bOn)}"][data-kind="${d.kind}"]`,
    ),
  bUndo: (d) => change({ op: "undo", block: d.bUndo }, () => sel("data-b-gen", d.bUndo)),
  bRegen(d) {
    b.regenerating = b.regenerating === d.bRegen ? null : d.bRegen;
    b.commenting = null;
    b.focus = b.regenerating ? `#br-${CSS.escape(d.bRegen)}` : sel("data-b-regen", d.bRegen);
    paint();
  },
  bRegenCancel: () => closeForm(),
  bKeep: (d) => change({ op: "accept_change", block: d.bKeep }, () => sel("data-b-edit", d.bKeep)),
  bUnchange(d) {
    const c = b.build.changes.find((x) => x.blocks.includes(d.bUnchange));
    change({ op: "undo_change", block: d.bUnchange }, () => (c ? sel("data-b-edit", c.before[0].id) : null));
  },
  bFold(d) {
    if (folded.has(d.bFold)) folded.delete(d.bFold);
    else folded.add(d.bFold);
    b.focus = sel("data-b-fold", d.bFold);
    paint();
  },
  bRemove(d) {
    const blocks = b.build.blocks;
    const i = blocks.findIndex((x) => x.id === d.bRemove);
    // A heading with a section asks whether its section goes too.
    if (asksToRemove(blocks, i)) {
      b.removing = b.removing === d.bRemove ? null : d.bRemove;
      b.focus = b.removing ? sel("data-b-remove-section", d.bRemove) : sel("data-b-remove", d.bRemove);
      paint();
    } else remove(d.bRemove, false);
  },
  bRemoveSection: (d) => remove(d.bRemoveSection, true),
  bRemoveHeading: (d) => remove(d.bRemoveHeading, false),
  bRemoveCancel: () => closeRemove(),
  // Removing a document puts focus on the next one's Remove, else on the field that adds one.
  bCtxRemove(d) {
    const docs = b.build.context ?? [];
    const next = docs[docs.findIndex((x) => x.id === d.bCtxRemove) + 1];
    sendContext({ op: "context_remove", doc: d.bCtxRemove }, () => (next ? sel("data-b-ctx-remove", next.id) : "#bctx-in"));
  },
  bBrief() {
    b.briefing = true;
    b.briefError = "";
    b.focus = "#bb-audience";
    paint();
  },
  bBriefCancel: () => closeBrief(),
  // Generate all queues a Generate on each empty heading; focus stays on it, or goes to Suggest an outline once none is left.
  bGenAll: (d) => change({ op: "generate_all" }, () => (emptySections().length ? "[data-b-gen-all]" : sel("data-b-suggest", d.bGenAll))),
  bRefine: (d) => refine(d.bFor, d.bForm, d.bRefine),
  // Saving or discarding a draft puts focus on the heading's Generate.
  bSaveDraft: (d) => change({ op: "save_draft", block: d.bSaveDraft }, () => sel("data-b-gen", d.bSaveDraft)),
  bDiscard: (d) => change({ op: "discard_draft", block: d.bDiscard }, () => sel("data-b-gen", d.bDiscard)),
  bFinishCancel: () => closeFinish(),
  // Versions opens a section's versions, with the newest picked; pressing it again closes them.
  bVersions(d) {
    const open = b.versions?.section === d.bVersions;
    b.versions = open ? null : { section: d.bVersions, pick: null, error: "" };
    b.focus = open ? sel("data-b-versions", d.bVersions) : `[data-b-version][data-b-on="${CSS.escape(d.bVersions)}"]:checked`;
    paint();
  },
  // Saving a version puts it back; the versions close, focus goes back to their button, and the
  // live region says where the replaced text went. A refusal shows under Save.
  async bRestore(d) {
    const label = versionLabel(pickedVersion(b.build.history?.[d.bRestore], d.version));
    try {
      b.build = await send({ op: "restore", block: d.bRestore, version: d.version });
      b.versions = null;
      b.focus = sel("data-b-versions", d.bRestore);
      announce(`Saved the version “${label}”. The text it replaced is now the newest version.`);
    } catch (err) {
      if (b.versions) b.versions.error = err.message;
      b.focus = sel("data-b-restore", d.bRestore);
    }
    paint();
  },
  // Resolving a note puts focus on its heading's Edit.
  bResolveNote(d) {
    const note = (b.build.notes ?? []).find((n) => n.id === d.bResolveNote);
    change({ op: "resolve_note", note: d.bResolveNote }, () => (note ? sel("data-b-edit", note.section) : null));
  },
};

/** Picking a version in a section's list shows what changed since it; arrow keys step through them. */
document.addEventListener("change", (e) => {
  const d = e.target.dataset ?? {};
  if (!d.bVersion || b.versions?.section !== d.bOn) return;
  b.versions.pick = d.bVersion;
  b.versions.error = "";
  b.focus = `[data-b-version="${CSS.escape(d.bVersion)}"][data-b-on="${CSS.escape(d.bOn)}"]`;
  paint();
});

/** A note's link to the other place: opens the sections around it, and puts focus on that block. */
function jump(id) {
  const blocks = b.build.blocks;
  for (
    let k = parentOf(
      blocks,
      blocks.findIndex((x) => x.id === id),
    );
    k >= 0;
    k = parentOf(blocks, k)
  )
    folded.delete(blocks[k].id);
  b.jumped = id;
  b.focus = `#bk-${CSS.escape(id)}`;
  paint();
}

/** A refinement pressed in a Generate again form: one request with its instruction, and the note when one is typed. */
function refine(id, form, how) {
  const el = app.querySelector(form === "gen" ? sel("data-b-gen-form", id) : sel("data-b-regen-form", id));
  if (!el) return;
  if (form === "gen") return submitGenerate(el, how);
  submitRegen(el, how);
}

function closeFinish() {
  b.confirmFinish = false;
  b.finishError = "";
  b.focus = "#finishBuild";
  paint();
}

/**
 * Sends a change to the context documents or the brief. A refusal shows on the error line under the
 * field that sent it, and what was typed stays; `focus` says where focus goes after it is saved.
 */
async function sendContext(body, focus) {
  const brief = body.op === "brief";
  const from = b.origin;
  b.origin = null;
  try {
    b.build = await send(body);
    if (brief) b.briefing = false;
    else b.ctxText = "";
    b.ctxError = "";
    b.briefError = "";
    // A Remove that went through takes an earlier refused Remove's error with it.
    if (body.op === "context_remove") Object.assign(b, { error: "", errorAt: null });
    b.focus = focus();
  } catch (err) {
    // A refused Remove shows under the document's Remove; the brief and Add show under their fields.
    if (body.op === "context_remove" && from) Object.assign(b, { error: err.message, errorAt: `at:${from}`, focus: from });
    else {
      if (brief) b.briefError = err.message;
      else b.ctxError = err.message;
      b.focus = brief ? "#bb-audience" : "#bctx-in";
    }
  }
  paint();
}

function closeBrief() {
  b.briefing = false;
  b.briefError = "";
  b.focus = '[data-b-brief="open"]';
  paint();
}

/** Sends the brief form: every field, so an emptied one is cleared. */
function submitBrief(form) {
  const fields = Object.fromEntries(["audience", "tone", "length", "notes"].map((k) => [k, form.elements[k].value]));
  return sendContext({ op: "brief", ...fields }, () => '[data-b-brief="open"]');
}

/** Sends the link or path typed to add as a context document. */
function submitContext(form) {
  b.ctxText = form.elements.ref.value;
  return sendContext({ op: "context_add", ref: b.ctxText }, () => "#bctx-in");
}

// What the person types to add a context document survives a redraw.
document.addEventListener("input", (e) => {
  if (e.target.id === "bctx-in") b.ctxText = e.target.value;
});

/** Removes a block, or a heading with its section; focus goes to the + before it, or to Undo when that + is folded away. */
function remove(id, section) {
  const blocks = b.build.blocks;
  const i = blocks.findIndex((x) => x.id === id);
  const before = blocks[i - 1]?.id ?? "";
  // A block's name, as its Remove said it ("Paragraph 5"), names it in the Undo line too.
  const name = headingLevel(blocks[i]) ? {} : { name: blockName(blocks[i], i) };
  change({ op: "remove", block: id, ...(section ? { section: true } : {}), ...name }, () => {
    if (b.build.removed) announce(`Removed ${removedWords(b.build.removed.what)}. Undo puts it back.`);
    return [sel("data-b-add", before), "[data-b-undo-remove]"];
  });
}

function closeRemove() {
  const id = b.removing;
  b.removing = null;
  b.focus = id ? sel("data-b-remove", id) : null;
  paint();
}

/**
 * Turns the build into a review, then shows the review page. Everything is settled first: open edits
 * saved or cancelled, Claude's changes saved or discarded, comments resolved. A refusal shows beside
 * Finish and focus goes to the first thing it names. While Claude's drafts wait unsaved, Finish asks
 * first, and `withoutDrafts` is the person's answer to finish without them.
 */
async function finish(withoutDrafts = false) {
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
  if (!withoutDrafts && (b.build.drafts ?? []).length) {
    b.confirmFinish = true;
    b.focus = "#finishAnyway";
    return paint();
  }
  try {
    // The drafts the question was about, which the page shows unchanged while it is open.
    const shown = (b.build.drafts ?? []).map((d) => ({ section: d.section, block: d.blocks[0]?.id }));
    await post(`/api/reviews/${b.view.meta.id}/finish`, withoutDrafts ? { discard_drafts: shown } : {});
    location.reload();
  } catch (err) {
    if (withoutDrafts && /while you were deciding/.test(err.message)) return askAgain(err.message);
    // A refusal closes the question, and shows under Finish.
    b.confirmFinish = false;
    b.finishError = err.message;
    b.focus = finishFocus(err.message);
    paint();
  }
}

/** Claude sent a draft while the person decided: the page shows the build as it is now, and asks again, saying why. */
async function askAgain(message) {
  b.build = (await api(`/api/reviews/${b.view.meta.id}/build`).catch(() => undefined)) ?? b.build;
  b.confirmFinish = Boolean((b.build.drafts ?? []).length);
  b.finishError = message;
  b.focus = b.confirmFinish ? "#finishAnyway" : "#finishBuild";
  paint();
}

/** Where focus goes when Finish is refused: the first waiting change, else the first open comment, else Finish. */
function finishFocus(message) {
  if (/waiting change/.test(message)) return "[data-b-keep]";
  return /open comment/.test(message) ? "[data-b-resolve]" : "#finishBuild";
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
  let focus = null;
  if (b.regenerating) focus = sel("data-b-regen", b.regenerating);
  else if (b.commenting) focus = sel("data-b-comment", b.commenting.block);
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

/** Sends a Suggest form's request for headings, or Continue writing's request for more text. */
function submitSuggest(ask) {
  const block = ask.dataset.bSuggestForm;
  const kind = ask.dataset.kind;
  const note = ask.querySelector(".bnote-in").value.trim();
  const body = kind === "continue" ? { op: "continue", block } : { op: "suggest", block, kind };
  return change({ ...body, ...(note ? { note } : {}) }, () => pendingFocus(block, kind, `[data-b-suggest="${CSS.escape(block)}"][data-kind="${kind}"]`));
}

/** Sends a Generate again form, with the refinement pressed (`refine`) if any. */
function submitRegen(again, refine) {
  const block = again.dataset.bRegenForm;
  const note = again.querySelector("input[name=note]").value.trim();
  const all = again.querySelector("input[name=all]")?.checked;
  const target = all ? again.dataset.heading : block;
  // Everything under the heading is Generate on the heading; else Claude writes this block again.
  return change({ op: all ? "generate" : "rewrite", block: target, ...(note ? { note } : {}), ...(refine ? { refine } : {}) }, () =>
    all ? pendingFocus(target, "write", sel("data-b-gen", target)) : sel("data-b-regen", target),
  );
}

/** Sends a comment, on the words selected in the block when there are any. */
function submitComment(said) {
  const block = said.dataset.bCommentForm;
  const comment = said.querySelector("textarea").value;
  const { selection, occurrence } = b.commenting ?? {};
  const at = occurrence !== undefined ? { occurrence } : {};
  // A refused comment keeps its text, with the reason beside the form.
  b.commentText = comment;
  return change({ op: "comment", block, comment, ...(selection ? { selection, ...at } : {}) }, () => {
    if (b.error) b.errorAt = `comment:${block}`;
    else b.commentText = "";
    return b.commenting ? `#bc-${CSS.escape(block)}` : sel("data-b-comment", block);
  });
}

/** Sends a Generate form, with the refinement pressed (`refine`) if any. */
function submitGenerate(form, refine) {
  const block = form.dataset.bGenForm;
  const note = form.querySelector("input").value.trim();
  return change({ op: "generate", block, ...(note ? { note } : {}), ...(refine ? { refine } : {}) }, () =>
    pendingFocus(block, "write", sel("data-b-gen", block)),
  );
}

/** Where focus goes after asking Claude: the pending request's Withdraw, since its button can't be pressed now; else the button. */
function pendingFocus(block, kind, otherwise) {
  const pending = (b.build.requests ?? []).some((r) => r.block === block && (r.kind ?? "write") === kind && isOpen(r));
  return pending ? `[data-b-withdraw][data-b-on="${CSS.escape(block)}"][data-kind="${kind}"]` : otherwise;
}

/** Each of the page's forms, by the attribute that marks it, with what sending it does. */
const FORMS = [
  ["[data-b-suggest-form]", submitSuggest],
  ["[data-b-regen-form]", submitRegen],
  ["[data-b-comment-form]", submitComment],
  ["[data-b-gen-form]", submitGenerate],
  ["[data-b-ctx-form]", submitContext],
  ["[data-b-brief-form]", submitBrief],
];

// A form sent again before its first send answers (a double click, or Ctrl+Enter twice) sends nothing.
let sending = false;
document.addEventListener("submit", (e) => {
  for (const [attr, submit] of FORMS) {
    const form = e.target.closest?.(attr);
    if (!form) continue;
    e.preventDefault();
    if (sending) return;
    b.origin = controlSelector(form);
    sending = true;
    return Promise.resolve(submit(form)).finally(() => {
      sending = false;
    });
  }
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
  if (editing) editorKey(e, box, editing);
  else if (e.target.classList?.contains("bprop-in") && (e.key === "Enter" || e.key === "Escape")) {
    e.preventDefault();
    if (e.key === "Escape") return closeRetitle();
    // Enter sends from the box, so a refusal shows under it, not under the last button pressed.
    b.origin = `#bp-${CSS.escape(b.retitling)}`;
    retitle(b.retitling);
  } else if (e.key === "Escape") escapeKey(e);
});

/** A key in an open block's box: Escape cancels, Mod+Enter (or Enter on one line) previews, Mod+B, I and K format. */
function editorKey(e, box, editing) {
  const inBox = e.target.classList.contains("btext");
  // Escape never throws away text for a block that is gone; only Discard does.
  if (e.key === "Escape" && !box.classList.contains("orphan")) {
    e.preventDefault();
    cancel(editing);
  } else if (inBox && sendKey(e, e.target.tagName === "TEXTAREA")) {
    e.preventDefault();
    if (!e.repeat) save(editing);
  } else if (modKey(e) && inBox) {
    // Mod+B, Mod+I and Mod+K press Bold, Italic and Link, when the block has them.
    const tool = TOOLS.find(([, , key]) => key && key === e.key.toLowerCase())?.[0];
    const id = e.target.closest("[data-block]").dataset.block;
    if (tool && app.querySelector(`[data-b-tool="${tool}"][data-b-for="${CSS.escape(id)}"]`)) {
      e.preventDefault();
      format(id, tool);
    }
  }
}

/** What Escape closes outside a block's box, in order: the first that is open. */
const ESCAPES = [
  [() => b.regenerating !== null || b.commenting !== null, closeForm],
  [() => b.suggesting !== null, closeSuggest],
  [() => b.removing !== null, closeRemove],
  [() => b.generating !== null, closeGenerate],
  [() => b.briefing, closeBrief],
  [() => b.confirmFinish, closeFinish],
  [() => b.versions !== null, closeVersions],
  [() => document.activeElement?.id === "bctx-in" && (b.ctxText || b.ctxError), clearContext],
];

/** Closes a section's versions, with focus back on their button. */
function closeVersions() {
  const id = b.versions.section;
  b.versions = null;
  b.focus = sel("data-b-versions", id);
  paint();
}

/** Escape in the field that adds a context document clears it and its error. */
function clearContext() {
  b.ctxText = "";
  b.ctxError = "";
  b.focus = "#bctx-in";
  paint();
}

/** Escape outside a block's box closes the open form or choice, else the open + menu. */
function escapeKey(e) {
  const open = ESCAPES.find(([isOpen]) => isOpen());
  if (open) {
    e.preventDefault();
    return open[1]();
  }
  if (b.adding === null) return;
  const at = b.adding;
  b.adding = null;
  b.focus = sel("data-b-add", at);
  paint();
}

/**
 * What a redraw shows that can change without a new version: the requests' states (a request Claude
 * left unanswered too long shows as queued again) and whether Claude's session is listening.
 */
const shown = (build) => JSON.stringify([build.version, build.claude?.listening, (build.requests ?? []).map((r) => [r.id, r.status])]);

/** Asks for the build again, and shows it when it changed, unless the person is typing in a block. */
async function refresh() {
  tick();
  // A typed block or note would be lost to a redraw, so the page waits until it is saved or closed.
  const busy = () =>
    b.editing.size || b.generating || b.regenerating || b.commenting || b.suggesting || b.retitling || b.removing || b.briefing || b.confirmFinish || b.ctxText;
  if (document.visibilityState !== "visible" || busy()) return;
  const build = await api(`/api/reviews/${b.view.meta.id}/build`).catch(() => undefined);
  if (!build || busy()) return;
  const same = shown(build) === shown(b.build);
  b.build = build;
  if (same) return tick();
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
