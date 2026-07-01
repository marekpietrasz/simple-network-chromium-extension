// End-to-end test of the panel UI.
//
// Loads panel.html as a normal page with a stubbed chrome.devtools.network,
// injects synthetic Fetch/XHR calls, and asserts the real DOM produced by
// panel.js — list rows, header folding, the JSON tree, and copy-button output.
// This exercises the actual UI without the (unsupported/flaky) automation of a
// real DevTools window.
//
// Run:  npm run test:e2e     (needs: npm install, npx playwright install chromium)

import assert from "node:assert/strict";
import { chromium } from "playwright";

const panelUrl = new URL("../extension/panel.html", import.meta.url).href;

// Runs in the page *before* format.js / panel.js load. Fakes the DevTools API
// and captures clipboard writes so we can assert on copied text deterministically.
function initStubs() {
  window.__reqListeners = [];
  window.__clipboard = null;
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t) => { window.__clipboard = t; return Promise.resolve(); },
      },
    });
  } catch (e) { /* already defined & non-configurable — ignore */ }

  window.chrome = {
    devtools: {
      network: {
        onRequestFinished: { addListener: (fn) => window.__reqListeners.push(fn) },
        onNavigated: { addListener: () => {} },
        // getHAR intentionally omitted so panel.js doesn't seed extra rows.
      },
    },
  };

  // Deliver a synthetic request to panel.js, with a getContent() for the body.
  window.__emitRequest = (entry, content, encoding) => {
    const req = Object.assign({}, entry, { getContent: (cb) => cb(content, encoding) });
    window.__reqListeners.forEach((fn) => fn(req));
  };
}

const sampleEntry = {
  _resourceType: "fetch",
  time: 12,
  request: {
    method: "GET",
    url: "https://api.example.com/v1/users?q=1",
    headers: [
      { name: ":method", value: "GET" }, // pseudo-header: must be dropped from .http
      { name: "Accept", value: "application/json" },
      { name: "X-Demo", value: "1" },
    ],
    postData: null,
  },
  response: {
    status: 200,
    statusText: "OK",
    headers: [{ name: "Content-Type", value: "application/json" }],
    content: { mimeType: "application/json" },
  },
};
const sampleBody = JSON.stringify({ id: 42, name: "Ada", roles: ["admin", "author"] });

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  console.log("  ✔ " + name);
  passed++;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.addInitScript(initStubs);
  await page.goto(panelUrl);
  await page.waitForSelector("#list");

  // --- capture -------------------------------------------------------------
  await page.evaluate(([e, body]) => window.__emitRequest(e, body, null), [sampleEntry, sampleBody]);

  const row = page.locator(".row").first();
  await row.waitFor();
  check("list shows exactly one row", (await page.locator(".row").count()) === 1);
  check("row shows method GET", (await row.locator(".method").textContent()) === "GET");
  check("row shows status 200", (await row.locator(".status").textContent()) === "200");

  // --- detail --------------------------------------------------------------
  await row.click();
  check("detail shows the url", (await page.locator(".url").textContent()).includes("api.example.com/v1/users"));

  const reqHeaders = page.locator("details.section", { hasText: "Request headers" }).first();
  check("request-headers section exists", (await reqHeaders.count()) > 0);
  check("request headers folded by default", (await reqHeaders.evaluate((el) => el.open)) === false);

  check("response body rendered as JSON tree", (await page.locator(".json").count()) > 0);
  check("json tree contains a key", (await page.locator(".json").first().innerText()).includes("name"));

  // --- copy icons ----------------------------------------------------------
  await page.getByTitle("Copy URL").click();
  check("URL copy icon puts the url on the clipboard",
    (await page.evaluate(() => window.__clipboard)) === sampleEntry.request.url);

  await page.locator(".summary-line .iconbtn.export").click();
  const exported = await page.evaluate(() => window.__clipboard);
  check("export starts with the executable .http request line",
    exported.startsWith("### GET users") && exported.includes("GET https://api.example.com/v1/users"));
  check("export keeps real headers, drops pseudo-headers",
    exported.includes("Accept: application/json") && !exported.includes(":method"));
  check("export appends the response as commented lines",
    exported.includes("# --- Response ---") &&
    exported.includes("# HTTP/1.1 200 OK") &&
    exported.includes('# {"id":42'));

  // --- fold state persists across calls ------------------------------------
  const respHeaders = page.locator("details.section", { hasText: "Response headers" }).first();
  check("response headers folded initially", (await respHeaders.evaluate((el) => el.open)) === false);
  await respHeaders.locator("summary").click();
  check("response headers open after clicking", (await respHeaders.evaluate((el) => el.open)) === true);

  const second = JSON.parse(JSON.stringify(sampleEntry));
  second.request.url = "https://api.example.com/v1/orders";
  await page.evaluate(([e, body]) => window.__emitRequest(e, body, null), [second, sampleBody]);
  await page.locator(".row").nth(1).click();
  const respHeaders2 = page.locator("details.section", { hasText: "Response headers" }).first();
  check("response headers stays open when switching to another call",
    (await respHeaders2.evaluate((el) => el.open)) === true);

  // --- arrow-key navigation ------------------------------------------------
  const rows = page.locator(".row");
  const isSel = (n) => rows.nth(n).evaluate((el) => el.classList.contains("sel"));
  await rows.first().click();
  check("first row selected after click", await isSel(0));
  await page.keyboard.press("ArrowDown");
  check("ArrowDown selects the next row", (await isSel(1)) && !(await isSel(0)));
  check("ArrowDown updates the detail",
    (await page.locator(".url .urltext").textContent()).includes("/v1/orders"));
  await page.keyboard.press("ArrowUp");
  check("ArrowUp selects the previous row", (await isSel(0)) && !(await isSel(1)));

  console.log("\n" + passed + " checks passed");
} finally {
  await browser.close();
}
