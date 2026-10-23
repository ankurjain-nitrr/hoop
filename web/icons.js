// Inline SVG icons on a 16 by 16 grid. They take the text color and are hidden from screen readers;
// the control around an icon carries its name.
const svg = (body) =>
  `<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  comment: svg('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>'),
  plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  expand: svg('<path d="M6 4l4 4-4 4"/>'),
  collapse: svg('<path d="M4 6l4 4 4-4"/>'),
  check: svg('<path d="M3.5 8.5l3 3 6-7"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  warning: svg('<path d="M8 2.5l6 11h-12z"/><path d="M8 6.5v3M8 11.5v.5"/>'),
  clock: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>'),
  minus: svg('<path d="M3.5 8h9"/>'),
  home: svg('<path d="M2.5 7.5 8 3l5.5 4.5"/><path d="M4 6.5v7h8v-7"/><path d="M6.5 13.5v-4h3v4"/>'),
  list: svg('<path d="M6 4.5h7M6 8h7M6 11.5h7"/><path d="M3 4.5h.5M3 8h.5M3 11.5h.5"/>'),
  document: svg('<path d="M4 2.5h5l3 3v8h-8z"/><path d="M9 2.5v3h3"/>'),
  edit: svg('<path d="M10.5 3l2.5 2.5-7 7h-2.5v-2.5z"/><path d="M9 4.5l2.5 2.5"/>'),
  up: svg('<path d="M8 13V3.5M4 7.5l4-4 4 4"/>'),
  down: svg('<path d="M8 3v9.5M4 8.5l4 4 4-4"/>'),
  spark: svg('<path d="M8 2.5l1.3 4.2 4.2 1.3-4.2 1.3L8 13.5l-1.3-4.2L2.5 8l4.2-1.3z"/>'),
  undo: svg('<path d="M5.5 4L3 6.5 5.5 9"/><path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H7"/>'),
  trash: svg('<path d="M3.5 4.5h9M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9"/>'),
};
