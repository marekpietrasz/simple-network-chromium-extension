// ---------------------------------------------------------------------------
// Pure, DOM-free helpers for the Network Call Inspector.
//
// Kept separate from panel.js so they can be unit-tested in Node without a
// browser or any dependencies. Loaded in the browser via a plain <script> tag
// (exposes `window.NCI`); loaded in Node via require() (module.exports).
// ---------------------------------------------------------------------------
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NCI = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Chrome exposes the DevTools resource type on this non-standard field.
  function resourceType(entry) {
    return (entry && entry._resourceType) || "";
  }

  function isXhrFetch(entry) {
    const t = resourceType(entry);
    return t === "xhr" || t === "fetch";
  }

  // Maps an HTTP status to a CSS state class used for row/summary coloring.
  function statusClass(status) {
    if (!status) return "warn"; // 0 = failed/blocked
    if (status >= 400) return "err";
    if (status >= 300) return "warn";
    return "ok";
  }

  // A short label for the list: last path segment (+ query), or host for "/".
  function shortName(url) {
    try {
      const u = new URL(url);
      const path = u.pathname === "/" ? u.hostname : u.pathname.split("/").pop() || u.pathname;
      return path + (u.search ? u.search : "");
    } catch (e) {
      return url;
    }
  }

  // Whether an entry matches the toolbar filter (method / status / url).
  function callMatches(entry, filterText) {
    if (!filterText) return true;
    const hay = (entry.request.method + " " + entry.response.status + " " + entry.request.url).toLowerCase();
    return hay.indexOf(filterText.toLowerCase()) !== -1;
  }

  // Attempt to parse text as JSON, but only when it plausibly is JSON so we
  // don't turn a bare "123" or "true" body into a number/boolean.
  function tryParseJson(text, mimeType) {
    if (text == null) return { ok: false };
    const t = String(text).trim();
    if (!(t.startsWith("{") || t.startsWith("["))) {
      if (!(mimeType && mimeType.indexOf("json") !== -1)) return { ok: false };
    }
    try {
      return { ok: true, value: JSON.parse(t) };
    } catch (e) {
      return { ok: false };
    }
  }

  // "Name: value" lines, dropping HTTP/2 pseudo-headers (":method"...) that are
  // not valid inside an .http file.
  function httpHeaderLines(headers) {
    return (headers || [])
      .filter((h) => h.name && h.name[0] !== ":")
      .map((h) => h.name + ": " + h.value)
      .join("\n");
  }

  function responseBodyForCopy(call) {
    if (!call.respBody) return "(response body not loaded yet)";
    if (call.respBody.encoding === "base64") return "(binary/base64 body omitted)";
    if (call.respBody.err) return "(body unavailable: " + call.respBody.err + ")";
    return call.respBody.text || "";
  }

  // IntelliJ-style executable request block.
  function buildHttpRequest(call, includeName) {
    const e = call.entry;
    let out = "";
    if (includeName) out += "### " + e.request.method + " " + shortName(e.request.url) + "\n";
    out += e.request.method + " " + e.request.url + "\n";
    const hl = httpHeaderLines(e.request.headers);
    if (hl) out += hl + "\n";
    const post = e.request.postData;
    if (post && post.text) out += "\n" + post.text + "\n";
    return out;
  }

  // HTTP-response-shaped block. When asComments is set, every line is prefixed
  // with "# " so the block can live inside an executable .http file.
  function buildHttpResponse(call, asComments) {
    const e = call.entry;
    const statusLine = "HTTP/1.1 " + (e.response.status || 0) +
      (e.response.statusText ? " " + e.response.statusText : "");
    const hl = httpHeaderLines(e.response.headers);
    let text = statusLine + (hl ? "\n" + hl : "");
    const body = responseBodyForCopy(call);
    if (body) text += "\n\n" + body;
    if (asComments) {
      text = text.split("\n").map((l) => (l.length ? "# " + l : "#")).join("\n");
    }
    return text;
  }

  // The "whole shebang": executable request + commented response.
  function buildHttpBoth(call) {
    let out = buildHttpRequest(call, true);
    if (!out.endsWith("\n")) out += "\n";
    out += "\n# --- Response ---\n" + buildHttpResponse(call, true) + "\n";
    return out;
  }

  return {
    resourceType,
    isXhrFetch,
    statusClass,
    shortName,
    callMatches,
    tryParseJson,
    httpHeaderLines,
    responseBodyForCopy,
    buildHttpRequest,
    buildHttpResponse,
    buildHttpBoth,
  };
});
