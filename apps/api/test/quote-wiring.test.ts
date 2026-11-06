// Found on the fork run (todo 40): the production quote route wired only the read-only feeds, so every Hyperliquid
// and Lighter quote answered VENUE_UNAVAILABLE. It now takes the shared adapter composition: a Hyperliquid book read
// goes to the configured venue host (here a local stand-in through CAPSTAN_VENUE_URL_HYPERLIQUID).
import { afterAll, describe, expect, test } from "bun:test";
import { fakeVenueServer } from "@capstan/venue-client";
import { hlRoutes, hlState } from "../../../ops/fork/fake-venues";

describe("quote route wiring", () => {
  const venue = fakeVenueServer(hlRoutes(hlState("Mainnet")));
  const prev = { ...process.env };
  afterAll(() => {
    venue.stop();
    for (const k of ["CAPSTAN_VENUE_URL_HYPERLIQUID", "CAPSTAN_NETWORK", "DATABASE_URL", "REDIS_URL"]) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  test("executable-venues-quoted", async () => {
    process.env.CAPSTAN_VENUE_URL_HYPERLIQUID = venue.url;
    process.env.CAPSTAN_NETWORK = "mainnet";
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    const { quoteDepsFromEnv } = await import("../src/routes/quote.routes");
    const { composeAdapters } = await import("../src/adapters");
    const d = await quoteDepsFromEnv(() => composeAdapters(process.env, { db: null, redis: null }));
    for (const v of ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster", "variational", "arcus"] as const) expect(d.adapters.has(v)).toBe(true);
    const hl = d.adapters.get("hyperliquid") as { getBook(id: string, depth: number): Promise<{ bids: unknown[] }> };
    const book = await hl.getBook("hyperliquid:-:BTC", 5);
    expect(book.bids.length).toBeGreaterThan(0);
    expect(venue.hits).toContain("POST /info");
  });
});
