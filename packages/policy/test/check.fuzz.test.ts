// R4: 5,000 random policies and orders (fixed seed). The check never allows an order that breaks a limit and never
// refuses an order inside every limit. The oracle below is written independently, on integer micro-dollars.
import { describe, expect, test } from "bun:test";
import type { AgentPolicy, VenueId } from "@capstan/schema";
import { checkPolicy, type PolicyCheckInput } from "../src";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VENUES: VenueId[] = ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster"];
const MARKETS = ["hyperliquid:-:ETH", "hyperliquid:xyz:TSLA", "lighter-mainnet:-:ETH", "aster:-:BTCUSDT"];
const NOW = 1_793_000_000_000;

/** Micro-dollar integer as a decimal string with a random number of trailing zeros. */
function money(micros: bigint, r: () => number): string {
  const s = micros.toString().padStart(7, "0");
  let out = `${s.slice(0, -6)}.${s.slice(-6)}`;
  if (r() < 0.5) out = out.replace(/0+$/, "").replace(/\.$/, "");
  else if (r() < 0.3) out += "000";
  return out;
}

describe("checkPolicy fuzz", () => {
  test("sound-and-complete", () => {
    const r = rng(0xc0ffee);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
    let allowed = 0;
    let refused = 0;
    for (let i = 0; i < 5000; i++) {
      const maxOrder = BigInt(Math.floor(r() * 5_000_000_000));
      const maxGross = BigInt(Math.floor(r() * 20_000_000_000));
      const allowedVenues = VENUES.filter(() => r() < 0.7);
      const wildcard = r() < 0.2;
      const allowedMarkets = MARKETS.filter(() => r() < 0.6);
      const agents = [{ venue: pick(VENUES), agentRef: `ag-${Math.floor(r() * 3)}` }];
      const roa = r() < 0.3 ? NOW + Math.floor((r() - 0.5) * 3_600_000) : null;
      const exp = NOW + Math.floor((r() - 0.1) * 86_400_000);
      const policy: AgentPolicy = {
        owner: "0x00000000000000000000000000000000000000bb",
        agents,
        maxNotionalPerOrderUsd: money(maxOrder, r),
        maxGrossNotionalUsd: money(maxGross, r),
        maxLeverage: 1 + Math.floor(r() * 20),
        allowedMarkets: wildcard ? "*" : allowedMarkets,
        allowedVenues,
        maxOrdersPerDay: Math.floor(r() * 50),
        ...(roa !== null ? { reduceOnlyAfter: new Date(roa).toISOString() } : {}),
        expiresAt: new Date(exp).toISOString(),
        nonce: `fuzz-${i}`,
      };
      // orders cluster around the limits so both sides of every boundary get hit
      const near = (lim: bigint) => (r() < 0.5 ? lim + BigInt(Math.floor((r() - 0.5) * 4)) : BigInt(Math.floor(r() * Number(lim + 1n))));
      const notional = (() => { const v = near(maxOrder); return v < 0n ? 0n : v; })();
      const gross = (() => { const v = near(maxGross - notional); return v < 0n ? 0n : v; })();
      const ag = r() < 0.85 ? agents[0]! : { venue: pick(VENUES), agentRef: `ag-${Math.floor(r() * 3)}` };
      const reduceOnly = r() < 0.3;
      const leverage = r() < 0.5 ? policy.maxLeverage + Math.floor((r() - 0.5) * 3) : 1 + Math.floor(r() * 25);
      const ordersToday = r() < 0.5 ? policy.maxOrdersPerDay - 1 + Math.floor((r() - 0.5) * 3) : Math.floor(r() * 60);
      const nowMs = r() < 0.5 && roa !== null ? roa + Math.floor((r() - 0.5) * 4) : NOW;
      const mode = r() < 0.95 ? "relay" : "direct";
      const inp: PolicyCheckInput = { policy, agentRef: ag.agentRef, venue: ag.venue, marketId: pick(MARKETS), side: r() < 0.5 ? "buy" : "sell", notionalUsd: money(notional, r), leverage: Math.max(leverage, 1), reduceOnly, grossNotionalUsd: money(gross, r), ordersToday: Math.max(ordersToday, 0), nowMs, mode };

      // independent oracle
      const inside =
        inp.mode === "relay" &&
        nowMs < exp &&
        agents.some((a) => a.agentRef === inp.agentRef && a.venue === inp.venue) &&
        allowedVenues.includes(inp.venue) &&
        (wildcard || allowedMarkets.includes(inp.marketId)) &&
        (roa === null || nowMs < roa || reduceOnly) &&
        notional <= maxOrder &&
        (reduceOnly || (gross + notional <= maxGross && inp.leverage <= policy.maxLeverage)) &&
        inp.ordersToday + 1 <= policy.maxOrdersPerDay;
      const res = checkPolicy(inp);
      expect(res.ok, `case ${i}: ${JSON.stringify(inp)}`).toBe(inside);
      if (res.ok) allowed++;
      else refused++;
    }
    // the generator really exercises both outcomes
    expect(allowed).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(500);
  });
});
