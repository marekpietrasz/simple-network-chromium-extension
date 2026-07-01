// Registers a top-level DevTools panel (sits next to Elements, Console, Network...).
// This is the only supported way to add UI to DevTools; the built-in Network
// request tabs (Headers/Preview/Response) are not extensible by Chrome's API.
chrome.devtools.panels.create(
  "Net Inspector",
  null,            // icon path (optional; omitted to keep the package minimal)
  "panel.html",
  function (panel) {
    // No per-panel wiring needed; panel.js drives everything on load.
  }
);
