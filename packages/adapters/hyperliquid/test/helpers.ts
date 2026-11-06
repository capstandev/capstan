// Test doubles for the Hyperliquid adapter: a VenueHttp that answers from recorded fixtures (the shared venue-client
// fixtures plus this package's own), recording every call and the weight it passed to the governor.
import { join } from "node:path";
import { memoryMarketDataCache } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { FIXTURES_DIR, loadFixture, type RawResponse, type VenueHttp } from "@capstan/venue-client";
import { existsSync } from "node:fs";
import { createHlReader, HL_MAINNET, type HlConfig, type HlReaderOptions } from "../src";

export const LOCAL_FIXTURES = join(import.meta.dir, "fixtures");
/** Public account with core + xyz positions, one builder approval and four named agents (captured 2026-11-06). */
export const USER_A = "0x2ac6e76aeb3102d322ee9a82bd67d447d8781014" as Hex;
export const BUILDER = "0x00000000000000000000000000000000c0ffee01" as Hex;

export function fx<T = any>(name: string): T {
  if (existsSync(join(LOCAL_FIXTURES, "hyperliquid", `${name}.json`))) return loadFixture<T>("hyperliquid", name, LOCAL_FIXTURES);
  return loadFixture<T>("hyperliquid", name, FIXTURES_DIR);
}
export function hasFx(name: string): boolean {
  return existsSync(join(LOCAL_FIXTURES, "hyperliquid", `${name}.json`)) || existsSync(join(FIXTURES_DIR, "hyperliquid", `${name}.json`));
}

const EMPTY_CHS = { marginSummary: { accountValue: "0.0", totalNtlPos: "0.0", totalRawUsd: "0.0", totalMarginUsed: "0.0" }, crossMarginSummary: { accountValue: "0.0", totalNtlPos: "0.0", totalRawUsd: "0.0", totalMarginUsed: "0.0" }, crossMaintenanceMarginUsed: "0.0", withdrawable: "0.0", assetPositions: [], time: 1793934054099 };

/** Default fixture routing by info body. Return undefined from `override` to fall through. */
export function route(body: Record<string, any>): unknown {
  const t = body.type as string;
  const dex = body.dex as string | undefined;
  const isA = typeof body.user === "string" && body.user.toLowerCase() === USER_A;
  switch (t) {
    case "perpDexs":
      return fx("perpDexs");
    case "meta":
      return dex ? fx(`metaAndAssetCtxs_${dex}`)[0] : fx("meta");
    case "metaAndAssetCtxs":
      return fx(dex ? `metaAndAssetCtxs_${dex}` : "metaAndAssetCtxs");
    case "perpDexLimits":
      return hasFx(`perpDexLimits_${dex}`) ? fx(`perpDexLimits_${dex}`) : { totalOiCap: "0.0", oiSzCapPerPerp: "0.0", maxTransferNtl: "0.0", coinToOiCap: [] };
    case "l2Book":
      if (body.coin === "BTC") return fx("l2Book_BTC");
      if (body.coin === "xyz:TSLA") return fx("l2Book_xyzTSLA");
      return { coin: body.coin, time: 1793929035228, levels: [[{ px: "100.0", sz: "1.0", n: 1 }], [{ px: "100.1", sz: "1.0", n: 1 }]] };
    case "predictedFundings":
      return fx("predictedFundings");
    case "extraAgents":
      return isA ? fx("extraAgents_userA") : [];
    case "approvedBuilders":
      return isA ? fx("approvedBuilders_userA") : [];
    case "maxBuilderFee":
      return isA && body.builder === fx<string[]>("approvedBuilders_userA")[0] ? fx("maxBuilderFee_userA") : 0;
    case "clearinghouseState":
      if (!isA) return EMPTY_CHS;
      return hasFx(`clearinghouseState_userA${dex ? `_${dex}` : ""}`) ? fx(`clearinghouseState_userA${dex ? `_${dex}` : ""}`) : EMPTY_CHS;
    case "frontendOpenOrders":
    case "openOrders":
      return isA && hasFx(`openOrders_userA${dex ? `_${dex}` : ""}`) ? fx(`openOrders_userA${dex ? `_${dex}` : ""}`) : [];
    case "userRateLimit":
      return isA ? fx("userRateLimit_userA") : { cumVlm: "0.0", nRequestsUsed: 0, nRequestsCap: 10000, nRequestsSurplus: 0 };
    case "userFees":
      return fx("userFees_userA");
    case "userFillsByTime":
    case "userFills":
      return isA ? fx("userFillsByTime_userA") : [];
    default:
      return "Failed to deserialize the JSON body into the target type";
  }
}

export interface FixtureHttp extends VenueHttp {
  calls: { path: string; body: Record<string, any>; cost: number | undefined }[];
  posts: { path: string; body: unknown }[];
}

export function fixtureHttp(override?: (body: Record<string, any>) => unknown): FixtureHttp {
  const calls: FixtureHttp["calls"] = [];
  const posts: FixtureHttp["posts"] = [];
  const answer = (body: Record<string, any>) => {
    const o = override?.(body);
    return structuredClone(o !== undefined ? o : route(body));
  };
  return {
    calls,
    posts,
    async getJson() {
      throw new Error("fixtureHttp: GET not used by the Hyperliquid adapter");
    },
    async postJson<T>(path: string, body: unknown, cost?: number): Promise<T> {
      calls.push({ path, body: body as Record<string, any>, cost });
      if (path !== "/info") {
        posts.push({ path, body });
        const o = override?.({ __path: path, ...(body as object) });
        if (o === undefined) throw new Error(`fixtureHttp: no answer for POST ${path}`);
        return o as T;
      }
      return answer(body as Record<string, any>) as T;
    },
    async postForm() {
      throw new Error("fixtureHttp: form posts not used");
    },
    async request(): Promise<RawResponse> {
      throw new Error("fixtureHttp: raw requests not used");
    },
  };
}

export const CFG: HlConfig = { ...HL_MAINNET, builderAddress: BUILDER };

export function fixtureReader(override?: (body: Record<string, any>) => unknown, opts: HlReaderOptions & { cfg?: Partial<HlConfig> } = {}) {
  const http = fixtureHttp(override);
  const cache = memoryMarketDataCache();
  const reader = createHlReader({ ...CFG, ...(opts.cfg ?? {}) }, http, cache, { now: () => 1793934060000, ...opts });
  return { http, cache, reader };
}
