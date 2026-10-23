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
  document: svg('<path d="M4 2.5h5l3 3v8h-8z"/><path d="M9 2.5v3h3"/>'),
  edit: svg('<path d="M10.5 3l2.5 2.5-7 7h-2.5v-2.5z"/><path d="M9 4.5l2.5 2.5"/>'),
  trash: svg('<path d="M3.5 4.5h9M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9"/>'),
  github: svg(
    '<path d="M8 2a6 6 0 0 0-1.9 11.7c.3 0 .4-.1.4-.3v-1c-1.7.4-2-.8-2-.8-.3-.7-.7-.9-.7-.9-.5-.4 0-.4 0-.4.6 0 .9.6.9.6.5.9 1.4.7 1.8.5 0-.4.2-.7.4-.8-1.3-.2-2.7-.7-2.7-3 0-.6.2-1.2.6-1.6 0-.2-.3-.8.1-1.6 0 0 .5-.2 1.6.6a5.6 5.6 0 0 1 3 0c1.1-.8 1.6-.6 1.6-.6.3.8.1 1.4 0 1.6.4.4.6 1 .6 1.6 0 2.3-1.4 2.8-2.7 3 .2.2.4.6.4 1.1v1.7c0 .2.1.4.4.3A6 6 0 0 0 8 2z" fill="currentColor" stroke="none"/>',
  ),
};
