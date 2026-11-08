// @capstan/ws: WebSocket gateway (spec 13.2) on WS_PORT, path /v1. Fans out from Redis pub/sub; owner-signed
// subscribes for account, risk, plan and receipts channels; per-connection subscription caps by tier.
import { createDb, createMarketDataCache, createRedis, loadConfig, logger, redisNonceStore, schema } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { initTelemetry, telemetryEnv } from "@capstan/telemetry";
import { and, eq, isNotNull } from "drizzle-orm";
import { redisBus } from "./bus";
import { createWsGateway } from "./server";

export const PACKAGE_NAME = "@capstan/ws" as const;
export * from "./bus";
export * from "./server";

if (import.meta.main) {
  const log = logger("ws");
  try {
    const cfg = loadConfig("ws");
    initTelemetry("ws", telemetryEnv(process.env));
    const redis = createRedis(cfg.REDIS_URL);
    const cache = createMarketDataCache(redis);
    const db = process.env.DATABASE_URL ? createDb(process.env.DATABASE_URL, { max: 2 }) : null;
    const { LIMITS, tierOf } = await import("@capstan/plans");
    const noLock = { lockedOf: async () => ({ amount: 0n, unlockAt: 0n }) };
    // the catalog's market ids and canonical assets, read at most once a minute (r1 F6: only these may be subscribed)
    let catalog: { at: number; markets: Set<string>; assets: Set<string> } | null = null;
    const catalogNow = async () => {
      if (catalog && Date.now() - catalog.at < 60_000) return catalog;
      const rows = db ? await db.select({ id: schema.markets.id, asset: schema.markets.canonicalAsset }).from(schema.markets) : [];
      catalog = { at: Date.now(), markets: new Set(rows.map((r) => r.id)), assets: new Set(rows.map((r) => r.asset).filter((a): a is string => !!a)) };
      return catalog;
    };
    const trustXff = process.env.CAPSTAN_TRUST_FORWARDED_FOR === "1";
    const gw = createWsGateway({
      bus: redisBus(redis),
      host: cfg.PUBLIC_API_HOST,
      nonces: redisNonceStore(redis, 10 * 60_000),
      async marketsForAsset(asset) {
        if (!db) return [];
        const rows = await db.select({ id: schema.markets.id }).from(schema.markets).where(eq(schema.markets.canonicalAsset, asset));
        return rows.map((r) => r.id);
      },
      bookOf: (id) => cache.getBook(id),
      knownMarket: async (id) => (await catalogNow()).markets.has(id),
      knownAsset: async (a) => (await catalogNow()).assets.has(a),
      // behind Caddy the peer is 127.0.0.1: the first X-Forwarded-For entry (Caddy sets it, never the client's)
      ipOf: (req, server) => (trustXff ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : undefined) || (server.requestIP(req)?.address ?? ""),
      async planSigners(planId) {
        if (!db) return [];
        const [p] = await db.select({ owner: schema.spreadPlans.owner }).from(schema.spreadPlans).where(eq(schema.spreadPlans.id, planId)).limit(1);
        if (!p) return [];
        const agents = await db.select({ a: schema.delegations.agentAddress }).from(schema.delegations).where(and(eq(schema.delegations.owner, p.owner.toLowerCase()), eq(schema.delegations.state, "active"), isNotNull(schema.delegations.agentAddress)));
        return [p.owner as Hex, ...agents.map((x) => x.a as Hex)];
      },
      // anonymous and free connections: the configured cap (free tier); a signed owner gets its tier's cap
      async capOf(owner) {
        if (!owner) return cfg.WS_MAX_SUBS_PER_CONN;
        const t = await tierOf({ owner }, { db, lock: noLock, cacheTtlMs: 60_000 }).catch(() => null);
        return Math.max(cfg.WS_MAX_SUBS_PER_CONN, LIMITS[t?.tier ?? "free"].wsSubs);
      },
    });
    await gw.start(cfg.WS_PORT);
    log.info("listening", { port: cfg.WS_PORT });
  } catch (e) {
    log.error("boot failed", { error: (e as Error).message });
    process.exit(1);
  }
}
