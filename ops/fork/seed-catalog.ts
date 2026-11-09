// Seed the proof stack's catalog (ops/mcp-proof/run.sh; any stack on 127.0.0.1:247xx): one catalog sync from the Hyperliquid stand-in venue, then the
// proof market made executable, as the fork stack does. Needs DATABASE_URL, REDIS_URL and CAPSTAN_VENUE_URL_HYPERLIQUID.
import { closeDb, createDb, createMarketDataCache, createRedis, logger } from "@capstan/core";
import { setExecutable } from "@capstan/catalog";
import { db as schema } from "@capstan/schema";
import { eq } from "drizzle-orm";
import { hyperliquidSource } from "../../apps/workers/src/jobs/catalog-sources/hyperliquid.source";
import { runCatalogSync } from "../../apps/workers/src/jobs/catalog-sync.job";

const MARKETS = (process.env.PROOF_MARKETS ?? "hyperliquid:-:BTC,hyperliquid:-:ETH").split(",");
const dbUrl = process.env.DATABASE_URL ?? "";
if (!/@127\.0\.0\.1:247\d\d\//.test(dbUrl)) throw new Error("refuse: DATABASE_URL is not the proof stack (127.0.0.1:247xx)");
const db = createDb(dbUrl, { max: 2 });
const redis = createRedis(process.env.REDIS_URL ?? "");
const report = await runCatalogSync({ db, redis, cache: createMarketDataCache(redis), log: logger("mcp-proof-seed"), now: () => new Date() }, [hyperliquidSource()]);
let made = 0;
for (const id of MARKETS) {
  const [m] = await db.select({ executable: schema.markets.executable }).from(schema.markets).where(eq(schema.markets.id, id)).limit(1);
  if (!m) throw new Error(`catalog sync did not list ${id}`);
  if (!m.executable) await setExecutable(db, id, true, "mcp-proof", "proof stack: test market made executable");
  made++;
}
console.log(`seed: catalog synced (${JSON.stringify(report).slice(0, 120)}), ${made} markets executable`);
await redis.quit().catch(() => undefined);
await closeDb(db);
process.exit(0); // the market data cache keeps a subscriber open
