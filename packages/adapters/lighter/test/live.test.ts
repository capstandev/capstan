// Optional keyless live reads against both mainnet configs (GET only, through the 1 req/s governor).
// Skips unless LIGHTER_LIVE=1. Never signs, never sends.
import { describe, expect, test } from "bun:test";
import { ADDRESSES } from "@capstan/schema";
import { createMemoryGovernor } from "@capstan/venue-client";
import { LIGHTER_CONFIGS, lighterReaderFor } from "../src";

const live = process.env.LIGHTER_LIVE === "1";

describe("live", () => {
  for (const cfg of [LIGHTER_CONFIGS.mainnet, LIGHTER_CONFIGS.rh]) {
    test.skipIf(!live)(
      `${cfg.venue} keyless reads`,
      async () => {
        const r = lighterReaderFor(cfg, createMemoryGovernor("live"), null);
        const h = await r.health();
        expect(h.ok).toBe(true);
        const ms = await r.listMarkets();
        const perps = ms.filter((m) => m.marketType === "perp" && m.status !== "delisted");
        expect(perps.length).toBeGreaterThan(20);
        const f = await r.getFunding(perps.find((m) => m.venueSymbol === "BTC")?.id ?? perps[0]!.id);
        expect(f.intervalS).toBe(3600);
        expect(await r.accountIndexByL1("0x000000000000000000000000000000000000dEaD")).toBeNull();
        const s = await r.feeSchedule();
        expect(s.tierSource).toBe(cfg.venue === "lighter-rh" ? "docs" : "live");
        if (cfg.venue === "lighter-rh") expect((await r.info()).contract.toLowerCase()).toBe(ADDRESSES.lighterRhDeposit.address.toLowerCase());
      },
      60_000,
    );
  }
});
