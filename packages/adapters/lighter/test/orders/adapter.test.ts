// The composed adapter end to end on recorded data: builds stay off unless execution is on; with it on, a build is
// seeded from nextNonce, signed by a real WASM key, verified and sent as a form; the per-L1 bucket is taken.
import { afterAll, describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { createAdapter, createLighterAdapter, LIGHTER_CONFIGS, type LighterBuild } from "../../src";
import { buildCtx, closeWasm, identity, NOW, wasm } from "../build-helpers";
import { fakeClock, fakeLighter, json } from "../helpers";

const sent: URLSearchParams[] = [];
const srv = fakeLighter("lighter-304", {
  "POST /api/v1/sendTx": async (req) => {
    sent.push(new URLSearchParams(await req.text()));
    return json({ code: 200, message: "", tx_hash: "cd".repeat(40) });
  },
});
afterAll(() => {
  srv.stop();
  closeWasm();
});

describe("adapter", () => {
  test("execution flag, build, sign, verify, submit", async () => {
    const off = createAdapter({ config: "mainnet", gov: createMemoryGovernor("t", fakeClock().opts), cache: null, rest: srv.url, execution: false });
    await expect(off.buildOrder({ marketId: "lighter-mainnet:-:ETH", side: "buy", size: "0.1", type: "limit", limitPx: "2000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 }, buildCtx(LIGHTER_CONFIGS.mainnet))).rejects.toMatchObject({ code: "MARKET_NOT_EXECUTABLE" });

    const { signer, hasher } = await wasm(304);
    const gov = createMemoryGovernor("t", fakeClock().opts); // 1 req/s on a fake clock
    const lanes: string[] = [];
    const spy = { ...gov, acquire: async (...a: Parameters<typeof gov.acquire>) => (lanes.push(String(a[0])), gov.acquire(...a)) };
    const http = venueHttp("lighter-304", srv.url, spy);
    const a = createLighterAdapter(LIGHTER_CONFIGS.mainnet, { http, cache: memoryMarketDataCache(), gov: spy, hasher, execution: true, integratorAccountIndex: 18971, now: () => NOW });
    // the catalog review decides executability; mark ETH reviewed for this test
    const meta = await a.reader.marketMeta("lighter-mainnet:-:ETH");
    meta.market.executable = true;
    const id = identity(LIGHTER_CONFIGS.mainnet, 3, 4);
    const b = (await a.buildOrder({ marketId: "lighter-mainnet:-:ETH", side: "buy", size: "0.1", type: "limit", limitPx: "2000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 }, buildCtx(LIGHTER_CONFIGS.mainnet, id))) as LighterBuild;
    expect(b.payload.args.nonce).toBe(0); // seeded from the recorded nextNonce
    expect(b.payload.txType === 14 && b.payload.args.integratorAccountIndex).toBe(18971);
    const s = await signer.signCreateOrder(b.payload.txType === 14 ? b.payload.args : (null as never));
    const env = { buildId: b.buildId, venue: b.venue, encoding: "lighter_tx" as const, signedBody: { txType: 14, txInfo: s.txInfo }, signature: JSON.parse(s.txInfo).Sig as string, signerRef: "3:4", payloadHash: `0x${s.txHash}` as const };
    expect(a.verifySigned(env, b)).toEqual({ ok: true });
    const r = await a.submit(env);
    expect(r).toMatchObject({ status: "accepted", txHash: "cd".repeat(40) });
    expect(sent.at(-1)!.get("tx_type")).toBe("14");
    expect(sent.at(-1)!.get("tx_info")).toBe(s.txInfo);
    // the next build on the same key takes the next nonce
    const b2 = (await a.buildCancel({ marketId: "lighter-mainnet:-:ETH", venueOrderId: "281478187963734" }, buildCtx(LIGHTER_CONFIGS.mainnet, id))) as LighterBuild;
    expect(b2.payload.args.nonce).toBe(1);
    expect(lanes.filter((l) => l === "lighter-304").length).toBeGreaterThan(0);
    a.close();
  }, 30_000);
});
