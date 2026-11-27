# HalfLime JavaScript SDK

Send app events and website pageviews to [your own HalfLime instance](https://github.com/halflime/halflime). The SDK ships as ES modules for browsers and Node.js 22+, with no runtime dependencies. Importing it does not start tracking.

## Install from source

Run `pnpm install --frozen-lockfile` and `pnpm pack` in this checkout. Then, from your app, install the tarball (adjust the path if the directories aren't next to each other):

```sh
pnpm add ../halflime-javascript/halflime-javascript-1.0.0.tgz
```

## Count an export

Create an `app` project on your collector and include `format` in its `properties` list. Use the Worker's origin and the project's public `appKey` below. Keep the instance admin token out of your app.

```js
import { createClient } from "@halflime/javascript";

const analytics = createClient({
  endpoint: "https://analytics.example.org",
  appKey: "YOUR_PUBLIC_APP_KEY",
});

const ack = await analytics.track("export_finished", { format: "pdf" });
console.log(ack.accepted);
```

Call `track` after the export succeeds. An `accepted` count of `1` means the collector stored it. To check the report, call `get_breakdown` on your instance with the project ID, a time range covering the send, and `dimension: "prop:format"`. Look for the `pdf` row. The collector discards custom properties you didn't allow on the project.

## Website integration

For a website project, allow the site's exact origin on the collector and use that project's app key. To count a page without sending a customer's ID in the URL, pass a route template:

```js
import { pageview } from "@halflime/javascript/website";

await pageview(analytics, { path: "/accounts/:accountId" });
```

For a site with public paths, `initWebsite` records the first pageview and subsequent pathname changes. Start it only after any required consent:

```js
import { initWebsite } from "@halflime/javascript/website";

const cleanup = initWebsite({
  endpoint: "https://analytics.example.org",
  appKey: "YOUR_PUBLIC_APP_KEY",
  onError: (error) => console.error(error),
});
```

Call `cleanup()` to stop future pageviews. Use one tracker per window. Changes to just the query or fragment don't count as new pages.

Alternatively, copy `dist/halflime.min.js` from the built package to your own site and load it as a classic script:

```html
<script
  defer
  src="/halflime.min.js"
  data-endpoint="https://analytics.example.org"
  data-app-key="YOUR_PUBLIC_APP_KEY"
></script>
```

The script starts tracking when it loads; `window.HalfLime.cleanup()` stops it. Use HTTPS outside localhost. If you set a Content Security Policy, allow the collector in `connect-src` and the script location in `script-src`.

## If a send times out

The collector may have stored the event even if the reply never arrived. If you need retries, create the event with `const event = analytics.event("export_finished", { format: "pdf" })` and call `await analytics.send(event)` on each attempt using the same client. A second call to `track` creates a new ID and could count the export twice.

The SDK doesn't retry or queue events. The default timeout is 10 seconds. A `DeliveryError` has a `status` if the collector returned an HTTP error. An `accepted` count of `0` means either the collector already had the event or a browser privacy signal prevented the send.

## Sessions and privacy

The SDK keeps its session ID in memory. A new client, a page reload, or 30 minutes without a new event starts a new session. Session counts don't tell you how many people visited. Browser requests omit cookies and the HTTP referrer header, and skip delivery when Do Not Track or Global Privacy Control is enabled.

The website tracker strips queries and fragments, but a name can still appear in a pathname. Use manual `pageview` calls on those routes. Keep filenames, account IDs and free text out of event properties. See the [collector API](https://github.com/halflime/halflime/blob/main/docs/api.md) for fields and limits.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm run format:check
pnpm run check:package
```

## License

Copyright 2026 [Alex Zappa](https://alex.zappa.dev/) ([FreshJuice](https://freshjuice.dev/)). Licensed under [Apache-2.0](LICENSE).
