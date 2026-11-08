// Account readers from the environment, shared by the api routes and the risk workers: keyless HL (master address)
// and Lighter (both configs of the network) on the shared governor at free priority, Aster from ingested signed reads
// only (the store POST /v1/risk/ingest writes).
import type { MarketDataCache, Redis } from "@capstan/core";
import type { VenueId } from "@capstan/schema";
import { memoryKv, redisKv, type AccountAdapter, type ReadAccountsDeps } from "./accounts";

export async function envAccountDeps(env: Record<string, string | undefined>, deps: { redis: Redis | null; cache: MarketDataCache | null }): Promise<ReadAccountsDeps> {
  const hl = await import("@capstan/adapter-hyperliquid");
  const lt = await import("@capstan/adapter-lighter");
  const aster = await import("@capstan/adapter-aster");
  const { createGovernor, createMemoryGovernor, egressIdOf } = await import("@capstan/venue-client");
  const rt = hl.createHlRuntime(env, { redis: deps.redis, cache: deps.cache });
  const egress = egressIdOf(env); // one label per host (D2-ADP-06)
  const gov = deps.redis ? createGovernor(deps.redis, egress) : createMemoryGovernor(egress);
  const adapters = new Map<VenueId, AccountAdapter>();
  adapters.set("hyperliquid", { caps: hl.hlCaps("0x0000000000000000000000000000000000000000"), getAccount: (id) => rt.reader.getAccount(id) });
  for (const cfg of lt.lighterConfigsFor(env)) {
    const reader = lt.lighterReaderFor(cfg, gov, deps.cache);
    adapters.set(cfg.venue, { caps: lt.lighterCaps(cfg), getAccount: (id) => reader.getAccount(id) });
  }
  const store = deps.redis ? aster.redisAccountStore(deps.redis) : aster.memoryAccountStore();
  return { adapters, cache: deps.redis ? redisKv(deps.redis) : memoryKv(), asterIngested: async (o) => (await store.get(o))?.snapshot ?? null };
}
