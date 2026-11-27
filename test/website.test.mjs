import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("standalone initialization tracks clean paths, SPA changes and cleanup", async () => {
  const calls = [];
  const listeners = new Map();
  const location = new URL("https://site.example/pricing?secret=x#hash");
  const history = {};
  for (const method of ["pushState", "replaceState"])
    history[method] = (_state, _unused, url) => {
      if (url) location.href = new URL(url, location).href;
    };
  const original = history.pushState;
  const context = vm.createContext({
    URL,
    crypto,
    performance,
    AbortController,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    navigator: {},
    window: {
      location,
      history,
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name) => listeners.delete(name),
    },
    document: {
      referrer: "https://referrer.example/private?secret=x",
      currentScript: {
        dataset: {
          endpoint: "https://collector.example",
          appKey: "public-key",
        },
      },
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response('{"accepted":1}');
    },
    console,
  });
  vm.runInContext(
    await readFile(new URL("../dist/halflime.min.js", import.meta.url), "utf8"),
    context,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body)[0].path, "/pricing");
  assert.equal(
    JSON.parse(calls[0].options.body)[0].referrer,
    "https://referrer.example",
  );
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.referrerPolicy, "no-referrer");
  history.pushState({}, "", "/next?private=yes");
  history.replaceState({}, "", "/next#hash");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].options.body)[0].path, "/next");
  context.HalfLime.cleanup();
  context.HalfLime.cleanup();
  assert.equal(history.pushState, original);
  assert.equal(listeners.size, 0);
  history.pushState({}, "", "/after");
  assert.equal(calls.length, 2);
});

test("website cleanup remains idempotent across a later initialization", async (t) => {
  const { initWebsite } = await import("../dist/website.js");
  const windowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: new URL("https://site.example/"),
      history: { pushState() {}, replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { referrer: "" },
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response('{"accepted":1}'),
  );
  let second;
  try {
    const config = { endpoint: "https://collector.example", appKey: "key" };
    const first = initWebsite(config);
    first();
    second = initWebsite(config);
    first();
    assert.throws(() => initWebsite(config), /already active/);
  } finally {
    second?.();
    if (windowDescriptor)
      Object.defineProperty(globalThis, "window", windowDescriptor);
    else delete globalThis.window;
    if (documentDescriptor)
      Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete globalThis.document;
  }
});
