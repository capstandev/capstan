// The Capstan REST client (spec 13.1). Every write endpoint returns unsigned payloads; nothing sent here ever holds a
// key. Error bodies { error: { code, message, receiptId? } } become SdkError API_ERROR with the server code.
import { SdkError } from "./errors";

export interface Api {
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  readonly host: string;
}

export function createApi(apiBase: string, f: typeof fetch): Api {
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
  return {
    host: url.host.toLowerCase(),
    async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>) {
      const u = new URL(`${v1}${path}`);
      for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
      return parse<T>(await f(u.toString(), { method: "GET", headers: { accept: "application/json" } }));
    },
    async post<T>(path: string, body: unknown) {
      return parse<T>(await f(`${v1}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) }));
    },
  };
}
