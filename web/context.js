// What Claude writes a build from, as the build page shows it: the context documents the person
// lists, with Claude's reason beside one it couldn't open; the person's brief; and, under a heading,
// the documents Claude drew its text from. Pure HTML from the build's data, so build.js keeps only
// the page's state and events. A document is untrusted text: only an http(s) link becomes a link,
// and a file path shows as text.
import { esc } from "./esc.js";
import { readAt } from "./activity.js";
import { longHint } from "./send.js";

/** The brief's fields, with the label people read and the longest each takes. */
const BRIEF = [
  ["audience", "Audience", 200, "For example: the leadership team"],
  ["tone", "Tone", 200, "For example: plain and direct"],
  ["length", "Length", 200, "For example: one page"],
];
const NOTES_MAX = 2000;

const isLink = (ref) => /^https?:\/\//i.test(ref);

/** A document as it reads: a link opens in a new tab and tells the page it opens nothing of the build; a path is text. */
function refHtml(ref) {
  if (isLink(ref)) return `<a class="bref" href="${esc(ref)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>`;
  return `<span class="bref bpath">${esc(ref)}</span>`;
}

/** Claude's reason as a sentence, ending in a full stop when it has none. */
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** One listed document: what it is, Claude's reason when it couldn't open it, and Remove. */
function docHtml(d) {
  const bad = d.unreadable
    ? `<p class="bctx-bad"><span class="who">Claude</span> <span class="m">${esc(readAt(d.unreadable.at))}</span> couldn't open it: ${esc(sentence(d.unreadable.reason))} Claude tries again with each request.</p>`
    : "";
  return `<li class="bctx-doc${d.unreadable ? " unreadable" : ""}" data-doc="${esc(d.id)}">
    <div class="bctx-ref">${refHtml(d.ref)}${bad}</div>
    <div class="bctx-acts"><button type="button" class="btn small" data-b-ctx-remove="${esc(d.id)}" aria-label="${esc(`Remove ${d.ref}`)}">Remove</button></div>
  </li>`;
}

/** The brief as it stands, or its form while the person edits it. */
function briefHtml(brief, editing, error) {
  if (editing) {
    const fields = BRIEF.map(
      ([k, label, max, hint]) =>
        `<label class="lab" for="bb-${k}">${label}</label><input id="bb-${k}" class="bnote-in" name="${k}" maxlength="${max}" autocomplete="off" placeholder="${esc(hint)}" value="${esc(brief?.[k] ?? "")}">`,
    ).join("");
    return `<form class="bgen bbrief-form" data-b-brief-form>
      ${fields}
      <label class="lab" for="bb-notes">Anything else</label>
      <textarea id="bb-notes" class="bnote-in" name="notes" rows="3" maxlength="${NOTES_MAX}" data-send="long" aria-describedby="bb-hint bb-err" placeholder="For example: avoid jargon; cite numbers">${esc(brief?.notes ?? "")}</textarea>
      ${longHint("bb-hint", "saves")}
      <p class="berr" id="bb-err" role="alert">${esc(error)}</p>
      <div class="row end"><div><button type="button" class="btn small" data-b-brief-cancel>Cancel</button><button type="submit" class="btn small primary">Save</button></div></div>
    </form>`;
  }
  const rows = [...BRIEF, ["notes", "Anything else"]]
    .filter(([k]) => brief?.[k])
    .map(([k, label]) => `<div><dt>${label}</dt><dd>${esc(brief[k])}</dd></div>`)
    .join("");
  const shown = rows ? `<dl class="bbrief">${rows}</dl>` : '<p class="bnote">No brief yet: who it is for, the tone, the length.</p>';
  return `${shown}<div class="row end"><button type="button" class="btn small" data-b-brief="open">${rows ? "Edit brief" : "Add a brief"}</button></div>`;
}

/**
 * The panel at the top of the build page: the context documents in order, the field that adds one,
 * and the brief beside them. `s` is the page's state for them: the text typed to add, whether the
 * brief is open, and the error line of each.
 */
export function contextPanel(build, s) {
  const docs = build.context ?? [];
  const list = docs.length
    ? `<ol class="bctx-list">${docs.map(docHtml).join("")}</ol>`
    : '<p class="bnote">No documents yet. Add a link, such as a Google Doc, or a file on this machine.</p>';
  return `<section class="bctx" aria-labelledby="bctx-h">
    <div class="bctx-docs">
      <h2 id="bctx-h">Context for Claude</h2>
      <p class="bnote">Claude reads these, and the brief, before it writes. A change applies to later requests.</p>
      ${list}
      <form class="bctx-add" data-b-ctx-form>
        <label class="lab" for="bctx-in">Link or file path</label>
        <div class="bctx-row"><input id="bctx-in" class="bnote-in" name="ref" maxlength="2000" autocomplete="off" placeholder="https://docs.google.com/… or /Users/you/notes.md" aria-describedby="bctx-err" value="${esc(s.ctxText)}"><button type="submit" class="btn small">Add</button></div>
        <p class="berr" id="bctx-err" role="alert">${esc(s.ctxError)}</p>
      </form>
    </div>
    <div class="bctx-brief">
      <h2>Brief</h2>
      ${briefHtml(build.brief, s.briefing, s.briefError)}
    </div>
  </section>`;
}

/** The documents Claude drew a heading's own text from (its blocks up to the next heading), or "" when none. */
export function sourcesHtml(blocks, i, headingLevel) {
  const refs = [];
  for (let k = i + 1; k < blocks.length && !headingLevel(blocks[k]); k++) for (const r of blocks[k].sources ?? []) if (!refs.includes(r)) refs.push(r);
  if (!refs.length) return "";
  return `<p class="bsources"><span class="bsources-k">Claude wrote this from</span> ${refs.map(refHtml).join('<span class="bsep">, </span>')}</p>`;
}
