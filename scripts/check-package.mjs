import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const temp = path.join(root, "_temp", "package-check");
await mkdir(temp, { recursive: true });
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const report = JSON.parse(
  run("pnpm", ["pack", "--json", "--use-stderr", "--pack-destination", temp]),
);
const files = new Set(report.files.map((file) => file.path));
for (const name of [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/website.js",
  "dist/website.d.ts",
  "dist/halflime.min.js",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
])
  assert(files.has(name), name);
for (const name of files)
  assert(!/^(src|test|_temp|node_modules)\//.test(name), name);
const consumer = path.join(temp, "consumer");
await mkdir(consumer, { recursive: true });
await writeFile(
  path.join(consumer, "package.json"),
  '{"type":"module","private":true}',
);
run(
  "pnpm",
  ["add", "--ignore-workspace", "--ignore-scripts", report.filename],
  consumer,
);
await writeFile(
  path.join(consumer, "check.mjs"),
  `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
let calls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => { calls++; return originalFetch(...args); };
const sdk = await import('@halflime/javascript');
const website = await import('@halflime/javascript/website');
assert.deepEqual(Object.keys(sdk).sort(), ['DeliveryError', 'createClient']);
assert.deepEqual(Object.keys(website).sort(), ['initWebsite', 'pageview']);
assert.equal(calls, 0);
let wire;
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  wire = JSON.parse(body);
  res.end('{"accepted":1}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const client = sdk.createClient({ endpoint: 'http://127.0.0.1:' + server.address().port, appKey: 'key' });
  assert.equal((await client.track('packed_sdk')).accepted, 1);
  assert.equal(wire[0].eventName, 'packed_sdk');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log('Packed ESM exports, side-effect-free imports and loopback HTTP: passed');
`,
);
await writeFile(
  path.join(consumer, "types.ts"),
  `
import { createClient, DeliveryError, type Client, type Config, type Event, type Props, type SystemProps, type EventOptions, type Acknowledgment } from '@halflime/javascript';
import { pageview, initWebsite } from '@halflime/javascript/website';
const systemProps: SystemProps = { isDebug: false };
const config: Config = { endpoint: 'https://example.org', appKey: 'public', systemProps };
const client: Client = createClient(config);
const props: Props = { plan: 'free' };
const options: EventOptions = { path: '/route' };
const event: Event = client.event('typed', props, options);
const ack: Promise<Acknowledgment> = client.send(event);
void [ack, DeliveryError, pageview, initWebsite];
`,
);
for (const name of [
  "index.js",
  "index.d.ts",
  "website.js",
  "website.d.ts",
  "halflime.min.js",
]) {
  assert.equal(
    await readFile(
      path.join(consumer, "node_modules/@halflime/javascript/dist", name),
      "utf8",
    ),
    await readFile(path.join(root, "dist", name), "utf8"),
  );
}
const license = await readFile(
  path.join(consumer, "node_modules/@halflime/javascript/LICENSE"),
  "utf8",
);
assert(license.startsWith("Copyright 2026 Alex Zappa (FreshJuice)"));
assert(license.includes("END OF TERMS AND CONDITIONS"));
assert(license.length > 11000);
console.log(run(process.execPath, ["check.mjs"], consumer).trim());
run(process.execPath, [
  path.join(root, "node_modules/typescript/bin/tsc"),
  "--noEmit",
  "--strict",
  "--target",
  "ES2022",
  "--module",
  "NodeNext",
  "--moduleResolution",
  "NodeNext",
  path.join(consumer, "types.ts"),
]);
console.log(
  `Packed declarations: passed; archive ${path.basename(report.filename)}; ${files.size} files`,
);
