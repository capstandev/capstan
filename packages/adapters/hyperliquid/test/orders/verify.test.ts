// R3 to R7: verifySigned compares every field, the signer, the expiry, the payload hash and the agent state.
import { describe, expect, test } from "bun:test";
import { buildOrder, payloadHash, verifySigned } from "../../src";
import { pick, prng, randInt } from "../../../../signers/hl/test/helpers";
import { AGENT_KEY, book, ctx, OTHER_KEY, setup, sign, T0 } from "./util";

const MUTATIONS: [string, (b: any) => void][] = [
  ["orders[0].market", (b) => (b.action.orders[0].a += 1)],
  ["orders[0].side", (b) => (b.action.orders[0].b = !b.action.orders[0].b)],
  ["orders[0].size", (b) => (b.action.orders[0].s = `${b.action.orders[0].s}1`)],
  ["orders[0].price", (b) => (b.action.orders[0].p = String(Number(b.action.orders[0].p) + 1))],
  ["orders[0].reduceOnly", (b) => (b.action.orders[0].r = !b.action.orders[0].r)],
  ["orders[0].tif", (b) => (b.action.orders[0].t = { limit: { tif: b.action.orders[0].t.limit.tif === "Gtc" ? "Alo" : "Gtc" } })],
  ["orders[0].cloid", (b) => (b.action.orders[0].c = "0x000000000000000000000000000000ff")],
  ["builder.address", (b) => (b.action.builder.b = "0x1111111111111111111111111111111111111111")],
  ["builder.f", (b) => (b.action.builder.f = b.action.builder.f === 20 ? 10 : 20)],
  ["nonce", (b) => (b.nonce += 1)],
  ["expiresAfter", (b) => (b.expiresAfter += 1)],
];

describe("verify", () => {
  test("any-field-mismatch", async () => {
    const { deps, cache } = setup();
    const r = prng(200);
    const markets = ["hyperliquid:-:BTC", "hyperliquid:-:ETH", "hyperliquid:-:SOL"];
    const mids = { "hyperliquid:-:BTC": 76000, "hyperliquid:-:ETH": 2800, "hyperliquid:-:SOL": 180 } as Record<string, number>;
    for (const m of markets) await cache.putBook(book(m, mids[m]!, T0, 20, 0.5, "50.0"));
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const m = pick(r, markets);
      const type = r() < 0.5 ? "market" : "limit";
      const it = { marketId: m, side: pick(r, ["buy", "sell"] as const), size: `${randInt(r, 1, 9)}.${randInt(r, 0, 9)}`, type, limitPx: type === "limit" ? String(mids[m]! + randInt(r, -20, 20)) : undefined, tif: pick(r, ["ioc", "gtc", "alo"] as const), reduceOnly: r() < 0.3, maxSlippageBps: randInt(r, 5, 100), ...(r() < 0.5 ? { clientOrderId: `0x${randInt(r, 1, 1e9).toString(16).padStart(32, "0")}` } : {}) } as const;
      const b = await buildOrder(it as never, ctx({ builderFee: { tenthsBp: r() < 0.5 ? 20 : 10 } }), deps);
      expect(verifySigned(sign(b), b, { nowMs: T0 })).toEqual({ ok: true });
      for (const [field, mut] of MUTATIONS) {
        const env = sign(b, AGENT_KEY, mut);
        const res = verifySigned(env, b, { nowMs: T0 });
        expect(res).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field });
        checked++;
      }
      // an extra key or a re-ordered object is caught at the byte level
      const extra = verifySigned(sign(b, AGENT_KEY, (x) => (x.action.orders[0] = { ...x.action.orders[0], z: 1 })), b, { nowMs: T0 });
      expect(extra.ok).toBe(false);
      const vault = verifySigned(sign(b, AGENT_KEY, (x) => (x.vaultAddress = "0x1111111111111111111111111111111111111111")), b, { nowMs: T0 });
      expect(vault).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "vaultAddress" });
    }
    expect(checked).toBe(200 * MUTATIONS.length);
  });

  test("wrong-signer", async () => {
    const { deps, cache } = setup();
    await cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
    const b = await buildOrder({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 }, ctx(), deps);
    expect(verifySigned(sign(b, OTHER_KEY), b, { nowMs: T0 })).toEqual({ ok: false, code: "BAD_SIGNATURE", field: "signer" });
    // envelope signature disagreeing with the body signature
    const env = sign(b);
    const other = sign(b, OTHER_KEY);
    expect(verifySigned({ ...env, signature: other.signature }, b, { nowMs: T0 })).toEqual({ ok: false, code: "BAD_SIGNATURE", field: "signature" });
    // no agent on the build
    expect(verifySigned(env, { ...b, meta: { ...b.meta, agentAddress: null } }, { nowMs: T0 }).ok).toBe(false);
  });

  test("expired", async () => {
    const { deps, cache } = setup();
    await cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
    const b = await buildOrder({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 }, ctx(), deps);
    expect(verifySigned(sign(b), b, { nowMs: T0 + 30_000 })).toEqual({ ok: true });
    expect(verifySigned(sign(b), b, { nowMs: T0 + 30_001 })).toEqual({ ok: false, code: "BUILD_EXPIRED" });
  });

  test("payload-hash-stable", async () => {
    const { deps, cache } = setup();
    await cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
    const b = await buildOrder({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 }, ctx(), deps);
    const e1 = sign(b);
    const e2 = sign(b);
    expect(e1.payloadHash).toBe(e2.payloadHash);
    // key order in the JSON object does not change the JCS hash
    const body = e1.signedBody as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    expect(payloadHash(reordered)).toBe(e1.payloadHash);
    expect(e1.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
    // a wrong payloadHash on the envelope is refused
    expect(verifySigned({ ...e1, payloadHash: `0x${"00".repeat(32)}` }, b, { nowMs: T0 })).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "payloadHash" });
  });

  test("retired-agent", async () => {
    const { deps, cache, adapter } = setup(undefined, { agentState: () => "killed" });
    await cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
    const it = { marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 } as const;
    const b = await buildOrder(it, ctx(), deps);
    expect(verifySigned(sign(b), b, { nowMs: T0, agentState: "retired" })).toEqual({ ok: false, code: "RETIRED_AGENT" });
    expect(verifySigned(sign(b), b, { nowMs: T0, agentState: "killed" })).toEqual({ ok: false, code: "AGENT_KILLED" });
    expect(adapter.verifySigned(sign(b), b)).toEqual({ ok: false, code: "AGENT_KILLED" } as never);
    // and the build itself refuses a retired or killed agent
    expect((await buildOrder(it, ctx({ agentState: "retired" }), deps).catch((e) => e)).code).toBe("RETIRED_AGENT");
    expect((await buildOrder(it, ctx({ agentState: "killed" }), deps).catch((e) => e)).code).toBe("AGENT_KILLED");
  });
});
