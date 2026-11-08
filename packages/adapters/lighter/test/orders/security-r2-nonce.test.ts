// Security review r2, D2-ADP-01 (review-r1:2 R1-01, review-r1:3 F4): a Lighter nonce was taken at build time and never
// given back or reconciled, so a policy-refused build (or one never signed) burned nonce n, and every later build on
// that key carried n+1 or more, which Lighter's strict previous + 1 rule rejects until the api restarts. Now a refused
// build gives its nonce back, and a gap or a reservation past its build life is closed from the venue's nextNonce.
import { afterAll, describe, expect, test } from "bun:test";
import { buildOrder, createLighterAdapter, NonceTracker, RESERVATION_TTL_MS } from "../../src";
import { buildCtx, closeWasm, identity, NOW, setup, STD_FEE, wasm } from "../build-helpers";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";

afterAll(() => closeWasm());

function venue(start: number) {
  const v = { next: start, reads: 0 };
  return { v, src: { nextNonce: async () => (v.reads++, v.next), tx: async () => ({ found: false, status: null }) } };
}

describe("security r2 D2-ADP-01", () => {
  test("a-refused-build-gives-its-nonce-to-the-next-build", async () => {
    const env = await setup("mainnet");
    try {
      const { hasher } = await wasm(304);
      const eth = await env.meta("ETH");
      const a = createLighterAdapter(env.cfg, { http: venueHttp(env.cfg.governorKey, env.srv.url, createMemoryGovernor("t"), { maxTries: 1 }), cache: null, execution: true, hasher, now: () => NOW });
      const id = identity(env.cfg);
      await a.nonces.seed(id.accountIndex!, id.apiKeyIndex!);
      const build = async () =>
        buildOrder({ marketId: eth.market.id, side: "buy", size: "0.5", type: "limit", limitPx: "2243.15", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 }, { ...buildCtx(env.cfg, id), cfg: env.cfg, market: eth, fee: STD_FEE, hasher, integratorAccountIndex: 0, nonce: a.nonces.next(id.accountIndex!, id.apiKeyIndex!), clientOrderIndex: a.nonces.nextClientOrderIndex(id.accountIndex!, id.apiKeyIndex!) });
      const refused = await build();
      a.releaseBuild(refused); // what the build route does on POLICY_BREACH, a failed quote check or a failed store
      const allowed = await build();
      expect(allowed.payload.txType === 14 && allowed.payload.args.nonce).toBe(refused.payload.txType === 14 ? refused.payload.args.nonce : -1);
    } finally {
      env.srv.stop();
    }
  });

  test("an-older-nonce-given-back-is-closed-from-the-venue", async () => {
    const { v, src } = venue(100);
    const t = new NonceTracker(src, () => NOW);
    await t.seed(1, 4);
    expect(t.next(1, 4)).toBe(100);
    expect(t.next(1, 4)).toBe(101);
    t.release(1, 4, 100); // 100 was refused; 101 can never land after it
    await t.refresh(1, 4);
    expect(t.next(1, 4)).toBe(100);
    expect(v.reads).toBe(2);
  });

  test("a-reservation-past-its-build-life-is-closed-from-the-venue", async () => {
    const { v, src } = venue(200);
    let clock = NOW;
    const t = new NonceTracker(src, () => clock);
    await t.seed(1, 4);
    expect(t.next(1, 4)).toBe(200); // built, never signed or sent
    clock += 5_000;
    await t.refresh(1, 4); // still inside its build life: no venue read
    expect(v.reads).toBe(1);
    expect(t.next(1, 4)).toBe(201);
    clock += RESERVATION_TTL_MS + 1;
    await t.refresh(1, 4); // the venue still waits for 200: start again from there
    expect(t.next(1, 4)).toBe(200);
    // 200 was sent and landed; a fresh 201 is in flight: nothing is reset, signing goes on after 201
    v.next = 201;
    clock += RESERVATION_TTL_MS + 1;
    expect(t.next(1, 4)).toBe(201);
    await t.refresh(1, 4);
    expect(t.next(1, 4)).toBe(202);
  });
});
