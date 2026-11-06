// Drift guard: builds made by the REAL Aster and Lighter adapters pass the SDK check unchanged, across random
// intents (the HL adapter is covered end to end in e2e.test.ts). A change to an adapter's encoding fails here first.
import { describe, expect, test } from "bun:test";
import { buildAsterOrder } from "@capstan/adapter-aster";
import { buildOrder as lighterBuildOrder, LIGHTER_CONFIGS } from "@capstan/adapter-lighter";
import type { Market, OrderBook } from "@capstan/schema";
import { AsterNonce } from "@capstan/signer-aster";
import { checkBuild } from "../src/check";
import { AGENT, ASTER_REF, BUILDER_ASTER, LIGHTER_ACCT, LIGHTER_REF, LIGHTER_SPEC, OWNER, randomIntent, rng, T0, testPins } from "./helpers";

const pins = testPins();
const market = (id: string, venue: Market["venue"], tick: string, lot: string): Market => ({ id, venue, dex: null, venueSymbol: id.split(":")[2]!, marketType: "perp", canonicalAsset: null, collateralAsset: "USDT", tickSize: tick, lotSize: lot, minNotional: "1", maxLeverage: 20, marginModes: ["cross"], fundingIntervalS: 28800, fundingSettleIntervalS: 28800, sessionHours: null, oiCapUsd: null, builderFeeUnit: "decimal_rate", status: "active", executable: true, dataFreshness: "live", updatedAt: new Date(T0).toISOString() });
const book = (id: string, mid: number, step: number): OrderBook => ({ marketId: id, bids: Array.from({ length: 20 }, (_, i) => [(mid - step * (i + 1)).toFixed(2), "50"] as [string, string]), asks: Array.from({ length: 20 }, (_, i) => [(mid + step * (i + 1)).toFixed(2), "50"] as [string, string]), asOf: new Date(T0).toISOString() });

describe("real adapter builds pass the SDK check", () => {
  test("aster", async () => {
    const id = "aster:-:BTCUSDT";
    const nonce = new AsterNonce();
    const r = rng(7);
    for (let n = 0; n < 100; n++) {
      const i = { ...randomIntent(r, id, ASTER_REF, 3), clientOrderId: `cp${n}` };
      const now = T0 + n;
      const b = await buildAsterOrder(i, { owner: OWNER, agentRef: `aster:${OWNER}:${AGENT}`, identity: { venue: "aster", owner: OWNER, agentAddress: AGENT }, builderFee: { decimalRate: "0.0002" }, approvedMaxBps: 3, nowMs: now, eligibilityDecisionId: "e", policyId: null }, { network: "Mainnet", builder: BUILDER_ASTER, market: async () => market(id, "aster", "0.1", "0.001"), book: async () => book(id, Number(ASTER_REF), 0.1), nonceFor: () => nonce });
      const c = checkBuild(i, b, { venue: "aster", approvedMax: 3, pins, nowMs: now, refPx: ASTER_REF, identity: { owner: OWNER, agentAddress: AGENT } });
      if (!c.ok) throw new Error(`aster build refused: ${c.field} ${JSON.stringify(i)}`);
      expect(c.digest).toBe(b.digest);
    }
  });

  test("lighter", async () => {
    const id = LIGHTER_SPEC.marketId;
    const meta = { market: { ...market(id, "lighter-mainnet", "0.01", "0.0001"), builderFeeUnit: "ppm" as const }, marketIndex: 0, sizeDecimals: 4, priceDecimals: 2, minBaseAmount: "0.0001", markPx: LIGHTER_REF, imfTicks: null, capPerHour: null };
    const hasher = { txHashForOrder: async () => "ab".repeat(32), txHashForCancel: async () => "cd".repeat(32) };
    const r = rng(11);
    for (let n = 0; n < 100; n++) {
      const i = { ...randomIntent(r, id, LIGHTER_REF, 4) };
      delete (i as { clientOrderId?: string }).clientOrderId;
      const b = await lighterBuildOrder(i, { owner: OWNER, agentRef: "lighter-mainnet:712:5", identity: { venue: "lighter-mainnet", owner: OWNER, ...LIGHTER_ACCT }, builderFee: null, approvedMaxBps: 0, nowMs: T0, eligibilityDecisionId: "e", policyId: null, cfg: LIGHTER_CONFIGS.mainnet, market: meta, nonce: n, clientOrderIndex: 1000 + n, integratorAccountIndex: 0, hasher, fee: { makerBps: 0, takerBps: 0, makerLatencyMs: 200, takerLatencyMs: 300, tier: "standard" }, book: book(id, Number(LIGHTER_REF), 0.01) });
      const c = checkBuild(i, b, { venue: "lighter-mainnet", approvedMax: 0, pins, nowMs: T0, market: LIGHTER_SPEC, refPx: LIGHTER_REF, identity: { owner: OWNER, ...LIGHTER_ACCT } });
      if (!c.ok) throw new Error(`lighter build refused: ${c.field} ${JSON.stringify(i)}`);
    }
  });
});
