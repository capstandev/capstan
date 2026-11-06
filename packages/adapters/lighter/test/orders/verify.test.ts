// R7: verifySigned rejects any txInfo whose MarketIndex, BaseAmount, Price, IsAsk, Type, TimeInForce, ReduceOnly,
// TriggerPrice, OrderExpiry, integrator fields, AccountIndex, ApiKeyIndex or Nonce differs from the build, and any
// envelope whose hash differs from the one the hasher computes for the build (property test, 200 builds).
import { afterAll, describe, expect, test } from "bun:test";
import type { OrderIntent, SignedEnvelope } from "@capstan/schema";
import { buildCancel, buildOrder, verifySigned, verifySignedSync, type LighterBuild } from "../../src";
import { buildCtx, closeWasm, identity, NOW, setup, STD_FEE, wasm } from "../build-helpers";

let stop: (() => void) | null = null;
afterAll(() => {
  stop?.();
  closeWasm();
});

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORDER_FIELDS = ["MarketIndex", "BaseAmount", "Price", "IsAsk", "Type", "TimeInForce", "ReduceOnly", "TriggerPrice", "OrderExpiry", "AccountIndex", "ApiKeyIndex", "Nonce", "ClientOrderIndex", "ExpiredAt"];
const CANCEL_FIELDS = ["MarketIndex", "Index", "AccountIndex", "ApiKeyIndex", "Nonce", "ExpiredAt"];

describe("verify signed", () => {
  test("any-field-mismatch", async () => {
    const env = await setup("mainnet");
    stop = env.srv.stop;
    const { signer, hasher } = await wasm(304);
    const r = rng(7);
    const perps = env.markets.filter((m) => m.marketType === "perp" && m.status === "active").slice(0, 40);
    let checked = 0;
    for (let n = 0; n < 200; n++) {
      const m = await env.meta(perps[n % perps.length]!.venueSymbol);
      const id = identity(env.cfg, 1000 + n, 4 + (n % 100));
      const ctx = { ...buildCtx(env.cfg, id), cfg: env.cfg, market: m, hasher, fee: STD_FEE, nonce: n, integratorAccountIndex: n % 3 === 0 ? 0 : 18971 };
      let build: LighterBuild;
      if (n % 5 === 4) build = await buildCancel({ marketId: m.market.id, venueOrderId: String(281478187963734 + n) }, ctx);
      else {
        const px = m.markPx ?? "1";
        const o: OrderIntent = { marketId: m.market.id, side: r() < 0.5 ? "buy" : "sell", size: String(Number(m.minBaseAmount ?? "1") * (1 + Math.floor(r() * 5))), type: "limit", limitPx: px, tif: (["gtc", "ioc", "alo"] as const)[n % 3]!, reduceOnly: r() < 0.3, maxSlippageBps: 50 };
        build = await buildOrder(o, { ...ctx, clientOrderIndex: 1 + n });
      }
      const p = build.payload;
      const s = p.txType === 14 ? await signer.signCreateOrder(p.args) : await signer.signCancelOrder(p.args);
      expect(`0x${s.txHash}`).toBe(build.digest); // the hash is key-independent: server hasher == client signer
      const info = JSON.parse(s.txInfo) as Record<string, unknown>;
      const envOf = (txInfo: Record<string, unknown>, extra: Partial<SignedEnvelope> = {}): SignedEnvelope => ({ buildId: build.buildId, venue: build.venue, encoding: "lighter_tx", signedBody: { txType: p.txType, txInfo: JSON.stringify(txInfo) }, signature: String(txInfo.Sig), signerRef: `${id.accountIndex}:${id.apiKeyIndex}`, payloadHash: build.digest, ...extra });
      expect(await verifySigned(envOf(info), build, hasher, NOW)).toEqual({ ok: true });
      // one field changed at a time: always refused, naming the field
      for (const f of p.txType === 14 ? ORDER_FIELDS : CANCEL_FIELDS) {
        const bad = { ...info, [f]: (info[f] as number) + 1 };
        expect(verifySignedSync(envOf(bad), build, NOW)).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: f });
        checked++;
      }
      if (p.txType === 14) {
        const attrs = (info.L2TxAttributes ?? {}) as Record<string, number>;
        const swaps: [Record<string, number>, string][] = [
          [{ ...attrs, "1": 777 }, "L2TxAttributes.1"],
          [{ ...attrs, "2": 10 }, "L2TxAttributes.2"],
          [{ ...attrs, "3": 10 }, "L2TxAttributes.3"],
          [{ ...attrs, "4": 1 }, "L2TxAttributes.4"],
          [{ ...attrs, "6": 2 }, "L2TxAttributes.6"],
        ];
        for (const [a, field] of swaps) {
          expect(verifySignedSync(envOf({ ...info, L2TxAttributes: a }), build, NOW)).toMatchObject({ ok: false, code: "PAYLOAD_MISMATCH", field });
          checked++;
        }
        if (p.args.integratorAccountIndex !== 0) expect(verifySignedSync(envOf({ ...info, L2TxAttributes: null }), build, NOW)).toMatchObject({ ok: false, field: "L2TxAttributes.1" });
      }
      // an extra field, a missing signature, a different tx type, another envelope hash, a late submit
      expect(verifySignedSync(envOf({ ...info, Amount: 1 }), build, NOW)).toMatchObject({ ok: false, code: "PAYLOAD_MISMATCH", field: "Amount" });
      expect(verifySignedSync(envOf({ ...info, Sig: "" }), build, NOW)).toMatchObject({ ok: false, code: "BAD_SIGNATURE" });
      expect(verifySignedSync({ ...envOf(info), signedBody: { txType: 12, txInfo: JSON.stringify(info) } }, build, NOW)).toMatchObject({ ok: false, field: "txType" });
      expect(verifySignedSync(envOf(info, { payloadHash: `0x${"ab".repeat(40)}` }), build, NOW)).toMatchObject({ ok: false, field: "txHash" });
      expect(verifySignedSync(envOf(info), build, build.expiresAt + 1)).toEqual({ ok: false, code: "BUILD_EXPIRED" });
      checked += 5;
    }
    // the hasher's own answer decides: a hasher that disagrees with the build fails the full check
    const m = await env.meta("ETH");
    const b = await buildOrder({ marketId: m.market.id, side: "buy", size: "0.1", type: "limit", limitPx: "2000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 }, { ...buildCtx(env.cfg), cfg: env.cfg, market: m, hasher, fee: STD_FEE, nonce: 1, clientOrderIndex: 1, integratorAccountIndex: 0 });
    const s = await signer.signCreateOrder(b.payload.txType === 14 ? b.payload.args : (null as never));
    const e: SignedEnvelope = { buildId: b.buildId, venue: b.venue, encoding: "lighter_tx", signedBody: { txType: 14, txInfo: s.txInfo }, signature: JSON.parse(s.txInfo).Sig, signerRef: "99:4", payloadHash: b.digest };
    const liar = { txHashForOrder: async () => "cd".repeat(40), txHashForCancel: async () => "cd".repeat(40) };
    expect(await verifySigned(e, b, liar, NOW)).toMatchObject({ ok: false, field: "txHash" });
    expect(checked).toBeGreaterThan(200 * 6);
  }, 120_000);
});
