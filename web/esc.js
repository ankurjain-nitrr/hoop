// Escapes text for HTML. U+2028 joins a document line's source lines; it shows as a line break and
// keeps offsets 1:1.
export const esc = (s) =>
  String(s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
    .replace(/\u2028/g, "\n");

/** A message as a sentence: with its full stop, unless it already ends in one, so a next step can follow it. */
export const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);
