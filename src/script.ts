import { initWebsite } from "./website.js";

const script = document.currentScript as HTMLScriptElement | null;
const endpoint = script?.dataset.endpoint;
const appKey = script?.dataset.appKey;
let dispose: (() => void) | undefined;
if (endpoint && appKey) {
  try {
    dispose = initWebsite({ endpoint, appKey });
  } catch {
    console.error("HalfLime configuration is invalid");
  }
} else console.error("HalfLime requires data-endpoint and data-app-key");
export function cleanup(): void {
  dispose?.();
  dispose = undefined;
}
