// R12: quote == execution. For 50 recorded books (25 per config) the preview's average fill, walked on the cached
// book, equals the walk at the built integer price after scaling, and the built price never passes the bound.
import { afterAll, describe, expect, test } from "bun:test";
import { Dec, type OrderBook } from "@capstan/schema";
import { buildOrder, fromVenueUnits, walkBook } from "../../src";
import { buildCtx, closeWasm, setup, STD_FEE, wasm } from "../build-helpers";
import { fx, type FxVenue } from "../helpers";

type Rec = { market_id: number; symbol: string; asks: { price: string; remaining_base_amount: string }[]; bids: { price: string; remaining_base_amount: string }[] };
const agg = (l: Rec["asks"]): [string, string][] => {
  const m = new Map<string, number>();
  for (const x of l) m.set(x.price, (m.get(x.price) ?? 0) + Number(x.remaining_base_amount));
  return [...m.entries()].map(([p, s]) => [p, String(s)] as [string, string]);
};

const stops: (() => void)[] = [];
afterAll(() => {
  stops.forEach((f) => f());
  closeWasm();
});

describe("quote", () => {
  test("preview-equals-build", async () => {
    let n = 0;
    for (const [name, v, chain] of [
      ["mainnet", "lighter-304", 304],
      ["rh", "lighter-466324", 466324],
    ] as const) {
      const env = await setup(name);
      stops.push(env.srv.stop);
      const { hasher } = await wasm(chain);
      for (const rec of fx<Rec[]>(v as FxVenue, "books25")) {
        const m = await env.meta(rec.symbol);
        const book: OrderBook = { marketId: m.market.id, asks: agg(rec.asks).sort((a, b) => Number(a[0]) - Number(b[0])), bids: agg(rec.bids).sort((a, b) => Number(b[0]) - Number(a[0])), asOf: new Date().toISOString() };
        if (!book.asks.length || !book.bids.length) continue;
        for (const side of ["buy", "sell"] as const) {
          const levels = side === "buy" ? book.asks : book.bids;
          // take half of the top three levels so the walk crosses levels
          const depth = levels.slice(0, 3).reduce((s, [, sz]) => s + Number(sz), 0) / 2;
          const size = Dec.toString(Dec.parse(String(depth.toFixed(12)), m.sizeDecimals, "down"));
          if (Number(size) < Number(m.minBaseAmount ?? "0")) continue;
          const b = await buildOrder({ marketId: m.market.id, side, size, type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 100 }, { ...buildCtx(env.cfg), cfg: env.cfg, market: m, book, fee: STD_FEE, hasher, nonce: 1, clientOrderIndex: 1, integratorAccountIndex: 0 });
          const a = b.payload.txType === 14 ? b.payload.args : null;
          const builtPx = fromVenueUnits(a!.price, m.priceDecimals);
          const sizeBuilt = fromVenueUnits(a!.baseAmount, m.sizeDecimals);
          const atBuilt = walkBook(book, side, sizeBuilt, builtPx);
          expect(b.quote!.avgFillPx).toBe(atBuilt.avg ? Dec.toString(atBuilt.avg) : null);
          expect(b.preview.px).toBe(builtPx);
          expect(b.preview.size).toBe(sizeBuilt);
          // the protective price stays inside the 100 bps bound from the best level
          const best = Number(levels[0]![0]);
          if (side === "buy") expect(Number(builtPx)).toBeLessThanOrEqual(best * 1.01 + 1e-9);
          else expect(Number(builtPx)).toBeGreaterThanOrEqual(best * 0.99 - 1e-9);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThanOrEqual(80);
  }, 120_000);
});
