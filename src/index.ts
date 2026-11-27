export type Props = Readonly<Record<string, string | number | boolean>>;
export type SystemProps = Readonly<{
  appVersion?: string;
  appBuildNumber?: string;
  osName?: string;
  osVersion?: string;
  locale?: string;
  deviceModel?: string;
  isDebug?: boolean;
}>;
export type EventOptions = Readonly<{ path?: string; referrer?: string }>;
export type Event = Readonly<{
  eventId: string;
  timestamp: string;
  sessionId: string;
  eventName: string;
  systemProps: SystemProps & { readonly sdkVersion: string };
  props: Props;
  path?: string;
  referrer?: string;
}>;
export type Acknowledgment = Readonly<{ accepted: number }>;
export type Config = Readonly<{
  endpoint: string;
  appKey: string;
  systemProps?: SystemProps;
  timeoutMs?: number;
}>;
export type Client = Readonly<{
  event(name: string, props?: Props, options?: EventOptions): Event;
  send(event: Event): Promise<Acknowledgment>;
  track(
    name: string,
    props?: Props,
    options?: EventOptions,
  ): Promise<Acknowledgment>;
}>;

const sensitiveName =
  /email|phone|password|secret|token|credential|authorization|cookie|address|user.?id|session.?id|ip.?address|^ip$|^name$/i;
const sensitiveValue =
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]*|bearer\s|(?:sk|pk|ghp|github_pat|AKIA)[_-][a-z0-9]{8,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+|(?:password|token|secret|api.?key)\s*[:=]/i;
const safeString = (value: string) =>
  !sensitiveValue.test(value) && !/[\x00-\x1f\x7f]/.test(value);

export class DeliveryError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

export function createClient(config: Config): Client {
  if (
    !/^https?:\/\/[^/?#\\\s]+(?:\/|\/api\/v1\/events)?$/i.test(config.endpoint)
  )
    throw new TypeError("Invalid endpoint");
  const url = new URL(config.endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/api/v1/events"].includes(url.pathname)
  )
    throw new TypeError(
      "endpoint must be an HTTP(S) origin or /api/v1/events URL",
    );
  url.pathname = "/api/v1/events";
  const endpoint = url.href;
  const appKey = config.appKey;
  if (typeof appKey !== "string" || !/^[\x21-\x7e]{1,200}$/.test(appKey))
    throw new TypeError(
      "appKey must be 1..200 printable non-space ASCII characters",
    );
  const timeoutMs = config.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new TypeError("timeoutMs must be 1..30000");
  const systemProps: Record<string, string | boolean> = {
    sdkVersion: "halflime-javascript@1.0.0",
  };
  for (const key of [
    "appVersion",
    "appBuildNumber",
    "osName",
    "osVersion",
    "locale",
    "deviceModel",
    "isDebug",
  ] as const) {
    const value = config.systemProps?.[key];
    if (
      key === "isDebug"
        ? typeof value === "boolean"
        : typeof value === "string" && value.length <= 100 && safeString(value)
    )
      systemProps[key] = value as string | boolean;
  }
  Object.freeze(systemProps);
  const bodies = new WeakMap<Event, string>();
  let sessionId = "";
  let lastActivity = -Infinity;
  const client: Client = Object.freeze({
    event(name: string, props: Props = {}, options: EventOptions = {}): Event {
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 100 ||
        !safeString(name)
      )
        throw new TypeError("Invalid event name");
      const now = performance.now();
      if (now - lastActivity >= 1800000) sessionId = crypto.randomUUID();
      lastActivity = now;
      const cleanProps = Object.freeze(
        Object.fromEntries(
          Object.entries(props)
            .filter(
              ([key, value]) =>
                /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) &&
                !sensitiveName.test(key) &&
                (typeof value === "boolean" ||
                  (typeof value === "number" && Number.isFinite(value)) ||
                  (typeof value === "string" &&
                    value.length <= 200 &&
                    safeString(value))),
            )
            .slice(0, 20),
        ),
      );
      const event: Event = Object.freeze({
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId,
        eventName: name,
        systemProps: systemProps as Event["systemProps"],
        props: cleanProps,
        ...sanitizeUrls(options),
      });
      const body = JSON.stringify([event]);
      if (new TextEncoder().encode(body).length > 65536)
        throw new TypeError("Event exceeds 64 KiB");
      bodies.set(event, body);
      return event;
    },
    async send(event: Event): Promise<Acknowledgment> {
      const body = bodies.get(event);
      if (!body) throw new TypeError("Use an event created by this client");
      if (
        typeof navigator !== "undefined" &&
        (navigator.doNotTrack === "1" ||
          navigator.doNotTrack === "yes" ||
          (navigator as Navigator & { globalPrivacyControl?: boolean })
            .globalPrivacyControl === true)
      )
        return Object.freeze({ accepted: 0 });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "App-Key": appKey },
          body,
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          throw new DeliveryError(
            "HalfLime rejected the event",
            response.status,
          );
        }
        const reader = response.body?.getReader();
        if (!reader) throw new DeliveryError("Invalid acknowledgment");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 1024) {
              void reader.cancel().catch(() => {});
              throw new DeliveryError("Acknowledgment exceeds 1 KiB");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        const ack: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(data),
        );
        if (
          !ack ||
          typeof ack !== "object" ||
          !("accepted" in ack) ||
          !Number.isInteger(ack.accepted) ||
          (ack.accepted !== 0 && ack.accepted !== 1)
        )
          throw new DeliveryError("Invalid acknowledgment");
        return Object.freeze({ accepted: ack.accepted });
      } catch (error) {
        if (error instanceof DeliveryError) throw error;
        throw new DeliveryError(
          controller.signal.aborted ? "Delivery timed out" : "Delivery failed",
        );
      } finally {
        clearTimeout(timer);
      }
    },
    track(
      name: string,
      props?: Props,
      options?: EventOptions,
    ): Promise<Acknowledgment> {
      return client.send(client.event(name, props, options));
    },
  });
  return client;
}

function sanitizeUrls(options: EventOptions): EventOptions {
  const result: { path?: string; referrer?: string } = {};
  try {
    if (options.path) {
      const url = new URL(options.path, "https://halflime.invalid");
      if (
        ["http:", "https:"].includes(url.protocol) &&
        safeString(decodeURIComponent(url.pathname))
      )
        result.path = url.pathname.slice(0, 512);
    }
  } catch {}
  try {
    if (options.referrer) {
      const url = new URL(options.referrer);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        safeString(url.hostname)
      )
        result.referrer = url.origin;
    }
  } catch {}
  return result;
}
