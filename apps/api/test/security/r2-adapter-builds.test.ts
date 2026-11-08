// Security review r2, D2-ADP-07 (review-r1:7 F7): a buy sized past the visible book was previewed at the partial
// average of what is visible, so a policy cap could be passed and then exceeded by the deeper fill or the resting
// rest. The notional now prices the unfilled rest at the built limit. Hyperliquid here; Aster and Lighter below use
// the same rule. D2-ADP-04 (review-r1:7 F4): a Lighter market order with no fresh book is refused, never priced from
// a cached mark.
import { describe, expect, test } from "bun:test";
import { buildAsterOrder } from "@capstan/adapter-aster";
import { buildOrder as lighterBuild } from "@capstan/adapter-lighter";
import { buildOrder } from "@capstan/adapter-hyperliquid";
import { book, ctx, setup, T0 } from "../../../../packages/adapters/hyperliquid/test/orders/util";
import { ctx as asterCtx } from "../../../../packages/adapters/aster/test/orders/setup";
import { bookFromLevels, buildCtx as lighterCtx, closeWasm, NOW as LNOW, setup as lighterSetup, STD_FEE, wasm } from "../../../../packages/adapters/lighter/test/build-helpers";
import { afterAll } from "bun:test";
import { AsterNonce } from "../../../../packages/signers/aster/src";

afterAll(() => closeWasm());

describe("security r2 D2-ADP-07 and D2-ADP-04", () => {
  test("hyperliquid-buy-past-visible-depth-prices-the-rest-at-the-limit", async () => {
    const { deps, cache } = setup();
    // 3 levels of 0.001 BTC from 76000.5: a 0.01 buy sees 0.003 and rests or fills deeper for 0.007
    await cache.putBook(book("hyperliquid:-:BTC", 76000, T0, 3, 0.5, "0.001"));
    const b = await buildOrder({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.01", type: "limit", limitPx: "77000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 }, ctx(), deps);
    expect(b.preview.warnings.some((w) => w.startsWith("insufficient_depth"))).toBe(true);
    const visible = 0.001 * (76000.5 + 76001 + 76001.5);
    expect(Number(b.preview.notionalUsd)).toBeCloseTo(visible + 0.007 * 77000, 6);
  });

  test("aster-buy-past-visible-depth-prices-the-rest-at-the-limit", async () => {
    const market = { id: "aster:-:BTCUSDT", venue: "aster", status: "active", tickSize: "0.1", lotSize: "0.001", minNotional: "5", collateralAsset: "USDT" } as never;
    const b = await buildAsterOrder(
      { marketId: "aster:-:BTCUSDT", side: "buy", size: "0.020", type: "limit", limitPx: "77000.0", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 },
      asterCtx(),
      { network: "Mainnet", builder: "0x00000000000000000000000000000000c0ffee02", market: async () => market, book: async () => ({ marketId: "aster:-:BTCUSDT", asks: [["76000.0", "0.005"]], bids: [["75990.0", "1"]], asOf: new Date().toISOString() }) as never, nonceFor: () => new AsterNonce() },
    );
    expect(Number(b.preview.notionalUsd)).toBeCloseTo(0.005 * 76000 + 0.015 * 77000, 6);
  });

  test("lighter-buy-past-visible-depth-and-market-orders-need-a-fresh-book", async () => {
    const env = await lighterSetup("mainnet");
    try {
      const { hasher } = await wasm(304);
      const eth = await env.meta("ETH");
      const base = { ...lighterCtx(env.cfg), cfg: env.cfg, market: eth, fee: STD_FEE, hasher, integratorAccountIndex: 0, nonce: 1, clientOrderIndex: 1 };
      const thin = bookFromLevels(eth.market.id, [["2243.15", "0.1"]], [["2243.00", "4"]]);
      const lim = await lighterBuild({ marketId: eth.market.id, side: "buy", size: "0.5", type: "limit", limitPx: "2300", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 }, { ...base, book: thin });
      expect(Number(lim.preview.notionalUsd)).toBeCloseTo(0.1 * 2243.15 + 0.4 * 2300, 2);
      // market: no book (the read failed) or an old one is STALE_QUOTE, never the cached mark
      const mkt = { marketId: eth.market.id, side: "buy" as const, size: "0.5", type: "market" as const, tif: "ioc" as const, reduceOnly: false, maxSlippageBps: 50 };
      const code = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? "thrown");
      expect(await code(lighterBuild(mkt, { ...base, market: { ...eth, markPx: "2243.10" }, book: null }))).toBe("STALE_QUOTE");
      expect(await code(lighterBuild(mkt, { ...base, book: { ...thin, asOf: new Date(LNOW - 3_001).toISOString() } }))).toBe("STALE_QUOTE");
      expect(await code(lighterBuild(mkt, { ...base, book: thin }))).toBeNull();
    } finally {
      env.srv.stop();
    }
  });
});
