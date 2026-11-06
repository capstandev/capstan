// R14 (todo 17): POST and GET /v1/quote validate with zod and answer INVALID_INPUT; a valid quote is stored in
// quote_snapshots under hash = receiptHint = sha256(JCS(quote)).
import { afterAll, describe, expect, test } from "bun:test";
import type { MarketDataCache } from "@capstan/core";
import { jcs, memoryCatalog, sha256Hex, type QuoteAdapter, type QuoteMarket } from "@capstan/quote";
import type { FundingSnapshot, OrderBook, VenueId } from "@capstan/schema";
import { Hono } from "hono";
import { createQuoteRoutes, dbQuoteStore, queryToRequest, type QuoteRouteDeps, type QuoteStore } from "../src/routes/quote.routes";

const PG = process.env.DATABASE_URL;
const NOW = Date.parse("2026-11-06T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ETH: QuoteMarket = {
  id: "hyperliquid:-:ETH",
  venue: "hyperliquid",
  dex: null,
  venueSymbol: "ETH",
  marketType: "perp",
  canonicalAsset: "CR:ETH",
  collateralAsset: "USDC",
  tickSize: "0.1",
  lotSize: "0.0001",
  minNotional: null,
  maxLeverage: 25,
  marginModes: ["cross", "isolated"],
  fundingIntervalS: 28800,
  fundingSettleIntervalS: 3600,
  sessionHours: null,
  oiCapUsd: null,
  builderFeeUnit: "tenths_bp",
  status: "active",
  executable: true,
  dataFreshness: "live",
  updatedAt: iso(NOW),
};
const BOOK: OrderBook = { marketId: ETH.id, bids: [["1999.5", "10"], ["1999", "10"]], asks: [["2000.5", "10"], ["2001", "10"]], asOf: iso(NOW - 100) };
const FUND: FundingSnapshot = { marketId: ETH.id, ratePerInterval: "0.00001", intervalS: 3600, ratePerHour: "0.00001", rateAnnualised: "0.0876", predictedNext: null, nextSettlementAt: iso(NOW), capPerHour: "0.04", source: "venue", asOf: iso(NOW - 1000) };

function app(store: QuoteStore | null = null) {
  const cache = { getBook: async (id: string) => (id === ETH.id ? BOOK : null), getFunding: async (id: string) => (id === ETH.id ? FUND : null), getMark: async () => null } as unknown as MarketDataCache;
  const hl: QuoteAdapter = { caps: { venue: "hyperliquid", execution: true, keyType: "secp256k1", delegation: "agent", canWithdraw: false, builderFee: null, collateral: ["USDC"], directSubmitSupported: true, publicAccountReads: true }, getBook: async () => BOOK, getFunding: async () => FUND };
  const deps: QuoteRouteDeps = { adapters: new Map<VenueId, QuoteAdapter>([["hyperliquid", hl]]), cache, catalog: memoryCatalog([ETH]), depeg: { usdgUsdcBps: async () => null, usdtUsdcBps: async () => null }, store, now: () => NOW };
  const h = new Hono();
  for (const r of createQuoteRoutes(() => deps)) h.on(r.method, `/v1${r.path}`, (c) => r.handler(c));
  return h;
}

const post = (h: Hono, body: unknown) => h.request("/v1/quote", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const good = { canonicalAsset: "CR:ETH", side: "buy", sizeBase: "1", leverage: 5, holdHours: 2, orderType: "market" };

describe("quote routes", () => {
  test("validation", async () => {
    const h = app();
    const bad: [unknown, string][] = [
      ["not json", "body must be JSON"],
      [{ ...good, sizeBase: undefined }, "sizeBase or notionalUsd"], // both missing
      [{ ...good, notionalUsd: "100" }, "sizeBase or notionalUsd"], // both given
      [{ ...good, canonicalAsset: undefined }, "canonicalAsset or marketIds"],
      [{ ...good, side: "long" }, "side"],
      [{ ...good, sizeBase: "-1" }, "sizeBase"],
      [{ ...good, sizeBase: 1 }, "sizeBase"], // amounts are strings, never JSON numbers
      [{ ...good, orderType: "limit" }, "limitPx is required"],
      [{ ...good, leverage: 0 }, "leverage"],
      [{ ...good, leverage: 30 }, "above every market maximum"], // ETH max is 25
      [{ ...good, canonicalAsset: undefined, marketIds: [ETH.id], leverage: 26 }, "above the hyperliquid:-:ETH maximum 25"],
      [{ ...good, canonicalAsset: undefined, marketIds: ["hyperliquid:-:NOPE"] }, "unknown market"],
      [{ ...good, canonicalAsset: "CR:DOGE" }, "no reviewed markets"],
      [{ ...good, owner: "0x123" }, "owner"],
    ];
    for (const [body, msg] of bad) {
      const res = await post(h, body);
      expect(res.status).toBe(400);
      const j = (await res.json()) as { error: { code: string; message: string } };
      expect(j.error.code).toBe("INVALID_INPUT");
      expect(j.error.message).toContain(msg);
    }
    // a valid request quotes
    const ok = await post(h, good);
    expect(ok.status).toBe(200);
    const q = (await ok.json()) as { best: string; legs: { status: string; totalCostBps: number }[]; receiptHint: string };
    expect(q.best).toBe(ETH.id);
    expect(q.legs[0]!.status).toBe("ok");
    // GET form: same validation, numbers coerced, marketIds comma-separated
    expect(queryToRequest({ marketIds: "a:-:B, c:-:D", leverage: "3", holdHours: "0", sizeBase: "1" })).toEqual({ marketIds: ["a:-:B", "c:-:D"], leverage: 3, holdHours: 0, sizeBase: "1" });
    const g = await h.request("/v1/quote?canonicalAsset=CR:ETH&side=sell&notionalUsd=1000&leverage=2&holdHours=1&orderType=market");
    expect(g.status).toBe(200);
    const gb = await h.request("/v1/quote?canonicalAsset=CR:ETH&side=sell&leverage=2&holdHours=1&orderType=market");
    expect(gb.status).toBe(400);
    expect(((await gb.json()) as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
  });

  test("receiptHint is the sha256 of the JCS quote", async () => {
    const stored: { id: string; hash: string; body: unknown }[] = [];
    const h = app({ put: async (id, hash, body) => void stored.push({ id, hash, body }) });
    const res = await post(h, good);
    const q = (await res.json()) as { requestId: string; receiptHint: string };
    expect(stored.length).toBe(1);
    expect(stored[0]!.hash).toBe(q.receiptHint);
    expect(stored[0]!.id).toBe(q.requestId);
    expect(sha256Hex(jcs({ ...(stored[0]!.body as object), receiptHint: "" })) as string).toBe(q.receiptHint);
  });
});

(PG ? describe : describe.skip)("quote routes with a database", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterAll(async () => {
    await cleanup?.();
  }, 30_000);
  test(
    "quote_snapshots row",
    async () => {
      const { createTempDatabase, createDb, closeDb } = await import("@capstan/core");
      const { db: schema } = await import("@capstan/schema");
      const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_q" });
      const db = createDb(t.url, { max: 2 });
      cleanup = async () => {
        await closeDb(db);
        await t.drop();
      };
      const res = await post(app(dbQuoteStore(db)), good);
      const q = (await res.json()) as { requestId: string; receiptHint: string };
      const rows = await db.select().from(schema.quoteSnapshots);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ id: q.requestId, hash: q.receiptHint });
    },
    30_000,
  );
});
