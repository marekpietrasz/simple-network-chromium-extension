"use strict";

// Run with:  node --test        (Node 18+, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../extension/format.js");

// A minimal HAR-like entry factory for building test "calls".
function entry(over) {
  return Object.assign({
    _resourceType: "xhr",
    time: 12,
    request: { method: "GET", url: "https://api.example.com/v1/users?q=1", headers: [], postData: null },
    response: { status: 200, statusText: "OK", headers: [], content: {} },
  }, over || {});
}

test("resourceType / isXhrFetch", () => {
  assert.equal(F.isXhrFetch({ _resourceType: "xhr" }), true);
  assert.equal(F.isXhrFetch({ _resourceType: "fetch" }), true);
  assert.equal(F.isXhrFetch({ _resourceType: "document" }), false);
  assert.equal(F.isXhrFetch({ _resourceType: "image" }), false);
  assert.equal(F.isXhrFetch({}), false); // no field -> excluded
});

test("statusClass buckets", () => {
  assert.equal(F.statusClass(0), "warn");   // failed/blocked
  assert.equal(F.statusClass(200), "ok");
  assert.equal(F.statusClass(204), "ok");
  assert.equal(F.statusClass(301), "warn");
  assert.equal(F.statusClass(404), "err");
  assert.equal(F.statusClass(500), "err");
});

test("shortName", () => {
  assert.equal(F.shortName("https://api.example.com/v1/users?q=1"), "users?q=1");
  assert.equal(F.shortName("https://api.example.com/"), "api.example.com");
  assert.equal(F.shortName("not a url"), "not a url"); // graceful fallback
});

test("callMatches filters on method/status/url, case-insensitive", () => {
  const e = entry();
  assert.equal(F.callMatches(e, ""), true);        // empty -> everything
  assert.equal(F.callMatches(e, "USERS"), true);   // url, case-insensitive
  assert.equal(F.callMatches(e, "get"), true);     // method
  assert.equal(F.callMatches(e, "200"), true);     // status
  assert.equal(F.callMatches(e, "nope"), false);
});

test("tryParseJson only parses plausible JSON", () => {
  assert.deepEqual(F.tryParseJson('{"a":1}', "application/json"), { ok: true, value: { a: 1 } });
  assert.deepEqual(F.tryParseJson("[1,2]", ""), { ok: true, value: [1, 2] });
  // Bare scalars are NOT treated as JSON unless the mime says so.
  assert.equal(F.tryParseJson("123", "text/plain").ok, false);
  assert.equal(F.tryParseJson("true", "text/plain").ok, false);
  // ...but an explicit json mime allows a scalar.
  assert.deepEqual(F.tryParseJson("123", "application/json"), { ok: true, value: 123 });
  // Malformed JSON fails cleanly.
  assert.equal(F.tryParseJson("{bad", "application/json").ok, false);
  assert.equal(F.tryParseJson(null, "application/json").ok, false);
});

test("httpHeaderLines drops HTTP/2 pseudo-headers", () => {
  const headers = [
    { name: ":method", value: "GET" },
    { name: ":authority", value: "api.example.com" },
    { name: "Accept", value: "application/json" },
    { name: "Authorization", value: "Bearer xyz" },
  ];
  assert.equal(
    F.httpHeaderLines(headers),
    "Accept: application/json\nAuthorization: Bearer xyz"
  );
  assert.equal(F.httpHeaderLines([]), "");
  assert.equal(F.httpHeaderLines(null), "");
});

test("responseBodyForCopy handles each state", () => {
  assert.equal(F.responseBodyForCopy({}), "(response body not loaded yet)");
  assert.equal(F.responseBodyForCopy({ respBody: { encoding: "base64" } }), "(binary/base64 body omitted)");
  assert.equal(F.responseBodyForCopy({ respBody: { err: "boom" } }), "(body unavailable: boom)");
  assert.equal(F.responseBodyForCopy({ respBody: { text: "hello" } }), "hello");
});

test("buildHttpRequest produces an executable .http block", () => {
  const call = {
    entry: entry({
      request: {
        method: "POST",
        url: "https://api.example.com/v1/users",
        headers: [
          { name: ":method", value: "POST" }, // pseudo-header must be dropped
          { name: "Content-Type", value: "application/json" },
        ],
        postData: { mimeType: "application/json", text: '{"name":"Ada"}' },
      },
    }),
  };
  assert.equal(
    F.buildHttpRequest(call, true),
    "### POST users\n" +
    "POST https://api.example.com/v1/users\n" +
    "Content-Type: application/json\n" +
    "\n" +
    '{"name":"Ada"}\n'
  );
  // Without the name header line.
  assert.equal(
    F.buildHttpRequest(call, false),
    "POST https://api.example.com/v1/users\n" +
    "Content-Type: application/json\n" +
    "\n" +
    '{"name":"Ada"}\n'
  );
});

test("buildHttpRequest with no headers and no body", () => {
  const call = { entry: entry({ request: { method: "GET", url: "https://x.test/ping", headers: [], postData: null } }) };
  assert.equal(F.buildHttpRequest(call, false), "GET https://x.test/ping\n");
});

test("buildHttpResponse plain and commented", () => {
  const call = {
    entry: entry({
      response: {
        status: 404,
        statusText: "Not Found",
        headers: [{ name: "Content-Type", value: "application/json" }],
      },
    }),
    respBody: { text: '{"error":"nope"}' },
  };
  assert.equal(
    F.buildHttpResponse(call, false),
    "HTTP/1.1 404 Not Found\n" +
    "Content-Type: application/json\n" +
    "\n" +
    '{"error":"nope"}'
  );
  assert.equal(
    F.buildHttpResponse(call, true),
    "# HTTP/1.1 404 Not Found\n" +
    "# Content-Type: application/json\n" +
    "#\n" +
    '# {"error":"nope"}'
  );
});

test("buildHttpBoth = executable request + commented response", () => {
  const call = {
    entry: entry({
      request: { method: "GET", url: "https://x.test/ping", headers: [], postData: null },
      response: { status: 200, statusText: "OK", headers: [{ name: "X-A", value: "1" }] },
    }),
    respBody: { text: "pong" },
  };
  assert.equal(
    F.buildHttpBoth(call),
    "### GET ping\n" +
    "GET https://x.test/ping\n" +
    "\n" +
    "# --- Response ---\n" +
    "# HTTP/1.1 200 OK\n" +
    "# X-A: 1\n" +
    "#\n" +
    "# pong\n"
  );
});
