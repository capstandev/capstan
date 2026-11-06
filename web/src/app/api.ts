// The dashboard's own API calls: public reads, owner-signed reads (purpose read: positions, risk) and owner-signed
// requests (purpose api_request, DECISIONS #125: receipts listing, spread plans and events). The signature is the
// Capstan message signed by the main wallet; the dashboard never builds a venue payload here.
import { capstanMessage, type Hex, type SignedPurpose, type WalletSigner } from "../lib/capstan";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export interface DashApi {
  readonly base: string;
  readonly host: string;
  get<T>(pathWithQuery: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  /** GET with the owner's read signature (purpose read, body `GET <path?query>`). */
  readGet<T>(pathWithQuery: string): Promise<T>;
  /** A request with the owner's api_request signature (body `<METHOD> <path?query> <sha256(raw body)>`). */
  signed<T>(method: "GET" | "POST", pathWithQuery: string, body?: unknown): Promise<T>;
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const nonce = () => hex(crypto.getRandomValues(new Uint8Array(12)));
const sha256Hex = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

export function createDashApi(o: { apiBase: string; fetch: typeof fetch; wallet: WalletSigner | null; owner: Hex | null; chainId: number; now: () => number }): DashApi {
  const base = o.apiBase.replace(/\/$/, "");
  const url = new URL(base);
  const host = url.host.toLowerCase();

  async function parse<T>(r: Response): Promise<T> {
    const text = await r.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!r.ok) {
      const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(e?.message ?? `The API answered with status ${r.status}.`, r.status, e?.code ?? null);
    }
    return body as T;
  }

  async function sign(purpose: SignedPurpose, bodyText: string): Promise<Record<string, string>> {
    if (!o.wallet || !o.owner) throw new ApiError("Connect your wallet to do this.", 401, "UNAUTHORIZED");
    const issuedAt = o.now();
    const text = capstanMessage({ purpose, owner: o.owner, host, chainId: o.chainId, nonce: nonce(), issuedAt, expiresAt: issuedAt + 4 * 60_000, body: bodyText });
    const sig = await o.wallet.signMessage(text);
    return { "x-capstan-message": b64(text), "x-capstan-signature": sig };
  }

  // the signed path is the API's own path (it starts at /v1 even when this host serves the API under a prefix)
  const apiPath = (p: string) => `/v1${p}`;

  return {
    base,
    host,
    async get<T>(p: string) {
      return parse<T>(await o.fetch(`${base}${p}`, { headers: { accept: "application/json" } }));
    },
    async post<T>(p: string, body: unknown) {
      return parse<T>(await o.fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) }));
    },
    async readGet<T>(p: string) {
      const h = await sign("read", `GET ${apiPath(p)}`);
      return parse<T>(await o.fetch(`${base}${p}`, { headers: { accept: "application/json", ...h } }));
    },
    async signed<T>(method: "GET" | "POST", p: string, body?: unknown) {
      const raw = method === "GET" || body === undefined ? "" : JSON.stringify(body);
      const h = await sign("api_request", `${method} ${apiPath(p)} ${await sha256Hex(raw)}`);
      return parse<T>(await o.fetch(`${base}${p}`, { method, headers: { accept: "application/json", ...(raw ? { "content-type": "application/json" } : {}), ...h }, ...(raw ? { body: raw } : {}) }));
    },
  };
}
