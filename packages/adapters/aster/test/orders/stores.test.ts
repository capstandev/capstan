// Redis and Postgres ports behind the ingest route (skip without REDIS_URL / DATABASE_URL).
import { closeDb, createDb, createRedis, createTempDatabase } from "@capstan/core";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { redisAccountStore, type AsterAccountState } from "../../src/signedread";
import { agent, NOW, owner } from "./setup";

const API = join(import.meta.dir, "../../../../../apps/api/src/routes/risk-ingest.routes.ts");
const redisTest = process.env.REDIS_URL ? test : test.skip;
const dbTest = process.env.DATABASE_URL ? test : test.skip;

describe("aster ingest stores", () => {
  redisTest("redis-store-and-limit", async () => {
    const redis = createRedis(process.env.REDIS_URL!);
    try {
      const store = redisAccountStore(redis);
      const who = `0x${crypto.getRandomValues(new Uint8Array(20)).reduce((a, b) => a + b.toString(16).padStart(2, "0"), "")}` as const;
      const st: AsterAccountState = { snapshot: { venue: "aster", source: "client_read", identity: { venue: "aster", owner: who }, equityUsd: "1", freeCollateralUsd: "1", positions: [], asOf: new Date(NOW).toISOString() }, openOrders: null };
      await store.put(who, st, 200);
      expect(await store.get(who)).toEqual(st);
      expect(await store.get(who.toUpperCase().replace("0X", "0x") as never)).toEqual(st);
      await Bun.sleep(250);
      expect(await store.get(who)).toBeNull();
      const { redisRateLimiter } = await import(API);
      const lim = redisRateLimiter(redis, 3);
      const key = `t-${who}`;
      const res = [];
      for (let i = 0; i < 4; i++) res.push(await lim.hit(key, NOW));
      expect(res).toEqual([true, true, true, false]);
      expect(await lim.hit(key, NOW + 60_000)).toBe(true);
    } finally {
      redis.disconnect();
    }
  });

  dbTest(
    "delegations-lookup",
    async () => {
      const t = await createTempDatabase(process.env.DATABASE_URL!, { migrated: true, prefix: "capstan_asterdg" });
      const db = createDb(t.url, { max: 2 });
      try {
        const { dbDelegations } = await import(API);
        const look = dbDelegations(db.$client);
        await db.$client`insert into delegations (id, venue, owner, agent_address, state, expires_at) values ('a1', 'aster', ${owner.address}, ${agent.address}, 'active', ${new Date(NOW + 86_400_000).toISOString()}::timestamptz)`;
        expect(await look.isActive(owner.address.toLowerCase(), agent.address, NOW)).toBe(true);
        expect(await look.isActive(owner.address, agent.address, NOW + 2 * 86_400_000)).toBe(false); // expired
        expect(await look.isActive(agent.address, owner.address, NOW)).toBe(false);
        await db.$client`update delegations set state = 'killed' where id = 'a1'`;
        expect(await look.isActive(owner.address, agent.address, NOW)).toBe(false);
      } finally {
        await closeDb(db);
        await t.drop();
      }
    },
    60_000,
  );
});
