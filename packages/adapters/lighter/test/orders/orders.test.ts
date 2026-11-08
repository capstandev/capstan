// R6 (every build carries integrator fee 0 and builder fee 0), R11 (tx expiry at least 5 s away, GTT 5 min to 30
// days, IOC 0), R14 (close-all = one reduce-only IOC per open position, full size, consecutive nonces, never opening).
import { afterAll, describe, expect, test } from "bun:test";
import { CapstanError, type OrderIntent } from "@capstan/schema";
import { buildCloseAll, buildOrder, NonceTracker, LIGHTER_CONFIGS, accountSnapshot, type LighterAccountRaw } from "../../src";
import { bookFromLevels, buildCtx, closeWasm, identity, NOW, setup, STD_FEE, wasm } from "../build-helpers";
import { fx } from "../helpers";

let srvs: { stop(): void }[] = [];
afterAll(() => {
  srvs.forEach((s) => s.stop());
  closeWasm();
});

const intent = (o: Partial<OrderIntent> = {}): OrderIntent => ({ marketId: "lighter-mainnet:-:ETH", side: "buy", size: "0.5", type: "limit", limitPx: "2243.15", tif: "gtc", reduceOnly: false, maxSlippageBps: 50, ...o });

describe("orders", () => {
  test("zero-fee", async () => {
    const env = await setup("mainnet");
    srvs.push(env.srv);
    const { hasher } = await wasm(304);
    const eth = await env.meta("ETH");
    const book = bookFromLevels(eth.market.id, [["2243.15", "3"], ["2243.20", "5"]], [["2243.00", "4"]]);
    for (const [i, o] of [intent(), intent({ type: "market", tif: "ioc", limitPx: undefined }), intent({ tif: "alo", side: "sell", limitPx: "2244" }), intent({ tif: "ioc", reduceOnly: true })].entries()) {
      const b = await buildOrder(o, { ...buildCtx(env.cfg), cfg: env.cfg, market: eth, book, fee: { ...STD_FEE, takerBps: 2.8, makerBps: 0.4, tier: "premium" }, hasher, integratorAccountIndex: 18971, nonce: 10 + i, clientOrderIndex: 100 + i });
      expect(b.payload.txType).toBe(14);
      const a = b.payload.txType === 14 ? b.payload.args : null;
      expect(a!.integratorTakerFee).toBe(0);
      expect(a!.integratorMakerFee).toBe(0);
      expect(a!.integratorAccountIndex).toBe(18971);
      expect(b.preview.builderFeeBps).toBe(0);
      expect(b.preview.builderFee).toBeNull();
      expect(b.preview.venueFeeBps).toBe(o.tif === "alo" ? 0.4 : 2.8);
      expect(b.digest).toMatch(/^0x[0-9a-f]{80}$/);
      expect(b.signer).toBe("delegated_key");
      expect(b.expiresAt).toBe(NOW + 30_000);
    }
  });

  test("expiry-bounds", async () => {
    const env = await setup("mainnet");
    srvs.push(env.srv);
    const { hasher } = await wasm(304);
    const eth = await env.meta("ETH");
    const base = { ...buildCtx(env.cfg), cfg: env.cfg, market: eth, fee: STD_FEE, hasher, integratorAccountIndex: 0, nonce: 1, clientOrderIndex: 1 };
    const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as CapstanError).message;
    // tx expiry: default now + 10 min - 1 s; less than 5 s away is refused before signing
    const def = await buildOrder(intent(), base);
    expect(def.payload.args.expiredAt).toBe(NOW + 599_000);
    expect(await code(buildOrder(intent(), { ...base, expiredAt: NOW + 4_999 }))).toContain("5 s");
    expect((await buildOrder(intent(), { ...base, expiredAt: NOW + 5_000 })).payload.args.expiredAt).toBe(NOW + 5_000);
    expect(await code(buildOrder(intent(), { ...base, expiredAt: NOW + 700_000 }))).toContain("10 minutes");
    // GTT order expiry 5 min .. 30 days; default 28 days
    const gtt = def.payload.txType === 14 ? def.payload.args : null;
    expect(gtt!.orderExpiry).toBe(NOW + 28 * 86_400_000);
    expect(gtt!.timeInForce).toBe(1);
    expect(await code(buildOrder(intent(), { ...base, orderExpiryMs: NOW + 299_999 }))).toContain("5 minutes to 30 days");
    expect(await code(buildOrder(intent(), { ...base, orderExpiryMs: NOW + 30 * 86_400_000 + 1 }))).toContain("5 minutes to 30 days");
    expect((await buildOrder(intent(), { ...base, orderExpiryMs: NOW + 300_000 })).payload.args).toMatchObject({ orderExpiry: NOW + 300_000 });
    // IOC uses 0 and refuses anything else
    const ioc = await buildOrder(intent({ tif: "ioc" }), base);
    expect(ioc.payload.args).toMatchObject({ orderExpiry: 0, timeInForce: 0 });
    expect(await code(buildOrder(intent({ tif: "ioc" }), { ...base, orderExpiryMs: NOW + 600_000 }))).toContain("IOC");
    // market orders are IOC (type 1) at the slippage bound
    expect(await code(buildOrder(intent({ type: "market", tif: "gtc" }), base))).toContain("IOC");
  });

  test("close-all-reduce-only", async () => {
    const env = await setup("rh");
    srvs.push(env.srv);
    const { hasher } = await wasm(466324);
    const raw = fx<{ accounts: LighterAccountRaw[] }>("lighter-466324", "account").accounts[0]!;
    // the recorded account plus a long, so both sides are covered
    const withLong: LighterAccountRaw = {
      ...raw,
      positions: [...raw.positions!, { market_id: 0, symbol: "ETH", sign: 1, position: "0.0250", avg_entry_price: "2200.00", position_value: "56.075000", unrealized_pnl: "1.07", margin_mode: 0, initial_margin_fraction: "4.52" }],
    };
    const id = identity(env.cfg, 3, 9);
    const acct = accountSnapshot(env.cfg, id, withLong, new Date(NOW).toISOString());
    const open = acct.positions;
    expect(open.length).toBeGreaterThanOrEqual(2);
    // a fresh book per market, read at close time (security r2 D2-ADP-04)
    const reader = { getAccount: async () => acct, marketMeta: env.reader.marketMeta, getBook: async (m: string) => bookFromLevels(m, [["2300.00", "100"]], [["2200.00", "100"]]) };
    const nonces = new NonceTracker({ nextNonce: async () => 41, tx: async () => ({ found: false, status: null }) }, () => NOW);
    const builds = await buildCloseAll(id, { ...buildCtx(env.cfg, id), cfg: env.cfg, reader, nonces, hasher, fee: STD_FEE, integratorAccountIndex: 0 });
    expect(builds.length).toBe(open.length);
    builds.forEach((b, i) => {
      const a = b.payload.txType === 14 ? b.payload.args : null;
      const p = open[i]!;
      expect(a!.reduceOnly).toBe(true);
      expect(a!.timeInForce).toBe(0);
      expect(a!.orderType).toBe(1);
      expect(a!.orderExpiry).toBe(0);
      expect(a!.isAsk).toBe(p.side === "long"); // always the closing side
      expect(b.preview.size).toBe(p.size.includes(".") ? b.preview.size : p.size);
      expect(Number(b.preview.size)).toBe(Number(p.size)); // the full position
      expect(a!.nonce).toBe(41 + i); // consecutive on one key
      expect(a!.apiKeyIndex).toBe(9);
    });
    // a market the account holds can be closed even when it is not reviewed for opening; opening it is refused
    const notReviewed = await env.reader.marketMeta(open[0]!.marketId);
    await expect(buildOrder(intent({ marketId: open[0]!.marketId, reduceOnly: false }), { ...buildCtx(env.cfg, id), cfg: LIGHTER_CONFIGS.rh, market: notReviewed, fee: STD_FEE, hasher, integratorAccountIndex: 0, nonce: 1, clientOrderIndex: 1 })).rejects.toMatchObject({ code: "MARKET_NOT_EXECUTABLE" });
  });
});
