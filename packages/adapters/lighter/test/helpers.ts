// Shared test helpers: recorded fixtures (test/fixtures/<venue key>/<name>.json), a fake venue serving them, and a
// reader wired to it through the real venue HTTP client and an in-memory governor.
import { memoryMarketDataCache, type MarketDataCache } from "@capstan/core";
import { createMemoryGovernor, fakeVenueServer, loadFixtureRecord, type FakeHandler, type GovernorOptions } from "@capstan/venue-client";
import { join } from "node:path";
import { lighterReaderFor, type LighterConfig, type LighterReader } from "../src";

export const FIXTURES = join(import.meta.dir, "fixtures");
export type FxVenue = "lighter-304" | "lighter-466324";

export const fxVenue = (cfg: Pick<LighterConfig, "signingChainId" | "venue">): FxVenue => (cfg.venue === "lighter-rh" ? "lighter-466324" : "lighter-304");

export function fx<T = unknown>(venue: FxVenue, name: string): T {
  return loadFixtureRecord<T>(venue, name, FIXTURES).response;
}

export function fxRecord(venue: FxVenue, name: string) {
  return loadFixtureRecord<unknown>(venue, name, FIXTURES);
}

/** Serve a fixture with its recorded status. */
export function serve(venue: FxVenue, name: string): Response {
  const r = fxRecord(venue, name);
  const body = typeof r.response === "string" ? r.response : JSON.stringify(r.response);
  return new Response(body, { status: r.status, headers: { "content-type": "application/json" } });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Default fixture routes for one config; extra routes override. */
export function fakeLighter(venue: FxVenue, extra: Record<string, FakeHandler> = {}) {
  const routes: Record<string, FakeHandler> = {
    "GET /": () => serve(venue, "root"),
    "GET /info": () => serve(venue, "info"),
    "GET /api/v1/orderBooks": () => serve(venue, "orderBooks"),
    "GET /api/v1/orderBookDetails": () => serve(venue, "orderBookDetails"),
    "GET /api/v1/fundings": () => serve(venue, "fundings"),
    "GET /api/v1/feeTiers": () => serve(venue, "feeTiers"),
    "GET /api/v1/systemConfig": () => serve(venue, "systemConfig"),
    "GET /api/v1/accountsByL1Address": () => serve(venue, "accountsByL1Address_none"),
    "GET /api/v1/account": () => serve(venue, "account"),
    "GET /api/v1/apikeys": () => serve(venue, "apikeys"),
    "GET /api/v1/nextNonce": () => serve(venue, "nextNonce"),
    ...(venue === "lighter-304" ? { "GET /api/v1/orderBookOrders": () => serve(venue, "orderBookOrders") } : {}),
    ...extra,
  };
  return fakeVenueServer(routes);
}

/** A fake clock for the governor so 1 req/s tests run instantly. */
export function fakeClock(start = 1_793_933_800_000) {
  let t = start;
  const opts: GovernorOptions = {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
  return { opts, now: () => t, advance: (ms: number) => (t += ms) };
}

export function readerFor(cfg: Readonly<LighterConfig>, url: string, o: { cache?: MarketDataCache | null; clock?: ReturnType<typeof fakeClock> } = {}): LighterReader {
  const clock = o.clock ?? fakeClock();
  const gov = createMemoryGovernor("test", clock.opts);
  return lighterReaderFor(cfg, gov, o.cache === undefined ? memoryMarketDataCache() : o.cache, { rest: url, now: clock.now });
}

/** The address the account fixtures carry in place of the real owner. */
export const FIXTURE_OWNER = "0x00000000000000000000000000000000000A11CE" as const;
