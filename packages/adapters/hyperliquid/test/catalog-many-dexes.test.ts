// Catalog read with many HIP-3 dexes (testnet lists 277): one allPerpMetas call for every universe, asset contexts and
// OI caps only for core and the wired dexes, so a full sync fits inside one minute of the governor's 80% budget.
// Without allPerpMetas the per-dex reads run bounded-parallel.
import { describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import { laneCap, type RawResponse, type VenueHttp } from "@capstan/venue-client";
import { createHlReader, HL_TESTNET, HIP3_WIRING } from "../src";

const DEXES = 277; // index 0 is core
const PER_DEX = 3;
const nameOf = (i: number) => (i === 0 ? null : i === 65 ? "xyz" : i === 120 ? "io" : `d${i}`);

function universe(i: number) {
  const n = nameOf(i);
  return Array.from({ length: PER_DEX }, (_, k) => ({ name: n === null ? `C${k}` : `${n}:M${k}`, szDecimals: 2, maxLeverage: 10, ...(k === 1 ? { isDelisted: true } : {}) }));
}
const ctx = () => ({ funding: "0.0000125", openInterest: "10", prevDayPx: "100", dayNtlVlm: "1", premium: null, oraclePx: "100", markPx: "100.5", midPx: "100.5", impactPxs: null, dayBaseVlm: "1" });

interface Opts {
  batch: "ok" | "unknown" | "shifted";
  latencyMs?: number;
}

function manyDexHttp(o: Opts) {
  const calls: { type: string; dex?: string; cost: number }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const perpDexs = Array.from({ length: DEXES }, (_, i) => (i === 0 ? null : { name: nameOf(i), fullName: `dex ${i}`, deployer: null, oracleUpdater: null, feeRecipient: null }));
  const indexOf = (dex: string | undefined) => (dex === undefined ? 0 : perpDexs.findIndex((d) => d?.name === dex));
  const answer = (b: Record<string, any>): unknown => {
    switch (b.type) {
      case "perpDexs":
        return perpDexs;
      case "allPerpMetas": {
        if (o.batch === "unknown") return "Failed to deserialize the JSON body into the target type";
        const metas = Array.from({ length: DEXES }, (_, i) => ({ universe: universe(i), collateralToken: 0 }));
        // a dex added between the two calls: every entry after index 200 is one slot late
        if (o.batch === "shifted") metas.splice(200, 0, { universe: [{ name: "new:X", szDecimals: 1, maxLeverage: 3 }], collateralToken: 0 });
        return metas;
      }
      case "metaAndAssetCtxs": {
        const i = indexOf(b.dex);
        if (i < 0) return null;
        return [{ universe: universe(i), collateralToken: 0 }, universe(i).map(ctx)];
      }
      case "perpDexLimits":
        return { totalOiCap: "1000000", coinToOiCap: universe(indexOf(b.dex)).map((u) => [u.name, "50000"]) };
      default:
        return "Failed to deserialize the JSON body into the target type";
    }
  };
  const http: VenueHttp = {
    async getJson() {
      throw new Error("not used");
    },
    async postJson<T>(_p: string, body: unknown, cost?: number): Promise<T> {
      const b = body as Record<string, any>;
      calls.push({ type: b.type, dex: b.dex, cost: cost ?? 0 });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(o.latencyMs ?? 0);
      inFlight--;
      return structuredClone(answer(b)) as T;
    },
    async postForm() {
      throw new Error("not used");
    },
    async request(): Promise<RawResponse> {
      throw new Error("not used");
    },
  };
  return { http, calls, maxInFlight: () => maxInFlight };
}

function checkMarkets(ms: Awaited<ReturnType<ReturnType<typeof createHlReader>["listMarkets"]>>) {
  expect(ms.length).toBe(DEXES * PER_DEX);
  for (let i = 1; i < DEXES; i++) {
    const n = nameOf(i)!;
    for (let k = 0; k < PER_DEX; k++) {
      const m = ms.find((x) => x.venueSymbol === `${n}:M${k}`)!;
      expect(m.assetId).toBe(100_000 + i * 10_000 + k);
      expect(m.dexIndex).toBe(i);
      expect(m.status).toBe(k === 1 ? "delisted" : "active");
    }
  }
}

describe("catalog", () => {
  test("many-dexes-one-minute-budget", async () => {
    const f = manyDexHttp({ batch: "ok", latencyMs: 5 });
    const reader = createHlReader({ ...HL_TESTNET, builderAddress: null }, f.http, memoryMarketDataCache());
    const t0 = performance.now();
    const ms = await reader.listMarkets();
    checkMarkets(ms);
    const weight = f.calls.reduce((s, c) => s + c.cost, 0);
    // the whole sync fits inside one minute of the 80% lane cap (1,200 x 0.8 = 960), so it never waits on the governor
    expect(weight).toBeLessThanOrEqual(laneCap(1200, "free"));
    expect(f.calls.filter((c) => c.type === "allPerpMetas").length).toBe(1);
    // contexts and OI caps only for core and the wired HIP-3 dexes the venue lists
    const detail = new Set(f.calls.filter((c) => c.type === "metaAndAssetCtxs").map((c) => c.dex ?? "core"));
    expect([...detail].sort()).toEqual(["core", "io", "xyz"]);
    expect(f.calls.filter((c) => c.type === "perpDexLimits").map((c) => c.dex).sort()).toEqual(["io", "xyz"]);
    expect(ms.find((m) => m.venueSymbol === "xyz:M0")!.oiCapUsd).toBe("50000");
    expect(ms.find((m) => m.venueSymbol === "d2:M0")!.oiCapUsd).toBeNull(); // never executable (R3), no cap read
    expect(ms.find((m) => m.venueSymbol === "xyz:M0")!.tickSize).toBe("0.01"); // from the mark
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(HIP3_WIRING.includes("para")).toBe(true); // para is wired but not listed here: no call for it
    expect(f.calls.some((c) => c.dex === "para")).toBe(false);
  });

  test("many-dexes-fallback-bounded-parallel", async () => {
    const f = manyDexHttp({ batch: "unknown", latencyMs: 10 });
    const reader = createHlReader({ ...HL_TESTNET, builderAddress: null }, f.http, memoryMarketDataCache(), { catalogConcurrency: 6 });
    const t0 = performance.now();
    checkMarkets(await reader.listMarkets());
    const took = performance.now() - t0;
    expect(f.calls.filter((c) => c.type === "metaAndAssetCtxs").length).toBe(DEXES);
    expect(f.maxInFlight()).toBeGreaterThan(1);
    expect(f.maxInFlight()).toBeLessThanOrEqual(6);
    // one by one this would take at least 277 x 10 ms
    expect(took).toBeLessThan(DEXES * 10 * 0.6);
    expect(f.calls.filter((c) => c.type === "perpDexLimits").map((c) => c.dex).sort()).toEqual(["io", "xyz"]);
  });

  test("many-dexes-batch-misaligned", async () => {
    // a dex added between perpDexs and allPerpMetas: entries that do not match their dex are read one by one
    const f = manyDexHttp({ batch: "shifted" });
    const reader = createHlReader({ ...HL_TESTNET, builderAddress: null }, f.http, memoryMarketDataCache());
    checkMarkets(await reader.listMarkets());
    const perDex = f.calls.filter((c) => c.type === "metaAndAssetCtxs").map((c) => c.dex ?? "core");
    expect(perDex.length).toBe(3 + (DEXES - 200));
  });
});
