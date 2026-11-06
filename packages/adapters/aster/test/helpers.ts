// Test helpers: recorded fixtures (test/fixtures, captured live read-only), a fake Aster on a local port, and a governor
// that records every cost it is asked for.
import { memoryMarketDataCache } from "@capstan/core";
import { createMemoryGovernor, fakeVenueServer, venueHttp, type FakeHandler, type Governor } from "@capstan/venue-client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASTER_MAINNET } from "../src/config";
import type { AsterExchangeInfo, AsterFundingInfoRow, AsterPremiumIndex, AsterDepth } from "../src/normalize";
import { createAsterReader, type AsterReaderOptions } from "../src/read";

export const FIXTURES = join(import.meta.dir, "fixtures");

export function fixture<T>(name: string): T {
  return (JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as { response: T }).response;
}

export const exchangeInfo = () => fixture<AsterExchangeInfo>("exchangeInfo.all");
export const fundingInfo = () => fixture<AsterFundingInfoRow[]>("fundingInfo.all");
export const premiumIndexAll = () => fixture<AsterPremiumIndex[]>("premiumIndex.all");
export const books50 = () => fixture<Record<string, AsterDepth>>("depth20.books50");

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export interface RecordingGovernor extends Governor {
  costs: { venue: string; cost: number }[];
}

export function recordingGovernor(inner: Governor = createMemoryGovernor("test")): RecordingGovernor {
  const costs: { venue: string; cost: number }[] = [];
  return {
    costs,
    egress: inner.egress,
    acquire(venue, cost, opts) {
      costs.push({ venue, cost });
      return inner.acquire(venue, cost, opts);
    },
    observe: (v, r) => inner.observe(v, r),
    usage: (v) => inner.usage(v),
    flush: () => inner.flush(),
  };
}

/** Default fake Aster: exchangeInfo, fundingInfo, premiumIndex (one or all), depth from the 50 recorded books. */
export function defaultRoutes(over: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  const pi = premiumIndexAll();
  const books = books50();
  return {
    "GET /fapi/v3/exchangeInfo": () => json(exchangeInfo()),
    "GET /fapi/v3/fundingInfo": () => json(fundingInfo()),
    "GET /fapi/v3/premiumIndex": (req) => {
      const s = new URL(req.url).searchParams.get("symbol");
      if (!s) return json(pi);
      const row = pi.find((r) => r.symbol === s);
      return row ? json(row) : json({ code: -1121, msg: "Invalid symbol." }, 400);
    },
    "GET /fapi/v3/depth": (req) => {
      const s = new URL(req.url).searchParams.get("symbol")!;
      const b = books[s];
      return b ? json(b) : json({ code: -1121, msg: "Invalid symbol." }, 400);
    },
    ...over,
  };
}

export function harness(routes: Record<string, FakeHandler> = defaultRoutes(), opts: AsterReaderOptions & { gov?: Governor } = {}) {
  const server = fakeVenueServer(routes);
  const gov = (opts.gov ?? recordingGovernor()) as RecordingGovernor;
  const http = venueHttp("aster", server.url, gov, { backoffBaseMs: 1 });
  const cache = memoryMarketDataCache();
  const reader = createAsterReader(ASTER_MAINNET, http, cache, { sleep: async () => {}, ...opts });
  return { server, gov, http, cache, reader, stop: () => server.stop() };
}
