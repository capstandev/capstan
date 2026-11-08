// Rate limits (spec 14, audit API-1, S-1, GEN-1): a sliding 60 s window per (route class, bucket) in Redis.
// Classes: read (GET and POST /quote) 120/min, build (/.../build) 30/min, write (other POST and DELETE) 20/min.
// Buckets: the IP (/32 or /64) for every request; the wallet only when the request was signed by that wallet or one of
// its active agents (owner_sig), so a stranger naming a victim's address never drains the victim's limits; the API key
// for api_key requests (an API key naming any owner spends its own bucket). Lock tiers multiply by 2 or 5, Pro by 5.
// Bounded amplification (API-3): /quote takes at most 10 market ids. A burst answers 429 with Retry-After.
// Redis down: writes and builds fail closed (503); reads fall back to an in-process window at the same caps.
import type { Redis, RouteSpec } from "@capstan/core";
import { ipBucket } from "@capstan/relay";
import { errorBody } from "@capstan/schema";
import type { Context, MiddlewareHandler } from "hono";

export type RouteClass = "read" | "build" | "write";
export const WINDOW_MS = 60_000;
export const BASE_LIMITS: Record<RouteClass, number> = { read: 120, build: 30, write: 20 };
export const QUOTE_MAX_MARKETS = 10;

export function classOf(spec: Pick<RouteSpec, "method" | "path">): RouteClass {
  if (spec.method === "GET" || spec.path === "/quote") return "read";
  if (spec.path.endsWith("/build")) return "build";
  return "write";
}

export interface WindowStore {
  /** Take one slot in every window or none; returns the index of the first full window and its wait in ms. */
  take(keys: { key: string; limit: number }[], nowMs: number): Promise<{ ok: true } | { ok: false; index: number; retryAfterMs: number }>;
}

export function memoryWindowStore(): WindowStore {
  const hits = new Map<string, number[]>();
  return {
    async take(keys, now) {
      const live = (k: string) => (hits.get(k) ?? []).filter((t) => t > now - WINDOW_MS);
      for (let i = 0; i < keys.length; i++) {
        const l = live(keys[i]!.key);
        if (l.length >= keys[i]!.limit) return { ok: false, index: i, retryAfterMs: Math.max(1, l[0]! + WINDOW_MS - now) };
      }
      for (const k of keys) hits.set(k.key, [...live(k.key), now]);
      if (hits.size > 50_000) for (const [k, v] of hits) if (!v.some((t) => t > now - WINDOW_MS)) hits.delete(k);
      return { ok: true };
    },
  };
}

const LUA = `
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
for i, k in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', k, '-inf', now - win)
  if redis.call('ZCARD', k) >= tonumber(ARGV[3 + i]) then
    local first = redis.call('ZRANGE', k, 0, 0, 'WITHSCORES')
    -- an empty window can be full (limit 0, the pre-auth probe key): retry after a whole window
    if first[2] == nil then return {i, win} end
    return {i, tonumber(first[2]) + win - now}
  end
end
for i, k in ipairs(KEYS) do
  redis.call('ZADD', k, now, ARGV[3])
  redis.call('PEXPIRE', k, win * 2)
end
return {0, 0}
`;

export function redisWindowStore(redis: Redis): WindowStore {
  let n = 0;
  return {
    async take(keys, now) {
      const member = `${now}:${process.pid}:${++n}`;
      const r = (await redis.eval(LUA, keys.length, ...keys.map((k) => k.key), String(now), String(WINDOW_MS), member, ...keys.map((k) => String(k.limit)))) as [number, number];
      return r[0] === 0 ? { ok: true } : { ok: false, index: r[0] - 1, retryAfterMs: Math.max(1, Number(r[1])) };
    },
  };
}

export interface LimiterDeps {
  store: WindowStore;
  /** In-process store for public reads while Redis is down. */
  fallback?: WindowStore;
  ipOf(c: Context): string;
  /** 1 (free), 2 (Lock Holder), 5 (Lock Whale or Pro) for the authenticated wallet or API key. */
  multiplier(subject: { owner?: string; apiKeyId?: string }): Promise<1 | 2 | 5>;
  limits?: Partial<Record<RouteClass, number>>;
  now?: () => number;
}

const ctxGet = (c: Context, k: string): unknown => (c as unknown as { get(k: string): unknown }).get(k);

/** Bounded amplification checks that need the request (body or query) before the handler runs. */
async function amplification(c: Context, spec: RouteSpec): Promise<Response | null> {
  if (spec.path !== "/quote") return null;
  let ids: unknown[] = [];
  if (c.req.method === "POST") {
    try {
      const b = (await c.req.json()) as { marketIds?: unknown };
      ids = Array.isArray(b?.marketIds) ? b.marketIds : [];
    } catch {
      ids = [];
    }
  } else {
    const q = c.req.queries("marketIds") ?? [];
    ids = q.flatMap((x) => x.split(",")).filter(Boolean);
  }
  return ids.length > QUOTE_MAX_MARKETS ? c.json(errorBody("INVALID_INPUT", `A quote takes at most ${QUOTE_MAX_MARKETS} market ids.`), 400) : null;
}

export function rateLimiter(deps: LimiterDeps): (spec: RouteSpec) => MiddlewareHandler {
  const fallback = deps.fallback ?? memoryWindowStore();
  const now = deps.now ?? Date.now;
  return (spec) => {
    const cls = classOf(spec);
    return async (c, next) => {
      const amp = await amplification(c, spec);
      if (amp) return amp;
      const authKind = ctxGet(c, "authKind");
      const owner = authKind === "owner_sig" ? (ctxGet(c, "owner") as string | undefined) : undefined;
      const apiKeyId = ctxGet(c, "apiKeyId") as string | undefined;
      const mult = owner || apiKeyId ? await deps.multiplier({ ...(owner ? { owner } : {}), ...(apiKeyId ? { apiKeyId } : {}) }) : 1;
      const limit = (deps.limits?.[cls] ?? BASE_LIMITS[cls]) * mult;
      const ip = ipBucket(deps.ipOf(c));
      const keys: { key: string; limit: number }[] = [];
      // the caller's own bucket: its wallet (signed), else its API key, else its IP
      if (owner) keys.push({ key: `rl:${cls}:w:${owner.toLowerCase()}`, limit });
      else if (apiKeyId) keys.push({ key: `rl:${cls}:k:${apiKeyId}`, limit });
      // every request also counts against its IP bucket (the read cap for reads, the class cap otherwise)
      keys.push({ key: `rl:${cls}:ip:${ip}`, limit: owner || apiKeyId ? limit * 4 : limit });
      let r: Awaited<ReturnType<WindowStore["take"]>>;
      try {
        r = await deps.store.take(keys, now());
      } catch {
        if (cls !== "read") return c.json(errorBody("INTERNAL_ERROR", "Rate limits cannot be checked right now; writes are paused."), 503);
        r = await fallback.take(keys, now());
      }
      if (!r.ok) {
        c.header("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)));
        return c.json(errorBody("VENUE_RATE_LIMITED", "Too many requests. Slow down and try again."), 429);
      }
      await next();
    };
  };
}

/** Failed auth answers (401) per IP bucket per minute before that IP is refused without running a verifier (r1 F1). */
export const AUTH_FAIL_PER_IP = 10;
/** The pre-auth IP cap: never tighter than the post-auth IP bucket of the highest tier (x5, x4), so it only stops floods. */
export const preAuthLimit = (cls: RouteClass, limits?: Partial<Record<RouteClass, number>>) => (limits?.[cls] ?? BASE_LIMITS[cls]) * 5 * 4;

export interface PreAuthDeps {
  store: WindowStore;
  fallback?: WindowStore;
  ipOf(c: Context): string;
  limits?: Partial<Record<RouteClass, number>>;
  now?: () => number;
}

/**
 * The cheap IP limiter that runs BEFORE authGate (security review r1 F1): a request that never authenticates still
 * spends an IP slot, and an IP whose requests failed auth AUTH_FAIL_PER_IP times in a minute gets 429 before any key
 * lookup, signature recovery or database read. The failure bucket counts a slot only for answers that were 401.
 */
export function preAuthLimiter(deps: PreAuthDeps): (spec: RouteSpec) => MiddlewareHandler {
  const fallback = deps.fallback ?? memoryWindowStore();
  const now = deps.now ?? Date.now;
  return (spec) => {
    const cls = classOf(spec);
    return async (c, next) => {
      const ip = ipBucket(deps.ipOf(c));
      const keys = [
        { key: `rl:pre:${cls}:ip:${ip}`, limit: preAuthLimit(cls, deps.limits) },
        // a zero-cost probe of the failure bucket: one slot more than it holds, taken only on a 401 below
        { key: `rl:authfail:ip:${ip}`, limit: AUTH_FAIL_PER_IP },
      ];
      // the failure bucket only refuses requests that carry credentials (a shared IP's anonymous reads keep working),
      // and never the kill route, whose own signature is the only authority (an owner must always be able to stop)
      const credentialed = !!(c.req.header("authorization") || c.req.header("x-api-key") || c.req.header("x-capstan-signature"));
      const checkFails = credentialed && !(spec.method === "POST" && spec.path === "/agents/:agentRef/kill");
      const r = await peekOrTake(deps.store, fallback, checkFails ? keys : [keys[0]!], now(), cls).catch(() => null);
      if (!r) return c.json(errorBody("INTERNAL_ERROR", "Rate limits cannot be checked right now; writes are paused."), 503);
      if (!r.ok) {
        c.header("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)));
        return c.json(errorBody("VENUE_RATE_LIMITED", "Too many requests. Slow down and try again."), 429);
      }
      await next();
      if (c.res.status === 401) await deps.store.take([{ key: `rl:authfail:ip:${ip}`, limit: Number.MAX_SAFE_INTEGER }], now()).catch(() => fallback.take([{ key: `rl:authfail:ip:${ip}`, limit: Number.MAX_SAFE_INTEGER }], now()));
    };
  };
}

/** Take the pre-auth slot and check (without taking) the failure bucket. */
async function peekOrTake(store: WindowStore, fallback: WindowStore, keys: { key: string; limit: number }[], at: number, cls: RouteClass): Promise<Awaited<ReturnType<WindowStore["take"]>> | null> {
  const run = async (s: WindowStore) => {
    // the failure bucket is checked first with a probe key that is never written (limit 0 is always full, and take
    // writes nothing when any window is full): index 0 full means refuse
    if (keys[1]) {
      const probe = await s.take([{ key: keys[1].key, limit: keys[1].limit }, { key: `${keys[1].key}:never`, limit: 0 }], at);
      if (!probe.ok && probe.index === 0) return probe;
    }
    return s.take([keys[0]!], at);
  };
  try {
    return await run(store);
  } catch {
    if (cls !== "read") return null;
    return run(fallback);
  }
}
