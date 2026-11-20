// What the build page shows for Claude's drafts and the Generate controls around them: a section's
// draft beside its heading, with Discard and Save; the one-press refinements Generate again offers;
// and the question Finish asks while a draft is unsaved. Pure HTML from the build's data, so
// build.js keeps only the page's state and events.
import { esc } from "./esc.js";

/** The refinements Generate again offers, each one press, with the text on its button. */
/** @type {[string, string][]} */
const REFINES = [
  ["shorter", "Shorter"],
  ["longer", "Longer"],
  ["simpler", "Simpler"],
  ["more_detail", "More detail"],
];

/**
 * Claude's draft for the section headed by `block`, marked as a draft: what saving it does, the text
 * as it would read (`render`), the documents Claude drew it from (`sources`), Discard and Save.
 * @template B
 * @param {{ kind?: string, blocks: B[] }} draft
 * @param {{ id: string }} block
 * @param {string} name
 * @param {(block: B) => string} render
 * @param {string} sources
 */
export function draftHtml(draft, block, name, render, sources) {
  const id = esc(block.id);
  const what = draft.kind === "continue" ? "Saving it adds this after the text under this heading." : "Saving it replaces everything under this heading.";
  return `<div class="bchange bdraft" role="group" aria-label="${esc(`Claude's draft for ${name}`)}" data-draft="${id}">
    <p class="bchange-head">Draft from Claude</p>
    <p class="bdraft-what">${what} Nothing in the document changes until you save it.</p>
    <div class="bdraft-body">${draft.blocks.map(render).join("")}</div>${sources}
    <div class="row end"><div><button type="button" class="btn small" data-b-discard="${id}" aria-label="${esc(`Discard Claude's draft for ${name}`)}">Discard</button><button type="button" class="btn small primary" data-b-save-draft="${id}" aria-label="${esc(`Save Claude's draft for ${name}`)}">Save</button></div></div>
  </div>`;
}

/**
 * The refinement buttons in a Generate again form (`form` names it: "regen" on a block, "gen" on a
 * heading), each sending one request with its instruction at once, with the note typed above it.
 * The caption says so.
 * @param {string} id
 * @param {string} name
 * @param {"regen" | "gen"} form
 */
export function refineButtons(id, name, form) {
  const cap = `brk-${form}-${esc(id)}`;
  const buttons = REFINES.map(
    ([k, label]) =>
      `<button type="button" class="btn small" data-b-refine="${k}" data-b-for="${esc(id)}" data-b-form="${form}" aria-label="${esc(`Generate again ${name}, ${label.toLowerCase()}`)}">${label}</button>`,
  ).join("");
  return `<div class="brefine-wrap"><p class="brefine-k" id="${cap}">Or ask for one of these now; your note goes with it:</p><div class="brefine" role="group" aria-labelledby="${cap}">${buttons}</div></div>`;
}

/**
 * The question Finish asks while Claude's drafts are unsaved: finish without them, or Cancel; then Finish's error line.
 * @param {number} count
 * @param {string} error
 */
export function finishConfirm(count, error) {
  const drafts = count === 1 ? "a draft" : `${count} drafts`;
  return `<div class="bconfirm" role="group" aria-labelledby="finishAsk">
    <p id="finishAsk">Claude has ${drafts} you haven't saved. Finish without ${count === 1 ? "it" : "them"}?</p>
    <div class="row end"><div><button type="button" class="btn small primary" id="finishAnyway">Finish without drafts</button><button type="button" class="btn small" data-b-finish-cancel>Cancel</button></div></div>
    <p class="berr" id="finishErr" role="alert">${esc(error)}</p>
  </div>`;
}
