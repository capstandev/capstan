// R9 (todo 15): quote == execution on 50 recorded books; market orders go out as IOC LIMIT at the slippage bound.
import { describe, expect, test } from "bun:test";
import { slippageBound, walkBook, type AsterOrderPayload } from "../../src/orders";
import { normalizeBook } from "../../src/normalize";
import { books50 } from "../helpers";
import { ctx, intent, setup } from "./setup";

describe("aster quote", () => {
  test("preview-equals-build", async () => {
    const books = books50();
    expect(Object.keys(books).length).toBe(50);
    const s = setup();
    try {
      const markets = new Map((await s.reader.listMarkets()).map((m) => [m.venueSymbol, m]));
      let i = 0;
      for (const [symbol, raw] of Object.entries(books)) {
        const m = markets.get(symbol)!;
        const book = normalizeBook(symbol, raw, 0);
        const side = i++ % 2 ? "sell" : "buy";
        // size: about two thirds of the first three levels, on the lot grid
        const levels = (side === "buy" ? book.asks : book.bids).slice(0, 3);
        const lots = Math.max(1, Math.floor((levels.reduce((a, [, sz]) => a + Number(sz), 0) * 0.66) / Number(m.lotSize)));
        const size = (await import("@capstan/schema")).Dec.toString((await import("@capstan/schema")).Dec.mul((await import("@capstan/schema")).Dec.parse(m.lotSize, 18), (await import("@capstan/schema")).Dec.parse(String(lots), 0), 18));
        const it = intent({ marketId: m.id, side, size, type: "market", limitPx: undefined, tif: "ioc", maxSlippageBps: 100 });
        const b = await s.adapter.buildOrder(it, ctx()).catch((e: Error) => e);
        if (b instanceof Error) {
          expect(b.message).toContain("minimum"); // tiny books under the venue minimum notional
          continue;
        }
        const p = b.payload as AsterOrderPayload;
        const get = (k: string) => p.params.find(([n]) => n === k)?.[1];
        expect(get("type")).toBe("LIMIT"); // never a raw MARKET
        expect(get("timeInForce")).toBe("IOC");
        expect(get("price")).toBe(slippageBound(book, side, 100, m.tickSize));
        const w = walkBook(book, side, size, String(get("price")));
        expect(b.preview.px).toBe(String(get("price")));
        expect(b.preview.size).toBe(String(get("quantity")));
        if (w.avgPx) {
          const notional = (await import("@capstan/schema")).Dec;
          expect(b.preview.notionalUsd).toBe(notional.toString(notional.mul(notional.parse(size, 18), notional.parse(w.avgPx, 18), 18)));
        }
        expect(b.preview.warnings.some((x) => x.startsWith("only "))).toBe(!w.complete);
      }
      // the venue quote walks to the same price rule
      const q = await s.adapter.quote({ marketId: "aster:-:BTCUSDT", side: "buy", sizeBase: "0.01", leverage: 1, holdHours: 8, orderType: "market" });
      const bb = normalizeBook("BTCUSDT", books.BTCUSDT!, 0);
      expect(q.avgFillPx).toBe(walkBook(bb, "buy", "0.01", slippageBound(bb, "buy", 50, markets.get("BTCUSDT")!.tickSize)).avgPx!);
      expect(q.builderFeeBps).toBe(2);
      expect(q.status).toBe("ok");
    } finally {
      s.stop();
    }
  });
});
