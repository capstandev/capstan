// The Capstan REST client (spec 13.1). Every write endpoint returns unsigned payloads; nothing sent here ever holds a
// key. Error bodies { error: { code, message, receiptId? } } become SdkError API_ERROR with the server code.
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
}

export interface Api {
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>, o?: ApiCallOptions): Promise<T>;
  post<T>(path: string, body: unknown, o?: ApiCallOptions): Promise<T>;
  readonly host: string;
}

export function createApi(apiBase: string, f: typeof fetch, defaults: { headers?: () => Record<string, string> } = {}): Api {
  const base = apiBase.replace(/\/$/, "");
  const url = new URL(base);
  const v1 = /\/v1$/.test(url.pathname) ? base : `${base}/v1`;
  async function parse<T>(r: Response): Promise<T> {
    const text = await r.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!r.ok) {
      const e = (body as { error?: { code?: string; message?: string; receiptId?: string } } | null)?.error;
      throw new SdkError("API_ERROR", e?.message ?? `HTTP ${r.status}`, { serverCode: e?.code ?? String(r.status), status: r.status, ...(e?.receiptId ? { receiptId: e.receiptId } : {}) });
    }
    return body as T;
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
      const h = await headersFor({ method: "GET", signedPath: signedPathOf(u), rawBody: "" }, o);
      return parse<T>(await f(u.toString(), { method: "GET", headers: { accept: "application/json", ...h } }));
    },
    async post<T>(path: string, body: unknown, o?: ApiCallOptions) {
      const u = new URL(`${v1}${path}`);
      const raw = JSON.stringify(body);
      const h = await headersFor({ method: "POST", signedPath: signedPathOf(u), rawBody: raw }, o);
      return parse<T>(await f(u.toString(), { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...h }, body: raw }));
    },
  };
}
