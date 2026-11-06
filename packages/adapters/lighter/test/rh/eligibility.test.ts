// R7: a refused-region user (GEO_REFUSED, or AE for Lighter-RH per DECISIONS #18) gets data only: quotes refused with
// the code, no build, and the read-only stream URL.
import { describe, expect, test } from "bun:test";
import type { VenueQuote } from "@capstan/schema";
import { assertMayBuild, readOnlyMode, refusedQuote } from "../../src";

const q: VenueQuote = { marketId: "lighter-rh:-:AMZN", venue: "lighter-rh", status: "ok", avgFillPx: "250.1", slippageBps: 1, venueFeeBps: 0, builderFeeBps: 0, fundingCostBps: 0, totalCostBps: 1, estLiqPx: null, collateralAsset: "USDG", asOf: new Date(0).toISOString(), staleMs: 0 };

describe("rh eligibility", () => {
  test("read-only", () => {
    const geo = { decisionId: "d1", allowed: false, code: "GEO_REFUSED" as const, country: "US" };
    const uae = { decisionId: "d2", allowed: true, country: "AE" };
    const ok = { decisionId: "d3", allowed: true, country: "DE" };
    for (const d of [geo, uae]) {
      expect(readOnlyMode(d)).toEqual({ wsUrl: "wss://api.rh.lighter.xyz/stream?readonly=true", executable: false });
      const r = refusedQuote(q, d);
      expect(r.status).toBe("refused");
      expect(r.refusal?.code).toBe("GEO_REFUSED");
      expect(r.avgFillPx).toBe(q.avgFillPx); // data stays
      expect(() => assertMayBuild(d)).toThrow();
    }
    expect(readOnlyMode(ok)).toBeNull();
    expect(() => assertMayBuild(ok)).not.toThrow();
    expect(refusedQuote(q, { decisionId: "d4", allowed: false, code: "DECLARATION_MISSING" }).refusal?.code).toBe("DECLARATION_MISSING");
  });
});
