// x402-detect job: definition, writes x402_detections, and a flip to absent raises an ops alert and removes the
// eip3009 option within one refresh (the gate reads loadUsdgEip3009). Database part skips without DATABASE_URL.
import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, logger, schema, type JobDeps } from "@capstan/core";
import { acceptsFor, loadUsdgEip3009, TRANSFER_WITH_AUTHORIZATION_TYPEHASH, domainSeparator, USDG_TARGETS, type ReadClient } from "@capstan/x402";
import { encodeAbiParameters } from "viem";
import { DETECT_EVERY_MS, job, runX402Detect } from "../src/jobs/x402-detect.job";

const PG = process.env.DATABASE_URL;
const quiet = logger("test", { sink: () => {} });

/** A fake USDG for one chain: answers the three detection calls like the live token. */
function fakeUsdg(chainId: number, token: `0x${string}`): ReadClient {
  let n = 0;
  return {
    call: async () => {
      const i = n++ % 3;
      if (i === 0) return { data: TRANSFER_WITH_AUTHORIZATION_TYPEHASH } as never;
      if (i === 1) return { data: encodeAbiParameters([{ type: "bool" }], [false]) } as never;
      return { data: domainSeparator("Global Dollar", "1", chainId, token) } as never;
    },
  };
}
const down: ReadClient = { call: async () => Promise.reject(new Error("rpc down")) };

describe("x402-detect job", () => {
  test("definition", () => {
    expect(job).toMatchObject({ name: "x402-detect", queue: "x402Settle", schedule: { every: DETECT_EVERY_MS }, concurrency: 1 });
    expect(DETECT_EVERY_MS).toBe(86_400_000);
  });
});

(PG ? describe : describe.skip)("x402-detect with a database", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterAll(async () => {
    await cleanup?.();
  }, 30_000);

  test("writes rows and flips to absent", async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_x4d" });
    const db = createDb(t.url, { max: 2 });
    cleanup = async () => {
      await closeDb(db);
      await t.drop();
    };
    const published: { ch: string; p: unknown }[] = [];
    let now = new Date("2026-11-06T00:00:00Z");
    const deps: JobDeps = { db, redis: null, cache: null, log: quiet, now: () => now, publish: async (ch, p) => void published.push({ ch, p }) };
    const good = { "4663": fakeUsdg(4663, USDG_TARGETS["4663"].token), "46630": fakeUsdg(46630, USDG_TARGETS["46630"].token) };

    const r1 = await runX402Detect(deps, good);
    expect(r1.results["4663"]?.supported).toBe(true);
    expect(r1.results["46630"]?.supported).toBe(true);
    expect((await db.select().from(schema.x402Detections)).length).toBe(2);
    expect(await loadUsdgEip3009(db, now.getTime())).toEqual({ "4663": true, "46630": true });
    expect(published).toEqual([]);

    // the testnet facet is swapped out: one refresh later the flag is false and an alert is raised
    now = new Date(now.getTime() + DETECT_EVERY_MS);
    const r2 = await runX402Detect(deps, { "4663": good["4663"], "46630": down });
    expect(r2.flippedToAbsent).toEqual(["46630"]);
    expect(published).toEqual([{ ch: "ops.alert", p: { kind: "x402.eip3009_absent", chain: "46630", reason: expect.any(String) } }]);
    const flags = await loadUsdgEip3009(db, now.getTime());
    expect(flags).toEqual({ "4663": true, "46630": false });
    const state = { usdgEip3009: flags, payTo: { evm: "0x00000000000000000000000000000000000000aa" as const, sol: "x".repeat(32) }, tokens: { "rhc-usdg-permit2": { asset: USDG_TARGETS["46630"].token, decimals: 6, name: "Global Dollar", version: "1" }, "rhc-usdg-eip3009": { asset: USDG_TARGETS["46630"].token, decimals: 6, name: "Global Dollar", version: "1" } } };
    expect(acceptsFor({ usd: "0.01", description: "f" }, state, "testnet").map((a) => a.extra.assetTransferMethod)).toEqual(["permit2"]);

    // a stale row (no run for more than 25 h) reads as absent
    expect((await loadUsdgEip3009(db, now.getTime() + 26 * 3600 * 1000))["4663"]).toBe(false);
    // no RPC configured: recorded absent
    const r3 = await runX402Detect(deps, {});
    expect(r3.results["4663"]).toMatchObject({ supported: false, reason: "no rpc configured" });
  }, 30_000);
});
