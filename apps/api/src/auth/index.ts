// Route auth (spec 13, audit API-2, SIG-1). One verifier per RouteSpec.auth kind; the mount refuses a route without
// one (deny by default) and a kind with no verifier answers 401.
// - owner_sig: the 01 capstanMessage with purpose `api_request`, body `<METHOD> <path?query> <sha256(raw body)>`, in the
//   headers x-capstan-message (base64 of the text) and x-capstan-signature, signed by the owner the request names or by
//   one of its active agents; at most 5 minutes valid; a nonce is used once (10 minute cache). Routes whose handler
//   checks its own purpose-bound signature (reads, kills, policy, webhooks, API key creation, spread acks) are listed in
//   SELF_VERIFIED: the gate lets them through to that check, and a test proves each handler really makes it.
// - api_key: `Authorization: Bearer cpst_...`, argon2id verify (todo 34), cached 60 s by key hash.
// - x402: the payment middleware (todo 33) runs on these routes; an API key holder with credits pays from credits.
// - internal: a shared token header for ops callers on the host only.
import { bodyHash, parseCapstanMessage, verifyCapstanMessage, type NonceStore, type RouteAuth, type RouteSpec } from "@capstan/core";
import { errorBody, type Hex } from "@capstan/schema";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { AuthVerifier } from "../app";

export const MESSAGE_HEADER = "x-capstan-message";
export const SIGNATURE_HEADER = "x-capstan-signature";
export const INTERNAL_HEADER = "x-capstan-internal";
export const API_KEY_CACHE_MS = 60_000;
export const NONCE_TTL_MS = 10 * 60_000;

/** owner_sig routes whose handler verifies a purpose-bound signature itself (route key -> what it checks). */
export const SELF_VERIFIED: Record<string, string> = {
  "GET /positions": "read signature (ownerReadGate)",
  "GET /risk": "read signature (verifyOwnerRead)",
  "GET /alerts/webhooks": "read signature (verifyOwnerRead)",
  "POST /alerts/webhooks": "webhook_register signature (registerWebhook)",
  "DELETE /alerts/webhooks/:id": "webhook_register signature (removeWebhook)",
  "POST /agents/policy": "CapstanAgentPolicy EIP-712 signature (storePolicy)",
  "POST /agents/:agentRef/kill": "kill signature by the owner or the agent (verifyKillAuth)",
  "POST /account/keys": "api_key_create signature (createApiKey)",
  "POST /spreads/:id/ack": "spread_ack signature (ack)",
};

/**
 * SELF_VERIFIED routes where the handler's signature is the ONLY authority, so the gate never looks at request
 * signature headers: the kill (spec 7.6: the owner's signature, or the agent itself for self-halt). Re-checking an
 * api_request header there could only refuse a valid kill, e.g. an agent retrying its own halt after the first one
 * already moved it out of the active set. The handler (verifyKillAuth) admits the owner and the agent, nobody else.
 */
export const HANDLER_ONLY_AUTH: ReadonlySet<string> = new Set(["POST /agents/:agentRef/kill"]);

export const routeKey = (s: Pick<RouteSpec, "method" | "path">) => `${s.method} ${s.path}`;

/** The text an api_request signature binds: method, path with query, and the sha256 of the raw body. */
export const apiRequestBody = (method: string, pathWithQuery: string, rawBody: string) => `${method.toUpperCase()} ${pathWithQuery} ${createHash("sha256").update(rawBody).digest("hex")}`;

const ctxSet = (c: Context, k: string, v: unknown): void => (c as unknown as { set(k: string, v: unknown): void }).set(k, v);
const ADDR = /^0x[0-9a-fA-F]{40}$/;

async function rawBody(c: Context): Promise<string> {
  if (c.req.method === "GET" || c.req.method === "HEAD") return "";
  try {
    return await c.req.text();
  } catch {
    return "";
  }
}

/** The owner a request names: ?owner= first, then the JSON body's owner. */
export async function namedOwner(c: Context, raw: string): Promise<Hex | null> {
  const q = c.req.query("owner");
  if (q && ADDR.test(q)) return q.toLowerCase() as Hex;
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as { owner?: unknown };
    return typeof b?.owner === "string" && ADDR.test(b.owner) ? (b.owner.toLowerCase() as Hex) : null;
  } catch {
    return null;
  }
}

export interface OwnerSigDeps {
  nonces: NonceStore;
  host: string;
  /** Active agents of an owner (secp agent addresses with their agentRef). */
  agentsOf(owner: Hex): Promise<{ address: Hex; agentRef: string }[]>;
  now?: () => number;
}

const unauthorized = (c: Context, why: string) => c.json(errorBody("UNAUTHORIZED", `A valid owner signature is required (${why}).`), 401);

export function ownerSigVerifier(deps: OwnerSigDeps): AuthVerifier {
  return async (c, spec) => {
    if (HANDLER_ONLY_AUTH.has(routeKey(spec))) return null;
    const b64 = c.req.header(MESSAGE_HEADER);
    const sig = c.req.header(SIGNATURE_HEADER);
    if (!b64 || !sig) return SELF_VERIFIED[routeKey(spec)] ? null : unauthorized(c, "missing");
    let text: string;
    try {
      text = Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return unauthorized(c, "format");
    }
    const parsed = parseCapstanMessage(text);
    if (!parsed) return unauthorized(c, "format");
    // a purpose-bound read signature on a self-verified route is the handler's to check (one nonce, one check)
    if (parsed.purpose !== "api_request") return SELF_VERIFIED[routeKey(spec)] ? null : unauthorized(c, "purpose");
    const raw = await rawBody(c);
    const owner = (await namedOwner(c, raw)) ?? (parsed.owner.toLowerCase() as Hex);
    if (parsed.owner.toLowerCase() !== owner) return unauthorized(c, "signer");
    const u = new URL(c.req.url);
    const agents = await deps.agentsOf(owner);
    const r = await verifyCapstanMessage(text, sig as Hex, { purpose: "api_request", signers: [owner, ...agents.map((a) => a.address)], host: deps.host, nowMs: (deps.now ?? Date.now)(), body: apiRequestBody(c.req.method, `${u.pathname}${u.search}`, raw) }, deps.nonces);
    if (!r.ok) return unauthorized(c, r.reason);
    ctxSet(c, "owner", owner);
    ctxSet(c, "signer", r.signer.toLowerCase());
    const agent = agents.find((a) => a.address.toLowerCase() === r.signer.toLowerCase());
    if (agent) ctxSet(c, "agentRef", agent.agentRef);
    ctxSet(c, "authKind", "owner_sig");
    return null;
  };
}

export interface ApiKeyDeps {
  verify(presented: string): Promise<{ id: string; ownerWallet: string | null; tier: string } | null>;
  now?: () => number;
}

export const bearerOf = (c: Context): string | null => {
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
};

/** API key check with a 60 s cache keyed by the key's sha256 (a revoked key stops within a minute). */
export function apiKeyCheck(deps: ApiKeyDeps): (presented: string) => Promise<{ id: string; ownerWallet: string | null; tier: string } | null> {
  const cache = new Map<string, { at: number; v: { id: string; ownerWallet: string | null; tier: string } | null }>();
  const now = deps.now ?? Date.now;
  return async (presented) => {
    const k = createHash("sha256").update(presented).digest("hex");
    const hit = cache.get(k);
    if (hit && now() - hit.at < API_KEY_CACHE_MS) return hit.v;
    const v = await deps.verify(presented);
    if (cache.size > 10_000) cache.clear();
    cache.set(k, { at: now(), v });
    return v;
  };
}

export function apiKeyVerifier(check: ReturnType<typeof apiKeyCheck>): AuthVerifier {
  return async (c) => {
    const key = bearerOf(c);
    if (!key) return c.json(errorBody("UNAUTHORIZED", "A Capstan API key is required."), 401);
    const acct = await check(key);
    if (!acct) return c.json(errorBody("UNAUTHORIZED", "The API key is not valid."), 401);
    ctxSet(c, "apiKeyId", acct.id);
    ctxSet(c, "apiKeyOwner", acct.ownerWallet);
    ctxSet(c, "authKind", "api_key");
    return null;
  };
}

export interface X402AuthDeps {
  check: ReturnType<typeof apiKeyCheck>;
  /** The MCP server's token: set when the MCP server already took the x402 payment for a paid tool (32+ chars). */
  internalToken?: string;
  /** Spend credits for one call (todo 34 spendCredit); false when the balance is too low. */
  spend(accountId: string, route: string, usd: string): Promise<boolean>;
}

/** x402 routes: an API key with enough credits pays from credits; anyone else goes to the payment middleware. */
export function x402Verifier(deps: X402AuthDeps | null): AuthVerifier {
  return async (c, spec) => {
    const internal = c.req.header(INTERNAL_HEADER);
    if (internal && deps?.internalToken && deps.internalToken.length >= 32) {
      const a = Buffer.from(internal);
      const b = Buffer.from(deps.internalToken);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        ctxSet(c, "x402PaidBy", "internal");
        return null;
      }
    }
    const key = bearerOf(c);
    if (key && deps && spec.priced && !(spec.priced as { perRows?: number }).perRows) {
      const acct = await deps.check(key);
      if (acct && (await deps.spend(acct.id, routeKey(spec), spec.priced.usd))) {
        ctxSet(c, "apiKeyId", acct.id);
        ctxSet(c, "x402PaidBy", "credits");
      }
    }
    return null;
  };
}

export function internalVerifier(token: string | undefined): AuthVerifier {
  return (c) => {
    const got = c.req.header(INTERNAL_HEADER) ?? "";
    if (!token || token.length < 32) return c.json(errorBody("UNAUTHORIZED"), 401);
    const a = Buffer.from(got);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b) ? null : c.json(errorBody("UNAUTHORIZED"), 401);
  };
}

export type Verifiers = Partial<Record<RouteAuth, AuthVerifier>>;
export { bodyHash };
