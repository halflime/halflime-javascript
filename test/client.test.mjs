import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import pkg from "../package.json" with { type: "json" };
import { createClient } from "../dist/index.js";

test("sends an immutable event over HTTP and reuses exact bytes on retry", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ body, headers: req.headers, url: req.url });
    if (requests.length === 1) {
      req.socket.destroy();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ accepted: requests.length === 2 ? 1 : 0 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = createClient({
      endpoint: `http://127.0.0.1:${server.address().port}`,
      appKey: "public-key",
      systemProps: { appVersion: "1.0.0" },
    });
    const props = {
      plan: "free",
      email: "a@example.org",
      other: "192.168.1.1",
      token: "secret",
      nested: {},
    };
    const event = client.event("opened", props, {
      path: "/pricing?secret=yes#hash",
      referrer: "https://example.org/secret?token=x#hash",
    });
    props.plan = "changed";
    assert(Object.isFrozen(event));
    assert(Object.isFrozen(event.props));
    assert.equal(event.props.plan, "free");
    assert.equal(event.path, "/pricing");
    assert.equal(event.referrer, "https://example.org");
    assert.deepEqual(event.props, { plan: "free" });
    assert.match(event.eventId, /^[a-f0-9-]{36}$/);
    await assert.rejects(client.send(event));
    assert.deepEqual(await client.send(event), { accepted: 1 });
    assert.deepEqual(await client.send(event), { accepted: 0 });
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(requests[1].body, requests[2].body);
    assert.equal(requests[0].url, "/api/v1/events");
    assert.equal(requests[0].headers["app-key"], "public-key");
    assert.equal(requests[0].headers.referer, undefined);
    assert.equal(requests[0].headers.cookie, undefined);
    const [wire] = JSON.parse(requests[0].body);
    assert.equal(
      wire.systemProps.sdkVersion,
      `halflime-javascript@${pkg.version}`,
    );
    assert.equal(client.event("next").sessionId, event.sessionId);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("validates configuration and input, bounds properties and rotates idle sessions", (t) => {
  for (const endpoint of [
    "file:///tmp/a",
    "https://user:pass@example.org",
    "https://example.org/no",
    "https://example.org/a/../",
    "https://example.org?secret=x",
  ])
    assert.throws(() => createClient({ endpoint, appKey: "key" }));
  assert.throws(() =>
    createClient({ endpoint: "https://example.org", appKey: "bad\nkey" }),
  );
  assert.throws(() =>
    createClient({
      endpoint: "https://example.org",
      appKey: "key",
      timeoutMs: 0,
    }),
  );
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const systemProps = {
    appVersion: "1",
    isDebug: true,
    unknown: "discard",
    osName: "a@example.org",
  };
  const client = createClient({
    endpoint: "https://example.org/api/v1/events",
    appKey: "key",
    systemProps,
  });
  systemProps.appVersion = "2";
  const first = client.event("opened");
  assert.equal(first.systemProps.appVersion, "1");
  assert.equal(first.systemProps.isDebug, true);
  assert.equal(first.systemProps.unknown, undefined);
  assert.equal(first.systemProps.osName, undefined);
  assert.throws(() => client.event(""));
  assert.throws(() => client.event("a@example.org"));
  const props = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`prop${i}`, i]),
  );
  const event = client.event(
    "bounded",
    { ...props, bad: Infinity },
    { path: "/user/a%40example.org", referrer: "https://192.168.1.1/private" },
  );
  assert.equal(Object.keys(event.props).length, 20);
  assert.equal(event.path, undefined);
  assert.equal(event.referrer, undefined);
  now = 1799999;
  assert.equal(client.event("active").sessionId, first.sessionId);
  now += 1800000;
  assert.notEqual(client.event("idle").sessionId, first.sessionId);
});

test("DNT and GPC suppress delivery without HTTP", async (t) => {
  const client = createClient({
    endpoint: "https://example.org",
    appKey: "key",
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    throw new Error("unexpected network");
  });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    for (const navigator of [
      { doNotTrack: "1" },
      { doNotTrack: "yes" },
      { globalPrivacyControl: true },
    ]) {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: navigator,
      });
      assert.deepEqual(await client.track("private"), { accepted: 0 });
    }
    assert.equal(calls, 0);
  } finally {
    Object.defineProperty(globalThis, "navigator", descriptor);
  }
});

test("rejects redirects, malformed, oversized and truncated ACKs with a total body timeout", async () => {
  let mode = "redirect";
  let redirected = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    if (req.url === "/redirected") {
      redirected++;
      res.end("{}");
      return;
    }
    if (mode === "redirect") {
      res.writeHead(307, { Location: "/redirected" });
      res.end();
    }
    if (mode === "invalid") res.end('{"accepted":2}');
    if (mode === "boolean") res.end('{"accepted":true}');
    if (mode === "oversize") res.end(" ".repeat(1025));
    if (mode === "truncated") {
      res.writeHead(200, { "Content-Length": "200" });
      res.end('{"accepted":1}');
    }
    if (mode === "slow") {
      res.writeHead(200);
      res.write("{");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = createClient({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    appKey: "key",
    timeoutMs: 100,
  });
  try {
    const event = client.event("test");
    for (mode of [
      "redirect",
      "invalid",
      "boolean",
      "oversize",
      "truncated",
      "slow",
    ]) {
      const start = performance.now();
      await assert.rejects(
        client.send(event),
        (error) => error.name === "DeliveryError",
      );
      assert(performance.now() - start < 1000, `deadline exceeded for ${mode}`);
    }
    assert.equal(redirected, 0);
    await assert.rejects(client.send({ ...event }), TypeError);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
