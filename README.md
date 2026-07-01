# Network Call Inspector

A tiny, dependency-free Chromium DevTools extension that shows **URL, method, status,
request/response headers, and request/response bodies** for **Fetch/XHR** calls in a
single pane — so you don't have to click between the Headers / Payload / Response tabs.

- Headers are **folded by default**; a section's open/closed state is **remembered across
  calls**, so opening e.g. Response headers keeps it open as you click through requests.
- JSON bodies render as a **foldable tree**; XML and plain text show as raw, wrapped text.
- **↑/↓ arrow keys** move the selection to the previous/next call (the search box keeps its
  own arrow behavior).
- A **clipboard icon** copies each piece (URL, request/response headers, request/response
  body). An **export icon** copies the whole call as IntelliJ-style `.http`: the request is
  executable, and the response (status, headers, body) comes along as commented-out lines so
  the block stays runnable.
- No build step, no npm packages, no external requests. Everything runs locally inside
  DevTools and nothing is stored or sent anywhere — easy to read and audit end-to-end.

## Why this exists

Reconstructing a single API call in the built-in Network panel means bouncing between the
**Headers**, **Payload**, and **Response** sub-tabs (and often between requests) to see the
whole picture at once. This panel puts URL, method, status, both header sets, and both
bodies in **one scrollable pane**.

It is deliberately **tiny, dependency-free, and permission-free** so it can be trusted and
audited in a locked-down / corporate environment where installing a third-party network
inspector isn't an option:

- The manifest requests **no permissions and no host access** — it cannot read page content
  or make network requests. It only reads request metadata that DevTools already has.
- **Nothing leaves the browser.** No telemetry, no external scripts, no storage.
- Body text is inserted via DOM text nodes (no `innerHTML` for response data), so a hostile
  payload can't inject markup into the panel.
- The whole thing is a handful of readable, un-minified files with no build step.

The **`.http` export** exists so you can lift a captured call straight into an IntelliJ
(or VS Code REST Client) `.http` scratch file and replay/tweak it.

## Files

The shippable extension lives in **`extension/`**; everything else (tests, `package.json`)
is dev tooling that is *not* part of the extension.

| File | Purpose |
|------|---------|
| `extension/manifest.json` | MV3 manifest; declares only `devtools_page`. No host/permissions. |
| `extension/devtools.html` / `devtools.js` | Loader that registers the DevTools panel. |
| `extension/panel.html` / `panel.css` / `panel.js` | The one-pane UI and all capture logic. |
| `extension/format.js` | Pure, DOM-free helpers (shared with the unit tests). |

## Install (unpacked)

1. Open `chrome://extensions` (works in Chrome/Edge/Brave/other Chromium).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the **`extension/`** folder (not the repo root).
4. Open DevTools (F12) on any page → the **Net Inspector** tab appears next to
   Elements / Console / Network. Fetch/XHR calls are captured while it's open.

> After moving/renaming the extension folder, a **Remove** + **Load unpacked** is needed —
> the reload icon alone keeps the old path.

## Using the panel

Open DevTools (F12) and switch to the **Net Inspector** tab. Fetch/XHR calls made by the
page are captured live while the tab is open (if it's narrow, the tab may hide under the
`»` overflow on the DevTools tab bar).

**Toolbar**
- **Filter** box — type to narrow the list by method, status, or URL.
- **Clear** — empty the captured list.
- **Preserve log** — when checked (default), the list survives page reloads/navigations;
  uncheck to clear automatically on navigation.

**List (left)** — one row per call, colored by status (green ok / amber redirect / red
error). Click a row, or use **↑/↓** to move to the previous/next call.

**Detail (right)** — for the selected call:
- Method, status, and timing, with an **export icon** (top-right) → copies the whole call as
  `.http`.
- The **URL**, with a **clipboard icon** to copy just the URL.
- Foldable **Request/Response headers** (folded by default) and **Request/Response bodies**
  (JSON as a tree, XML/text raw). Each section has a **clipboard icon** to copy that piece.
- A section's open/closed state is **remembered as you move between calls**, so you can, say,
  keep Response body expanded and headers collapsed across the whole list.

**Copying / exporting**
- **Clipboard icon** = copy that one piece (URL, a header block, or a body).
- **Export icon** = copy the entire call as IntelliJ `.http`: an executable request (URL +
  request headers + request body) followed by the response as commented-out lines. Paste it
  into a `.http` file to replay; IntelliJ ignores the commented response, which is there for
  your reference.

## Testing

**Automated (unit tests).** The pure logic (`.http` formatting, JSON detection, header
filtering, status/URL helpers) lives in `extension/format.js` and is covered by tests that run on
Node's built-in runner — no `npm install`, no dependencies:

```
node --test          # or: npm test
```

**Automated UI (end-to-end).** `test/e2e.panel.mjs` loads `extension/panel.html` in a real
(headless) browser via Playwright, stubs `chrome.devtools.network`, injects synthetic
Fetch/XHR calls, and asserts the rendered DOM and copy-button output. This is a dev-only
dependency — the extension itself ships nothing extra.

```
npm install                        # installs Playwright (dev dependency)
npx playwright install chromium    # one-time browser download
npm run test:e2e                   # or npm run test:all for unit + e2e
```

> Note: this drives the panel directly rather than the real DevTools window. Chrome's
> DevTools window isn't reliably automatable, so full "open DevTools → click the tab"
> flows are covered by the manual step below instead.

**Manual.** With the extension loaded (see *Install* above), serve the bundled harness so
it can make real Fetch/XHR calls:

```
python3 -m http.server 8000
```

Open <http://localhost:8000/test/manual.html>, then DevTools (F12) → **Net Inspector**, and
click the buttons on the page (JSON via fetch and XHR, XML, plain text, a POST with a body,
and a 404). Check that headers fold, JSON folds as a tree, XML/text show raw, status colors
are right, the copy icons put the expected text on your clipboard, and the export icon emits
the full `.http` (request + commented response).

## Notes & limits

- Chrome's public API **cannot** add a tab to the built-in Network request view
  (Headers/Preview/Response) or a shortcut on a selected call — that pane isn't
  extensible. A dedicated top-level panel is the supported approach.
- Response bodies are read via the DevTools protocol after a request finishes; binary
  responses are flagged rather than decoded.
- Calls that finished *before* the panel was opened are seeded from the DevTools log,
  but their response bodies may not be available.
