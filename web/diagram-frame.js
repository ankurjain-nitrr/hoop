// Runs inside a diagram's sandboxed frame: draws the source the page sends with the library's
// strict security level, and tells the page the drawing's height or why it failed.
(() => {
  const lib = globalThis.mermaid;
  const say = (msg) => parent.postMessage(msg, "*");
  addEventListener("message", async (e) => {
    if (e.source !== parent || e.data?.type !== "draw") return;
    const { id, source, dark } = e.data;
    // Without the library the source is fine as far as anyone knows, so the page doesn't report it.
    if (!lib) return say({ type: "error", id, message: "the diagram library didn't load from the network", unloaded: true });
    try {
      lib.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
      const { svg } = await lib.render(`m${id}`, source);
      document.body.innerHTML = svg;
      const box = document.body.firstElementChild?.getBoundingClientRect();
      say({ type: "drawn", id, height: Math.ceil(box?.height ?? document.body.scrollHeight) });
    } catch (err) {
      say({ type: "error", id, message: err?.message ?? String(err) });
    }
  });
  say({ type: "ready" });
})();
