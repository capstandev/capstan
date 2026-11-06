// happy-dom for the web tests. Bun's own fetch, Request, Response, Headers, WebCrypto and TextEncoder stay in place:
// happy-dom's fetch applies browser CORS rules to the local test stack, and the SDK needs real WebCrypto.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { syncGenerated } from "../scripts/sync-openapi";

const keep = ["fetch", "Request", "Response", "Headers", "crypto", "TextEncoder", "TextDecoder", "URL", "URLSearchParams", "AbortController", "AbortSignal", "Blob", "FormData", "ReadableStream", "WebSocket", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "structuredClone"] as const;
const saved: Record<string, unknown> = {};
for (const k of keep) saved[k] = (globalThis as Record<string, unknown>)[k];
GlobalRegistrator.register({ url: "http://127.0.0.1:22273/", width: 1280, height: 900 });
for (const k of keep) Object.defineProperty(globalThis, k, { value: saved[k], writable: true, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
syncGenerated();
