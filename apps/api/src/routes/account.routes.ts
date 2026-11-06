// POST /v1/account/keys (owner signature): create a Capstan API key (an account key, not a wallet key), shown once.
// GET /v1/account (API key): the account's plan, lock tier, limits and credits. Locking is never required.
// Also exports the shared wiring (PlansDeps, envPlansDeps, presentedKey) used by credits.routes.ts.
import { createDb, createRedis, memoryNonceStore, redisNonceStore, type Db, type NonceStore, type RouteSpec } from "@capstan/core";
import { ApiKeyError, createApiKey, creditsOf, dbWalletActivity, lockReaderFromEnv, NO_LOCK as NO_LOCK_READER, PERK_COPY, tierOf, verifyApiKey, type LockReader, type WalletActivity } from "@capstan/plans";
import { errorBody, type Hex } from "@capstan/schema";
import type { Context } from "hono";

export interface PlansDeps {
  db: Db;
  lock: LockReader;
  host: string;
  nonces: NonceStore;
  activity?: WalletActivity;
  now?: () => number;
}

/** No CPSTLock deployed on this chain yet: nothing is locked (every route still works on the free plan). */
export const NO_LOCK: LockReader = NO_LOCK_READER;

/** The shared CPSTLock reader (packages/tiers lockReaderFromEnv): the same chain, lock and RPC every role uses. */
export function lockFromEnv(env: Record<string, string | undefined> = process.env): LockReader {
  return lockReaderFromEnv(env);
}

let cached: Promise<PlansDeps> | null = null;
export function envPlansDeps(): Promise<PlansDeps> {
  return (cached ??= (async () => {
    const env = process.env;
    if (!env.DATABASE_URL) throw new Error("account routes need DATABASE_URL");
    const db = createDb(env.DATABASE_URL, { max: 4 });
    const nonces = env.REDIS_URL ? redisNonceStore(createRedis(env.REDIS_URL)) : memoryNonceStore();
    return { db, lock: lockFromEnv(env), host: env.PUBLIC_API_HOST ?? "localhost:8710", nonces, activity: dbWalletActivity(db) };
  })());
}

/** The presented API key: `x-api-key` header or `Authorization: Bearer <key>`. */
export function presentedKey(c: Context): string | null {
  const h = c.req.header("x-api-key");
  if (h) return h.trim();
  const a = c.req.header("authorization");
  const m = a ? /^Bearer\s+(\S+)$/i.exec(a) : null;
  return m ? m[1]! : null;
}

export const LOCK_CACHE_TTL_MS = 60_000;

export function createAccountRoutes(getDeps: () => Promise<PlansDeps> | PlansDeps): RouteSpec[] {
  return [
    {
      method: "POST",
      path: "/account/keys",
      auth: "owner_sig",
      description: "Create a Capstan API key for your wallet (shown once)",
      async handler(c) {
        const d = await getDeps();
        let body: { owner?: unknown; message?: unknown; sig?: unknown };
        try {
          body = (await c.req.json()) as typeof body;
        } catch {
          return c.json(errorBody("INVALID_INPUT", "body must be JSON"), 400);
        }
        const owner = body.owner === null || body.owner === undefined ? null : String(body.owner);
        if (owner !== null && !/^0x[0-9a-fA-F]{40}$/.test(owner)) return c.json(errorBody("INVALID_INPUT", "owner must be an address or null"), 400);
        try {
          const proof = typeof body.message === "string" && typeof body.sig === "string" ? { message: body.message, sig: body.sig as Hex } : undefined;
          const k = await createApiKey(d.db, owner as Hex | null, proof, { host: d.host, nonces: d.nonces, nowMs: (d.now ?? Date.now)() });
          return c.json({ id: k.id, key: k.key, note: "Shown once. This is a Capstan API key, not a wallet key. Store it safely." }, 201);
        } catch (e) {
          if (e instanceof ApiKeyError) return c.json(errorBody("UNAUTHORIZED", e.message), 401);
          throw e;
        }
      },
    },
    {
      method: "GET",
      path: "/account",
      auth: "api_key",
      description: "Your plan, limits and credits",
      async handler(c) {
        const d = await getDeps();
        const key = presentedKey(c);
        const acct = key ? await verifyApiKey(d.db, key) : null;
        if (!acct) return c.json(errorBody("UNAUTHORIZED"), 401);
        const t = await tierOf({ apiKeyId: acct.id }, { db: d.db, lock: d.lock, cacheTtlMs: LOCK_CACHE_TTL_MS, activity: d.activity, now: d.now });
        const credits = await creditsOf(d.db, acct.id, 0);
        return c.json({
          id: acct.id,
          ownerWallet: acct.ownerWallet,
          tier: t.tier,
          perks: PERK_COPY[t.tier],
          limits: t.limits,
          multiplier: t.multiplier,
          builderFee: t.builderFee,
          credits: credits?.credits ?? "0",
          lockRequired: false,
        });
      },
    },
  ];
}

export const routes: RouteSpec[] = createAccountRoutes(envPlansDeps);
