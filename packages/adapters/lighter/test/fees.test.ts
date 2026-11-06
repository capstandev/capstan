// R10: RH feeTiers answers 403 (CloudFront): the reader uses the docs table with tierSource 'docs'. Mainnet uses the
// live table, which matches the docs.
import { afterAll, describe, expect, test } from "bun:test";
import { docsSchedule, feeFor, latencyWarnings, LIGHTER_CONFIGS, LIGHTER_FEES } from "../src";
import { fakeLighter, fxRecord, readerFor } from "./helpers";

const rh = fakeLighter("lighter-466324");
const main = fakeLighter("lighter-304");
afterAll(() => {
  rh.stop();
  main.stop();
});

describe("fees", () => {
  test("rh-403-fallback", async () => {
    expect(fxRecord("lighter-466324", "feeTiers").status).toBe(403);
    const s = await readerFor(LIGHTER_CONFIGS.rh, rh.url).feeSchedule();
    expect(s.tierSource).toBe("docs");
    expect(s.tiers).toEqual(docsSchedule("lighter-rh").tiers);
    expect(s.tiers.standard).toEqual({ makerBps: 0, takerBps: 0, makerLatencyMs: 200, takerLatencyMs: 300 });
    expect(s.tiers.plus).toMatchObject({ makerBps: 1.5, takerBps: 1.5 });
    expect(s.tiers.premium).toMatchObject({ makerBps: 1.2, takerBps: 3.5 });
    expect(feeFor(s, null)).toMatchObject({ tier: "standard", takerBps: 0, tierSource: "docs" });
    expect(latencyWarnings("lighter-rh", "standard", "alo")).toEqual(["maker orders on lighter-rh standard wait 200 ms before they rest"]);
    expect(latencyWarnings("lighter-mainnet", "standard", "alo")).toEqual([]);

    const m = await readerFor(LIGHTER_CONFIGS.mainnet, main.url).feeSchedule();
    expect(m.tierSource).toBe("live");
    for (const t of ["standard", "plus", "premium"] as const) {
      expect(m.tiers[t].makerBps).toBe(LIGHTER_FEES["lighter-mainnet"][t].makerBps);
      expect(m.tiers[t].takerBps).toBe(LIGHTER_FEES["lighter-mainnet"][t].takerBps);
    }
    // keyless reads cannot see a tier: Standard
    expect(await readerFor(LIGHTER_CONFIGS.mainnet, main.url).feeTier(3)).toBe("standard");
  });
});
