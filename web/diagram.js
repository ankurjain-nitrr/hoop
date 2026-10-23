// Diagrams: a code line fenced as `mermaid` draws in a sandboxed frame. The frame has no same-origin
// access and a content policy that allows only the library's pinned file and the frame's script, so
// a diagram can't run script in the page, make a request or change anything outside its box. The
// library loads from a CDN only when a page has a diagram, and the browser runs it only if it
// matches MERMAID_SRI; offline, the diagram shows its source.
import { esc } from "/esc.js";
import { JOIN } from "/blocks.js";

/** The pinned library and its hash; test/sections.test.ts checks the hash against the mermaid devDependency. */
export const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js";
export const MERMAID_SRI = "sha384-EbBpjO7rlR6eqZEcG7GaPpyk9H9WrMyPWX4d3KvPYltgt8Z8l0z6R56B1qP40pR4";

const OPEN = /^\s{0,3}(```|~~~)\s*mermaid\s*$/;
const TIMEOUT_MS = 15000;

/** Whether a document line is a Mermaid diagram. */
export const isDiagram = (text) => OPEN.test(text.split(JOIN)[0] ?? "");

/** A diagram line's source: the lines inside its fences. */
export function diagramSource(text) {
  const lines = text.split(JOIN);
  const fence = lines[0].trim().slice(0, 3);
  const body = lines.slice(1);
  if (body.length && body.at(-1).trim().startsWith(fence)) body.pop();
  return body.join("\n");
}

/** The placeholder a diagram line renders as; `mountDiagrams` draws it after the page renders. */
export function diagramHtml(text) {
  return `<div class="diagram" data-diagram-source="${esc(diagramSource(text))}"><p class="diagram-wait" role="status">Drawing the diagram…</p></div>`;
}

let seq = 0;
const waiting = new Map();

/** Draws each diagram placeholder on the page in its own sandboxed frame. */
export function mountDiagrams(root = document) {
  for (const box of root.querySelectorAll(".diagram[data-diagram-source]:not([data-mounted])")) {
    box.dataset.mounted = "1";
    const id = `d${++seq}`;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", "Diagram");
    // The frame draws at full width but out of sight, since a hidden frame lays nothing out and
    // the library would measure every label as zero.
    frame.className = "diagram-frame drawing";
    // A drawing has nothing to operate, so the frame stays out of the Tab order.
    frame.tabIndex = -1;
    const origin = location.origin;
    const policy = `default-src 'none'; script-src ${MERMAID_URL} ${origin}/diagram-frame.js; style-src 'unsafe-inline'; img-src data:; font-src data:`;
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${esc(policy)}"><style>html,body{margin:0;background:transparent}</style></head><body><script src="${MERMAID_URL}" integrity="${MERMAID_SRI}" crossorigin="anonymous"></script><script src="${origin}/diagram-frame.js"></script></body></html>`;
    let loads = 0;
    const fail = (reason) => {
      waiting.delete(id);
      frame.remove();
      box.innerHTML = `<p class="diagram-error" role="status">This diagram can't be drawn: ${esc(reason)}</p><pre class="diagram-src">${esc(box.dataset.diagramSource)}</pre>`;
    };
    // A frame that loads again has navigated itself, so it goes, and the source shows in its place.
    frame.addEventListener("load", () => {
      if (++loads > 1) fail("it tried to leave its frame");
    });
    const timer = setTimeout(() => waiting.has(id) && fail("it took too long to draw"), TIMEOUT_MS);
    waiting.set(id, { frame, box, fail, timer });
    box.append(frame);
  }
}

window.addEventListener("message", (e) => {
  // A frame a re-render removed has no window, so its entry goes.
  for (const [id, w] of waiting)
    if (!w.frame.isConnected) {
      clearTimeout(w.timer);
      waiting.delete(id);
    }
  if (!e.source) return;
  const entry = [...waiting.entries()].find(([, w]) => w.frame.contentWindow === e.source);
  if (!entry) return;
  const [id, w] = entry;
  const data = e.data ?? {};
  if (data.type === "ready") {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    w.frame.contentWindow.postMessage({ type: "draw", id, source: w.box.dataset.diagramSource, dark }, "*");
    return;
  }
  if (data.id !== id) return;
  clearTimeout(w.timer);
  if (data.type === "error") return w.fail(String(data.message ?? "the library refused it").slice(0, 300));
  if (data.type === "drawn") {
    waiting.delete(id);
    w.box.querySelector(".diagram-wait")?.remove();
    w.frame.style.height = `${Math.max(40, Math.min(4000, Number(data.height) || 0))}px`;
    w.frame.classList.replace("drawing", "drawn");
  }
});
