// The Capstan REST client (spec 13.1). Every write endpoint returns unsigned payloads; nothing sent here ever holds a
// key. Error bodies { error: { code, message, receiptId? } } become SdkError API_ERROR with the server code (a
// server POLICY_BREACH stays POLICY_BREACH). 429 VENUE_RATE_LIMITED with Retry-After is retried (RateLimitRetry).
// Auth: each call may pass an `auth` hook that returns headers for the exact request (the owner_sig headers sign the
// method, the API's own path with its query, and the sha256 of the raw body; DECISIONS #125).
import { SdkError } from "./errors";

/** What a request auth hook signs: the method, the API path from /v1 with the query as sent, and the raw body. */
export interface ApiRequest {
  method: "GET" | "POST";
  signedPath: string;
  rawBody: string;
}
export type RequestAuth = (r: ApiRequest) => Promise<Record<string, string>>;

export interface ApiCallOptions {
  auth?: RequestAuth;
  /** Epoch ms. No rate-limit wait may end at or after it (a relay submit passes its build's expiresAt). */
  deadline?: number;
}

export interface Api {
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>, o?: ApiCallOptions): Promise<T>;
  post<T>(path: string, body: unknown, o?: ApiCallOptions): Promise<T>;
  readonly host: string;
}

/**
 * VENUE_RATE_LIMITED retries. The API fails a venue budget wait fast with 429 and Retry-After (gate-r4 G4-01); the
 * SDK waits the server's delay and sends again. A 429 VENUE_RATE_LIMITED means nothing reached the venue (the relay
 * releases the order row before it answers), so the same signed body is safe to send again. Auth headers are made
 * fresh for every attempt. No Retry-After, a delay over maxWaitMs in total, or one past the call's deadline: the
 * error goes to the caller at once, with retryAfterMs set when the server named a delay.
 */
export interface RateLimitRetry {
  /** Retries after the first attempt (default 2; 0 turns retries off). */
  maxRetries?: number;
  /** Most time spent waiting across one call's retries, in ms (default 10,000). */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
export const RATE_LIMIT_RETRY_DEFAULTS = { maxRetries: 2, maxWaitMs: 10_000 } as const;

/** Retry-After as ms: delta seconds or an HTTP date. null when absent or unreadable. */
export function retryAfterMs(v: string | null, nowMs: number): number | null {
  if (v === null) return null;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1_000;
  const d = Date.parse(t);
  return Number.isFinite(d) ? Math.max(0, d - nowMs) : null;
}

type ErrorBodyIn = { error?: { code?: string; message?: string; receiptId?: string } } | null;

// The server's POLICY_BREACH (build refusal or the relay's re-check) is the same refusal the local policy check
// raises, so it keeps that code; the message names the field as "(field)".
function errorOf(status: number, body: ErrorBodyIn, retryAfter: number | null): SdkError {
  const e = body?.error;
  const serverCode = e?.code ?? String(status);
  const opts = { serverCode, status, ...(e?.receiptId ? { receiptId: e.receiptId } : {}), ...(retryAfter !== null ? { retryAfterMs: retryAfter } : {}) };
  if (serverCode === "POLICY_BREACH") {
    const field = /\(([A-Za-z0-9_]+)\)\.?$/.exec(e?.message ?? "")?.[1];
    return new SdkError("POLICY_BREACH", e?.message ?? "the agent policy refuses the order", { ...opts, ...(field ? { field } : {}) });
  }
  return new SdkError("API_ERROR", e?.message ?? `HTTP ${status}`, opts);
}

export function createApi(apiBase: string, f: typeof fetch, defaults: { headers?: () => Record<string, string>; retry?: RateLimitRetry | false } = {}): Api {
  const base = apiBase.replace(/\/$/, "");
  const url = new URL(base);
  const v1 = /\/v1$/.test(url.pathname) ? base : `${base}/v1`;
  const rt = defaults.retry === false ? { maxRetries: 0, maxWaitMs: 0 } : { ...RATE_LIMIT_RETRY_DEFAULTS, ...(defaults.retry ?? {}) };
  const sleep = (defaults.retry && defaults.retry.sleep) || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = (defaults.retry && defaults.retry.now) || Date.now;
  const readBody = async (r: Response): Promise<unknown> => {
    const text = await r.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  async function send<T>(attempt: () => Promise<Response>, o?: ApiCallOptions): Promise<T> {
    let waited = 0;
    for (let n = 0; ; n++) {
      const r = await attempt();
      const body = await readBody(r);
      if (r.ok) return body as T;
      const code = (body as ErrorBodyIn)?.error?.code;
      const wait = r.status === 429 ? retryAfterMs(r.headers.get("retry-after"), now()) : null;
      const fits = wait !== null && n < rt.maxRetries && waited + wait <= rt.maxWaitMs && (o?.deadline === undefined || now() + wait < o.deadline);
      if (code === "VENUE_RATE_LIMITED" && fits) {
        await sleep(wait);
        waited += wait;
        continue;
      }
      throw errorOf(r.status, body as ErrorBodyIn, wait);
    }
  }
  // the signed path is the API's own path (from /v1), even when this base serves the API under a prefix
  const signedPathOf = (u: URL) => `/v1${u.pathname.slice(new URL(v1).pathname.length)}${u.search}`;
  async function headersFor(req: ApiRequest, o?: ApiCallOptions): Promise<Record<string, string>> {
    return { ...(defaults.headers?.() ?? {}), ...(o?.auth ? await o.auth(req) : {}) };
  }
  return {
    host: url.host.toLowerCase(),
    async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>, o?: ApiCallOptions) {
      const u = new URL(`${v1}${path}`);
      for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
      return send<T>(async () => {
        const h = await headersFor({ method: "GET", signedPath: signedPathOf(u), rawBody: "" }, o);
        return f(u.toString(), { method: "GET", headers: { accept: "application/json", ...h } });
      }, o);
    },
    async post<T>(path: string, body: unknown, o?: ApiCallOptions) {
      const u = new URL(`${v1}${path}`);
      const raw = JSON.stringify(body);
      return send<T>(async () => {
        const h = await headersFor({ method: "POST", signedPath: signedPathOf(u), rawBody: raw }, o);
        return f(u.toString(), { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...h }, body: raw });
      }, o);
    },
  };
}
