// depeg-monitor (todo 17): every 60 s writes md:depeg:usdg-usdc and md:depeg:usdt-usdc with asOf; a failed read
// removes the key so readers see "unknown" at once (fail closed).
import { describe, expect, test } from "bun:test";
import { createRedis } from "@capstan/core";
import { cachedDepegReader, DEPEG_KEYS, type DepegReader } from "@capstan/quote";
import { DEPEG_TTL_MS, job, redisSink, runDepegMonitor, type DepegSink } from "../src/jobs/depeg-monitor.job";

const REDIS = process.env.REDIS_URL;

function memSink() {
  const m = new Map<string, { v: string; ttl: number }>();
  const sink: DepegSink = { set: async (k, v, ttl) => void m.set(k, { v, ttl }), del: async (k) => void m.delete(k) };
  return { m, sink };
}

describe("depeg-monitor", () => {
  test("definition and writes", async () => {
    expect(job).toMatchObject({ name: "depeg-monitor", schedule: { every: 60_000 }, concurrency: 1 });
    const { m, sink } = memSink();
    const ok: DepegReader = { usdgUsdcBps: async () => ({ bps: -3.2, asOf: 1_000, source: "uniswap_v3", method: "twap_5m" }), usdtUsdcBps: async () => ({ bps: 1.5, asOf: 2_000, source: "venue_marks" }) };
    await runDepegMonitor(ok, sink);
    expect(JSON.parse(m.get(DEPEG_KEYS.usdg)!.v)).toEqual({ bps: -3.2, asOf: 1_000, source: "uniswap_v3", method: "twap_5m" });
    expect(JSON.parse(m.get(DEPEG_KEYS.usdt)!.v)).toMatchObject({ bps: 1.5, asOf: 2_000 });
    expect(m.get(DEPEG_KEYS.usdg)!.ttl).toBe(DEPEG_TTL_MS);
    // a failure (null or a throw) deletes the key: never an old value served as current
    const bad: DepegReader = { usdgUsdcBps: async () => null, usdtUsdcBps: async () => Promise.reject(new Error("down")) };
    const r = await runDepegMonitor(bad, sink);
    expect(r).toEqual({ usdgUsdc: null, usdtUsdc: null });
    expect(m.size).toBe(0);
  });

  (REDIS ? test : test.skip)("round trip through Redis", async () => {
    const redis = createRedis(REDIS!);
    try {
      await redis.del(DEPEG_KEYS.usdg, DEPEG_KEYS.usdt);
      const ok: DepegReader = { usdgUsdcBps: async () => ({ bps: 4, asOf: Date.now(), source: "uniswap_v3", method: "slot0" }), usdtUsdcBps: async () => null };
      await runDepegMonitor(ok, redisSink(redis));
      const read = cachedDepegReader(redis);
      expect((await read.usdgUsdcBps())!.bps).toBe(4);
      expect(await read.usdtUsdcBps()).toBeNull();
      expect(await redis.pttl(DEPEG_KEYS.usdg)).toBeGreaterThan(DEPEG_TTL_MS - 5_000);
      await redis.del(DEPEG_KEYS.usdg, DEPEG_KEYS.usdt);
    } finally {
      await redis.quit();
    }
  });
});
