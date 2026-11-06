// R1, R2, R13: the builder field, the approval ceiling, and no vault ever.
import { describe, expect, test } from "bun:test";
import { CapstanError } from "@capstan/schema";
import { l1Digest } from "@capstan/signer-hl";
import { buildOrder, builderField } from "../../src";
import { BUILDER, book, ctx, setup, T0 } from "./util";

const intent = (over = {}) => ({ marketId: "hyperliquid:-:BTC", side: "buy" as const, size: "0.001", type: "market" as const, tif: "ioc" as const, reduceOnly: false, maxSlippageBps: 50, ...over });

describe("build", () => {
  test("builder-field", async () => {
    const { deps, cache } = setup();
    await cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
    const b = await buildOrder(intent(), ctx(), deps);
    const a = b.payload.action as any;
    expect(a.builder).toEqual({ b: BUILDER, f: 20 });
    expect(Object.keys(a)).toEqual(["type", "orders", "grouping", "builder"]);
    expect(b.preview.builderFeeBps).toBe(2);
    expect(b.preview.builderFee).toEqual({ address: BUILDER, rawUnit: "f=20" });
    expect(b.encoding).toBe("hl_l1_action");
    expect(b.digest).toBe(l1Digest(b.payload.action, null, b.payload.nonce, "Mainnet", b.payload.expiresAfter));
    expect(b.payload.expiresAfter).toBe(T0 + 30_000);
    expect(b.expiresAt).toBe(T0 + 30_000);
    expect(a.orders[0].t).toEqual({ limit: { tif: "Ioc" } });
    expect(a.orders[0].a).toBe(0);
    // lock tier
    const lock = await buildOrder(intent(), ctx({ builderFee: { tenthsBp: 10 } }), deps);
    expect((lock.payload.action as any).builder).toEqual({ b: BUILDER, f: 10 });
    expect(lock.preview.builderFee!.rawUnit).toBe("f=10");
    // any other f refused
    for (const f of [0, 5, 15, 21, 30, 100]) await expect(buildOrder(intent(), ctx({ builderFee: { tenthsBp: f } }), deps)).rejects.toThrow(/20 or 10/);
    // reduce-only still carries the builder field
    const ro = await buildOrder(intent({ reduceOnly: true, side: "sell" }), ctx(), deps);
    expect((ro.payload.action as any).builder.f).toBe(20);
    expect(builderField(ctx(), "0x00000000000000000000000000000000C0FFEE01", 30)).toEqual({ b: BUILDER, f: 20 });
  });

  test("approval-ceiling", async () => {
    const run = async (mbf: unknown, c = ctx()) => {
      const { deps, cache } = setup((b) => (b.type === "maxBuilderFee" ? mbf : undefined));
      await cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
      return buildOrder(intent(), c, deps);
    };
    const e1 = await run(15).catch((e) => e);
    expect(e1).toBeInstanceOf(CapstanError);
    expect(e1.code).toBe("BUILDER_APPROVAL_REQUIRED");
    expect(e1.message).toMatch(/Onboard again/);
    const e0 = await run(0).catch((e) => e);
    expect(e0.code).toBe("FEE_FREE_UNAVAILABLE");
    await expect(run(20)).resolves.toBeDefined();
    // the context ceiling also binds: approvedMaxBps 1 < f 2 bps
    expect((await run(30, ctx({ approvedMaxBps: 1 })).catch((e) => e)).code).toBe("BUILDER_APPROVAL_REQUIRED");
    // f=10 fits a 1 bps approval
    await expect(run(10, ctx({ builderFee: { tenthsBp: 10 }, approvedMaxBps: 1 }))).resolves.toBeDefined();
    // unreadable approval fails closed
    const { deps, cache } = setup((b) => (b.type === "maxBuilderFee" ? "Failed to deserialize the JSON body into the target type" : undefined));
    await cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
    expect((await buildOrder(intent(), ctx(), deps).catch((e) => e)).code).toBe("BUILDER_APPROVAL_REQUIRED");
    // no builder configured: no order at all
    const s2 = setup();
    await s2.cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
    expect((await buildOrder(intent(), ctx(), { ...s2.deps, cfg: { ...s2.deps.cfg, builderAddress: null } }).catch((e) => e)).code).toBe("FEE_FREE_UNAVAILABLE");
  });

  test("no-vault", async () => {
    const { deps, cache } = setup();
    await cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
    for (const it of [intent(), intent({ type: "limit", limitPx: "75000", tif: "gtc" }), intent({ side: "sell", reduceOnly: true })]) {
      const b = await buildOrder(it, ctx(), deps);
      expect(b.payload.vaultAddress).toBeNull();
      expect(JSON.stringify(b.payload)).not.toMatch(/vaultAddress":"0x/);
    }
  });

  test("guards", async () => {
    const { deps, cache } = setup();
    await cache.putBook(book("hyperliquid:-:BTC", 76000, T0 - 5000));
    expect((await buildOrder(intent(), ctx(), deps).catch((e) => e)).code).toBe("STALE_QUOTE");
    await cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
    expect((await buildOrder(intent(), ctx(), { ...deps, enabled: () => false }).catch((e) => e)).message).toMatch(/paused/);
    expect((await buildOrder(intent({ marketId: "hyperliquid:xyz:TSLA" }), ctx(), deps).catch((e) => e)).code).toBe("MARKET_NOT_EXECUTABLE");
    expect((await buildOrder(intent({ marketId: "hyperliquid:-:MATIC" }), ctx(), deps).catch((e) => e)).code).toBe("MARKET_NOT_EXECUTABLE");
    expect((await buildOrder(intent(), ctx(), { ...deps, isExecutable: () => false }).catch((e) => e)).code).toBe("MARKET_NOT_EXECUTABLE");
    expect((await buildOrder(intent({ clientOrderId: "0x12" }), ctx(), deps).catch((e) => e)).code).toBe("INVALID_INPUT");
    // market buy protective price is never above mark x (1 + slippage), rounded down
    const b = await buildOrder(intent({ maxSlippageBps: 50 }), ctx(), deps);
    expect(Number((b.payload.action as any).orders[0].p)).toBeLessThanOrEqual(76000 * 1.005 + 1e-9);
    const s = await buildOrder(intent({ side: "sell", maxSlippageBps: 50 }), ctx(), deps);
    expect(Number((s.payload.action as any).orders[0].p)).toBeGreaterThanOrEqual(76000 * 0.995 - 1e-9);
    // direct mode returns the post URL and body shape
    const d = await buildOrder(intent(), ctx({ mode: "direct" }), deps);
    expect(d.direct!.postUrl).toBe("https://api.hyperliquid.xyz/exchange");
    expect(d.direct!.body.action).toEqual(d.payload.action);
  });
});
