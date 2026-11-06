// The typed client the MCP tools call: the public Capstan API (todo 29), nothing else. Tools hold no business logic of
// their own; they pass inputs to these calls and return the API's answer. The caller's Capstan API key (bearer) and the
// owner's read signature headers are forwarded as given. The MCP server never holds or receives a key.
export interface ApiAnswer {
  status: number;
  body: unknown;
  headers: Headers;
}

export interface CallAuth {
  /** The MCP client's Authorization header (a Capstan API key), forwarded to the API. */
  bearer?: string;
  /** Owner read signature for owner reads: the message text (base64) and the signature. */
  ownerRead?: { message: string; signature: string };
  /** x402 payment for a paid route (32): the PAYMENT-SIGNATURE header value. */
  payment?: string;
  /** Set only after the MCP server itself took the x402 payment for a paid tool: the internal caller token. */
  internal?: string;
  /** The MCP client's address, forwarded so eligibility decides on the caller, not on the MCP server. */
  clientIp?: string;
}

export interface CapstanApiClient {
  readonly base: string;
  get(path: string, query: Record<string, string | undefined>, auth?: CallAuth): Promise<ApiAnswer>;
  post(path: string, body: unknown, auth?: CallAuth): Promise<ApiAnswer>;
  delete?(path: string, body: unknown, auth?: CallAuth): Promise<ApiAnswer>;
}

/** Query strings are built in the order given, so an owner can sign the exact path the API will see. */
export function pathWithQuery(path: string, query: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export function httpApiClient(base: string, f: typeof fetch = fetch): CapstanApiClient {
  const root = base.replace(/\/+$/, "");
  const headersOf = (auth?: CallAuth, json = false): Record<string, string> => ({
    accept: "application/json",
    ...(json ? { "content-type": "application/json" } : {}),
    ...(auth?.bearer ? { authorization: auth.bearer } : {}),
    ...(auth?.ownerRead ? { "x-capstan-message": auth.ownerRead.message, "x-capstan-signature": auth.ownerRead.signature } : {}),
    ...(auth?.payment ? { "PAYMENT-SIGNATURE": auth.payment } : {}),
    ...(auth?.internal ? { "x-capstan-internal": auth.internal } : {}),
    ...(auth?.clientIp ? { "x-forwarded-for": auth.clientIp } : {}),
  });
  const read = async (r: Response): Promise<ApiAnswer> => {
    const text = await r.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: { code: "INTERNAL_ERROR", message: "The API answered with something that is not JSON." } };
    }
    return { status: r.status, body, headers: r.headers };
  };
  return {
    base: root,
    async get(path, query, auth) {
      return read(await f(`${root}${pathWithQuery(path, query)}`, { method: "GET", headers: headersOf(auth) }));
    },
    async post(path, body, auth) {
      return read(await f(`${root}${path}`, { method: "POST", headers: headersOf(auth, true), body: JSON.stringify(body) }));
    },
    async delete(path, body, auth) {
      return read(await f(`${root}${path}`, { method: "DELETE", headers: headersOf(auth, true), body: JSON.stringify(body) }));
    },
  };
}
