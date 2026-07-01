"use strict";

// ---------------------------------------------------------------------------
// Network Call Inspector — DevTools panel logic.
//
// Captures Fetch/XHR calls via chrome.devtools.network and renders them in a
// master/detail view. Everything runs locally inside DevTools; the extension
// makes no network requests of its own and stores nothing outside the panel.
// ---------------------------------------------------------------------------

/** @typedef {{ id:number, entry:object, getContent:?Function, row:?HTMLElement }} Call */

// Pure helpers live in format.js (loaded before this file) so they can be unit
// tested in Node. `NCI` is the global that format.js exposes in the browser.
const {
  isXhrFetch,
  statusClass,
  shortName,
  callMatches,
  tryParseJson,
  httpHeaderLines,
  buildHttpBoth,
} = NCI;

/** @type {Call[]} */
const calls = [];
let nextId = 1;
let selectedId = null;
let filterText = "";

// Fold state for the top-level detail sections, remembered across calls so that
// opening e.g. "Response headers" keeps it open when you select another call.
const sectionState = {
  "Request headers": false,
  "Response headers": false,
  "Request body": true,
  "Response body": true,
};

const listEl = document.getElementById("list");
const detailEl = document.getElementById("detail");
const countEl = document.getElementById("count");
const filterEl = document.getElementById("filter");
const preserveEl = document.getElementById("preserve");

// --- tiny DOM helper --------------------------------------------------------
function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const k in props) {
      if (k === "class") node.className = props[k];
      else if (k === "text") node.textContent = props[k];
      else if (k === "title") node.title = props[k];
      else node.setAttribute(k, props[k]);
    }
  }
  if (children != null) {
    const arr = Array.isArray(children) ? children : [children];
    for (const c of arr) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return node;
}

// --- clipboard --------------------------------------------------------------
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
}

// Inline SVG icons — self-contained, so there are no external assets to load.
const ICON_CLIPBOARD =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
  '<path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
  '<path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
const ICON_EXPORT =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 2 8 6h3v8h2V6h3l-4-4zM4 14v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6h-2v6H6v-6H4z"/></svg>';
// IntelliJ-style expand/collapse-all: chevrons pointing apart (expand) or
// together (collapse).
const ICON_EXPAND =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M5 6.5 8 3.5 11 6.5"/><path d="M5 9.5 8 12.5 11 9.5"/></svg>';
const ICON_COLLAPSE =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M5 3.5 8 6.5 11 3.5"/><path d="M5 12.5 8 9.5 11 12.5"/></svg>';

// An icon button that copies getText() to the clipboard and briefly shows a
// check. getText is called at click time so async-loaded bodies are picked up.
function iconBtn(icon, title, getText) {
  const btn = el("button", { class: "iconbtn", title });
  btn.innerHTML = icon;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    copyText(getText());
    btn.innerHTML = ICON_CHECK;
    btn.classList.add("done");
    setTimeout(() => { btn.innerHTML = icon; btn.classList.remove("done"); }, 1000);
  });
  return btn;
}

// A plain icon button that runs an action on click (no copy/check animation).
function actionBtn(icon, title, onClick) {
  const btn = el("button", { class: "iconbtn", title });
  btn.innerHTML = icon;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  return btn;
}

// Append the given buttons to a section's summary as a right-aligned group,
// in natural left-to-right order.
function addSummaryButtons(section, buttons) {
  const group = el("span", { class: "sumbtns" }, buttons);
  section.querySelector("summary").appendChild(group);
}

// --- capture ----------------------------------------------------------------
function addCall(entry, getContent) {
  if (!isXhrFetch(entry)) return;
  const call = { id: nextId++, entry, getContent, row: null };
  calls.push(call);
  if (matchesFilter(call)) appendRow(call);
  updateCount();
}

// Live capture of finished requests (these carry a working getContent()).
chrome.devtools.network.onRequestFinished.addListener(function (req) {
  addCall(req, req.getContent ? req.getContent.bind(req) : null);
});

// Optionally seed with whatever is already in the log when the panel opens.
if (chrome.devtools.network.getHAR) {
  chrome.devtools.network.getHAR(function (har) {
    if (!har || !har.entries) return;
    for (const entry of har.entries) {
      // getHAR entries have no getContent(); response.content.text may exist.
      addCall(entry, null);
    }
  });
}

// Clear on navigation unless "Preserve log" is checked.
chrome.devtools.network.onNavigated.addListener(function () {
  if (!preserveEl.checked) clearAll();
});

// --- list rendering ---------------------------------------------------------
function matchesFilter(call) {
  return callMatches(call.entry, filterText);
}

function appendRow(call) {
  const e = call.entry;
  const status = e.response.status;
  const row = el("div", { class: "row " + statusClass(status), title: e.request.url }, [
    el("span", { class: "method", text: e.request.method }),
    el("span", { class: "status", text: status ? String(status) : "—" }),
    el("span", { class: "name", text: shortName(e.request.url) }),
  ]);
  row.addEventListener("click", () => select(call.id));
  if (call.id === selectedId) row.classList.add("sel");
  call.row = row;
  listEl.appendChild(row);
}

function rebuildList() {
  listEl.textContent = "";
  for (const call of calls) {
    call.row = null;
    if (matchesFilter(call)) appendRow(call);
  }
  updateCount();
}

function updateCount() {
  const shown = calls.filter(matchesFilter).length;
  countEl.textContent = shown === calls.length
    ? shown + " calls"
    : shown + " / " + calls.length + " calls";
}

function clearAll() {
  calls.length = 0;
  selectedId = null;
  listEl.textContent = "";
  detailEl.textContent = "";
  detailEl.appendChild(el("div", { class: "empty", text: "Select a call to see the details." }));
  updateCount();
}

// --- detail rendering -------------------------------------------------------
function select(id) {
  selectedId = id;
  for (const call of calls) {
    if (call.row) call.row.classList.toggle("sel", call.id === id);
  }
  const call = calls.find((c) => c.id === id);
  if (call) renderDetail(call);
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  const h = (headers || []).find((x) => x.name.toLowerCase() === lower);
  return h ? h.value : "";
}

function headersSection(title, headers, open) {
  const list = (headers || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const body = el("div", { class: "body kv" });
  if (list.length === 0) {
    body.appendChild(el("div", { class: "hint", text: "(none)" }));
  } else {
    for (const h of list) {
      body.appendChild(el("div", { class: "h" }, [
        el("span", { class: "hk", text: h.name }),
        el("span", { class: "hv", text: h.value }),
      ]));
    }
  }
  const section = sectionEl(title, list.length + " headers", body, open);
  if (list.length) {
    addSummaryButtons(section, [
      iconBtn(ICON_CLIPBOARD, "Copy headers", () => httpHeaderLines(list)),
    ]);
  }
  return section;
}

function sectionEl(title, badgeText, bodyNode, open) {
  const summary = el("summary", null, [
    document.createTextNode(title),
    badgeText ? el("span", { class: "badge", text: badgeText }) : null,
  ]);
  const details = el("details", { class: "section" }, [summary, bodyNode]);
  // Fold state is remembered per section title and shared across calls.
  const remembered = title in sectionState ? sectionState[title] : open;
  if (remembered) details.open = true;
  details.addEventListener("toggle", () => { sectionState[title] = details.open; });
  return details;
}

// Render a request/response body: JSON as a foldable tree, XML/text as raw.
function bodySection(title, text, mimeType, open, note) {
  const body = el("div", { class: "body" });

  if (note) body.appendChild(el("div", { class: "hint", text: note }));

  if (text == null || text === "") {
    if (!note) body.appendChild(el("div", { class: "hint", text: "(empty)" }));
    return sectionEl(title, note ? "" : "empty", body, open);
  }

  const copyBtn = iconBtn(ICON_CLIPBOARD, "Copy body", () => text);

  let badge;
  let treeEl = null;
  const parsed = tryParseJson(text, mimeType);
  if (parsed.ok) {
    badge = "JSON · " + text.length + " B";
    treeEl = el("div", { class: "json" }, [renderJson(parsed.value, null, 0)]);
    body.appendChild(treeEl);
  } else {
    const looksXml = /^\s*</.test(text);
    badge = (looksXml ? "XML/text" : "text") + " · " + text.length + " B";
    body.appendChild(el("pre", { class: "raw", text: text }));
  }

  const section = sectionEl(title, badge, body, open);
  const buttons = [];
  // Expand/collapse-all only make sense for the foldable JSON tree.
  if (treeEl) {
    const setAll = (openState) => {
      for (const d of treeEl.querySelectorAll("details")) d.open = openState;
    };
    buttons.push(actionBtn(ICON_EXPAND, "Expand all", () => setAll(true)));
    buttons.push(actionBtn(ICON_COLLAPSE, "Collapse all", () => setAll(false)));
  }
  buttons.push(copyBtn);
  addSummaryButtons(section, buttons);
  return section;
}

// Recursive JSON -> DOM. Objects/arrays are <details> (foldable); leaves inline.
function renderJson(value, key, depth) {
  const keyNode = key == null ? null : el("span", { class: "k", text: JSON.stringify(key) + ": " });

  if (value === null) return leaf(keyNode, "null", "z");
  const type = typeof value;
  if (type === "string") return leaf(keyNode, JSON.stringify(value), "s");
  if (type === "number") return leaf(keyNode, String(value), "n");
  if (type === "boolean") return leaf(keyNode, String(value), "b");

  const isArray = Array.isArray(value);
  const entries = isArray
    ? value.map((v, i) => [i, v])
    : Object.keys(value).map((k) => [k, value[k]]);
  const openB = isArray ? "[" : "{";
  const closeB = isArray ? "]" : "}";

  if (entries.length === 0) {
    return leaf(keyNode, openB + closeB, "muted");
  }

  const summary = el("summary", null, [
    keyNode ? keyNode.cloneNode(true) : null,
    el("span", { class: "muted", text: openB + " " + entries.length + (isArray ? " items" : " keys") + " " + closeB }),
  ]);
  const details = el("details", null, [summary]);
  details.open = true; // fully expanded on open; use Collapse all to fold.
  for (const [k, v] of entries) {
    details.appendChild(renderJson(v, isArray ? null : k, depth + 1));
  }
  return details;
}

function leaf(keyNode, valText, cls) {
  return el("div", { class: "leaf" }, [
    keyNode,
    el("span", { class: cls, text: valText }),
  ]);
}

function renderDetail(call) {
  const e = call.entry;
  detailEl.textContent = "";

  const status = e.response.status;
  // Export the whole call as IntelliJ .http: executable request + commented response.
  const exportBtn = iconBtn(
    ICON_EXPORT,
    "Export whole call to clipboard as .http (request executable; response as comments)",
    () => buildHttpBoth(call)
  );
  exportBtn.classList.add("export");
  detailEl.appendChild(el("div", { class: "summary-line" }, [
    el("span", { class: "method", text: e.request.method }),
    el("span", { class: "status " + statusClass(status), text: (status || "(failed)") + (e.response.statusText ? " " + e.response.statusText : "") }),
    e.time ? el("span", { class: "muted", text: Math.round(e.time) + " ms" }) : null,
    exportBtn,
  ]));

  detailEl.appendChild(el("div", { class: "url" }, [
    iconBtn(ICON_CLIPBOARD, "Copy URL", () => e.request.url),
    el("span", { class: "urltext", text: e.request.url }),
  ]));

  // Headers — folded by default (fold state is then remembered across calls).
  detailEl.appendChild(headersSection("Request headers", e.request.headers, false));
  detailEl.appendChild(headersSection("Response headers", e.response.headers, false));

  // Request body.
  const post = e.request.postData;
  detailEl.appendChild(bodySection(
    "Request body",
    post ? post.text : "",
    post ? post.mimeType : "",
    true
  ));

  // Response body — fetched asynchronously.
  const respMime = headerValue(e.response.headers, "content-type")
    || (e.response.content && e.response.content.mimeType) || "";
  const placeholder = bodySection("Response body", "", respMime, true, "Loading…");
  detailEl.appendChild(placeholder);

  loadResponseBody(call, (text, encoding, err) => {
    // Cache the result on the call so the copy buttons can use it later.
    call.respBody = { text: text || "", encoding: encoding || null, err: err || null };
    // Guard: user may have selected another call meanwhile.
    if (selectedId !== call.id) return;
    let note = null;
    if (err) note = "Could not read body: " + err;
    else if (encoding === "base64") { note = "Binary/base64 content — not decoded."; text = ""; }
    const rebuilt = bodySection("Response body", text, respMime, true, note);
    detailEl.replaceChild(rebuilt, placeholder);
  });
}

function loadResponseBody(call, cb) {
  if (call.getContent) {
    try {
      call.getContent((content, encoding) => cb(content, encoding, null));
      return;
    } catch (e) {
      cb("", null, String(e));
      return;
    }
  }
  // Seeded (getHAR) entries: fall back to any inline text the HAR carried.
  const c = call.entry.response && call.entry.response.content;
  if (c && typeof c.text === "string") cb(c.text, c.encoding, null);
  else cb("", null, "body not captured (call finished before the panel opened)");
}

// --- keyboard navigation ----------------------------------------------------
// Up/Down move the selection to the previous/next visible call (and show its
// detail), instead of just scrolling the list pane.
function moveSelection(delta) {
  const visible = calls.filter(matchesFilter);
  if (visible.length === 0) return;
  let idx = visible.findIndex((c) => c.id === selectedId);
  if (idx === -1) idx = delta > 0 ? 0 : visible.length - 1;
  else idx = Math.min(visible.length - 1, Math.max(0, idx + delta));
  const target = visible[idx];
  select(target.id);
  if (target.row) target.row.scrollIntoView({ block: "nearest" });
}

document.addEventListener("keydown", (ev) => {
  if (ev.target === filterEl) return; // don't hijack arrows in the search box
  if (ev.key === "ArrowDown") { ev.preventDefault(); moveSelection(1); }
  else if (ev.key === "ArrowUp") { ev.preventDefault(); moveSelection(-1); }
});

// --- resizable split --------------------------------------------------------
// Drag the divider to resize the list / detail panes. The list gets an explicit
// pixel flex-basis; the detail pane flexes to fill whatever is left.
(function initSplitter() {
  const splitter = document.getElementById("splitter");
  const mainEl = document.getElementById("main");
  let dragging = false;

  splitter.addEventListener("mousedown", (ev) => {
    dragging = true;
    splitter.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    ev.preventDefault();
  });

  document.addEventListener("mousemove", (ev) => {
    if (!dragging) return;
    const rect = mainEl.getBoundingClientRect();
    const min = 180;
    const max = rect.width - 220;
    let w = ev.clientX - rect.left;
    w = Math.max(min, Math.min(max, w));
    listEl.style.flex = "0 0 " + w + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
})();

// --- toolbar wiring ---------------------------------------------------------
document.getElementById("clear").addEventListener("click", clearAll);

let filterTimer = null;
filterEl.addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    filterText = filterEl.value.trim().toLowerCase();
    rebuildList();
  }, 120);
});
