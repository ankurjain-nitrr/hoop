// Escapes text for HTML. U+2028 joins a document line's source lines; it shows as a line break and
// keeps offsets 1:1.
/** @type {Record<string, string>} */
const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** @param {unknown} s */
export const esc = (s) =>
  String(s)
    .replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c)
    .replace(/\u2028/g, "\n");

/** A message as a sentence: with its full stop, unless it already ends in one, so a next step can follow it. */
/** @param {string} text */
export const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);
