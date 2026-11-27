import {
  createClient,
  type Acknowledgment,
  type Client,
  type Config,
  type EventOptions,
} from "./index.js";

export function pageview(
  client: Client,
  options: EventOptions = {},
): Promise<Acknowledgment> {
  return client.track(
    "pageview",
    {},
    { path: window.location.pathname, referrer: document.referrer, ...options },
  );
}

const active = new WeakSet<Window>();

export function initWebsite(
  config: Config & { onError?: (error: unknown) => void },
): () => void {
  if (active.has(window))
    throw new Error("A HalfLime website tracker is already active");
  const client = createClient(config);
  let previous: string | undefined;
  const collect = () => {
    if (previous === window.location.pathname) return;
    previous = window.location.pathname;
    try {
      void pageview(client).catch(report);
    } catch (error) {
      report(error);
    }
  };
  const report = (error: unknown) => {
    try {
      if (config.onError) config.onError(error);
      else console.error("HalfLime pageview delivery failed");
    } catch {}
  };
  const push = window.history.pushState;
  const replace = window.history.replaceState;
  const pushState: History["pushState"] = function (this: History, ...args) {
    push.apply(this, args);
    collect();
  };
  const replaceState: History["replaceState"] = function (
    this: History,
    ...args
  ) {
    replace.apply(this, args);
    collect();
  };
  window.history.pushState = pushState;
  window.history.replaceState = replaceState;
  window.addEventListener("popstate", collect);
  active.add(window);
  collect();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (window.history.pushState === pushState) window.history.pushState = push;
    if (window.history.replaceState === replaceState)
      window.history.replaceState = replace;
    window.removeEventListener("popstate", collect);
    active.delete(window);
  };
}
