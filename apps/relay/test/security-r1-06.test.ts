// Security review r1, review-r1:2 R1-06: maxGrossNotionalUsd bounds open exposure, not today's order sum. Filling the
// cap at 23:59 UTC and opening again after midnight must be refused. With a fresh positions read the cap follows the
// real open positions (a closed position frees room; an open one counts even with no order today).
import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, schema } from "@capstan/core";
import type { Hex, VenueId } from "@capstan/schema";
import { handleSubmit } from "../src/pipeline";
import { pgRelayStore, saveBuild } from "../src/stores";
import { codeOf, HL_REF, NOW, policyFor, relayStack } from "./helpers";

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));
const DAY = 86_400_000;
const MIDNIGHT = NOW - (NOW % DAY) + DAY;

function setup() {
  const s = relayStack();
  stacks.push(s);
  const ref = "hl:gross-agent";
  s.store.delegations.set(ref, { ...s.store.delegations.get(HL_REF)!, id: ref });
  s.policies.set(ref, { policyId: "pol-gross", policy: policyFor(ref, { maxGrossNotionalUsd: "1000", maxNotionalPerOrderUsd: "1000", expiresAt: new Date(NOW + 3 * DAY).toISOString() }) });
  let clock = MIDNIGHT - 60_000;
  s.deps.now = () => clock;
  let last = "";
  const submit = async (over: Partial<import("@capstan/schema").OrderIntent> = {}) => {
    const h = await s.hl({ size: "0.01", ...over }, { agentRef: ref, policyId: "pol-gross" }); // about 760 USD
    s.store.builds.get(h.b.buildId)!.expiresAt = clock + 30_000;
    last = h.b.buildId;
    return codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: "203.0.113.66" }, s.deps));
  };
  /** The order row of the last submit. */
  const lastOrder = () => [...s.store.orders.values()].find((o) => o.buildId === last)!;
  return { s, submit, lastOrder, at: (t: number) => void (clock = t) };
}

describe("security r1 R1-06", () => {
  test("gross-cap-does-not-reset-at-midnight", async () => {
    const { submit, at } = setup();
    expect((await submit()).code).toBeNull(); // 23:59 UTC: 760 of 1,000 USD open
    at(MIDNIGHT + 60_000);
    const r = await submit(); // 00:01 UTC: still open, so another 760 USD breaches the cap
    expect(r.code).toBe("POLICY_BREACH");
    expect(r.field).toBe("maxGrossNotionalUsd");
  });

  test("gross-cap-follows-fresh-positions", async () => {
    const { s, submit, at } = setup();
    const exposure = { gross: "0", asOf: 0 };
    (s.deps as { exposure?: unknown }).exposure = { openGrossUsd: async (_o: Hex, _v: VenueId) => ({ grossUsd: exposure.gross, asOfMs: exposure.asOf }) };
    expect((await submit()).code).toBeNull();
    // the position was closed: a positions read taken after it shows nothing open
    at(MIDNIGHT + 60_000);
    exposure.asOf = MIDNIGHT + 30_000;
    exposure.gross = "0";
    expect((await submit()).code).toBeNull();
    // an open position counts even with no order in the window
    at(MIDNIGHT + 10 * 60_000);
    exposure.asOf = MIDNIGHT + 9 * 60_000;
    exposure.gross = "900";
    expect((await submit()).code).toBe("POLICY_BREACH");
  });

  test("resting-order-before-the-read-still-counts", async () => {
    // the verifier's case: a cap-sized resting GTC order, then a positions read that still shows nothing open (the
    // order has not filled), then another cap-sized order. A positions read never shows a resting order.
    const { s, submit, lastOrder, at } = setup();
    const exposure = { gross: "0", asOf: 0 };
    (s.deps as { exposure?: unknown }).exposure = { openGrossUsd: async (_o: Hex, _v: VenueId) => ({ grossUsd: exposure.gross, asOfMs: exposure.asOf }) };
    const gtc = { type: "limit" as const, tif: "gtc" as const, limitPx: "76000" };
    expect((await submit(gtc)).code).toBeNull();
    const resting = lastOrder();
    expect(resting.status).toBe("accepted");
    at(MIDNIGHT + 6 * 60_000);
    exposure.asOf = MIDNIGHT + 5 * 60_000;
    exposure.gross = "0";
    const again = await submit(gtc);
    expect(again.code).toBe("POLICY_BREACH");
    expect(again.field).toBe("maxGrossNotionalUsd");
    // half of it filled before the read and that position was closed: the other half still rests (380 + 760 > 1,000)
    s.store.fills.push({ venue: "hyperliquid", venueOrderId: resting.venueOrderId!, sz: "0.005", ts: MIDNIGHT + 60_000 });
    expect((await submit()).code).toBe("POLICY_BREACH");
    // the rest filled before the read too: nothing rests, the read shows nothing open, so room is back
    s.store.fills.push({ venue: "hyperliquid", venueOrderId: resting.venueOrderId!, sz: "0.005", ts: MIDNIGHT + 2 * 60_000 });
    expect((await submit()).code).toBeNull();
  });

  test("ioc-orders-before-the-read-leave-the-gross", async () => {
    // an IOC order cannot rest: once a later read shows the position closed, it no longer counts
    const { s, submit, at } = setup();
    const exposure = { gross: "0", asOf: 0 };
    (s.deps as { exposure?: unknown }).exposure = { openGrossUsd: async (_o: Hex, _v: VenueId) => ({ grossUsd: exposure.gross, asOfMs: exposure.asOf }) };
    expect((await submit({ type: "limit", tif: "ioc", limitPx: "76000" })).code).toBeNull();
    at(MIDNIGHT + 6 * 60_000);
    exposure.asOf = MIDNIGHT + 5 * 60_000;
    expect((await submit()).code).toBeNull();
  });

  (process.env.DATABASE_URL ? test : test.skip)("pg-resting-orders-count-until-filled", async () => {
    const tmp = await createTempDatabase(process.env.DATABASE_URL!, { migrated: true, prefix: "capstan_sec_r106r" });
    const db = createDb(tmp.url, { max: 2 });
    try {
      const s = relayStack();
      stacks.push(s);
      const store = pgRelayStore(db);
      const ref = "hl:pg-resting-agent";
      let n = 0;
      const put = async (at: number, i: Partial<import("@capstan/schema").OrderIntent>) => {
        const h = await s.hl({ size: "0.01", ...i }, { agentRef: ref });
        const intent = { marketId: "hyperliquid:-:BTC", side: "buy", size: "0.01", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50, ...i } as import("@capstan/schema").OrderIntent;
        await saveBuild(db, { build: h.b, owner: h.s.owner, agentRef: ref, facts: { intent, kind: "order", mode: "relay", requestHash: h.s.requestHash, policyId: null, leverage: 1 } });
        const voId = String(9000 + ++n);
        await store.insertOrder({ id: h.b.buildId, buildId: h.b.buildId, venue: "hyperliquid", marketId: h.b.preview.marketId, owner: h.s.owner, signedPayloadHash: h.b.digest, mode: "relay", status: "accepted", builderFeeBps: 0, submittedAt: new Date(at) });
        await store.updateOrder(h.b.buildId, { status: "accepted", venueOrderId: voId });
        return { notional: Number(h.b.preview.notionalUsd), voId, id: h.b.buildId };
      };
      const gtc = await put(MIDNIGHT, { type: "limit", tif: "gtc", limitPx: "76000" });
      await put(MIDNIGHT + 1_000, { type: "limit", tif: "ioc", limitPx: "76000" }); // cannot rest
      const w = { sinceMs: MIDNIGHT + 5 * 60_000, restingSinceMs: MIDNIGHT - 60_000 };
      const u0 = await store.agentUsage(ref, MIDNIGHT + 6 * 60_000, w);
      expect(Number(u0.grossNotionalUsd)).toBeCloseTo(gtc.notional, 2);
      // a fill of half its size before the read: half still rests
      await db.insert(schema.fills).values({ id: "f1", orderId: null, venue: "hyperliquid", venueOrderId: gtc.voId, px: "76000", sz: "0.005", feeUsd: "0", builderFeeUsd: "0", ts: new Date(MIDNIGHT + 60_000) });
      const u1 = await store.agentUsage(ref, MIDNIGHT + 6 * 60_000, w);
      expect(Number(u1.grossNotionalUsd)).toBeCloseTo(gtc.notional / 2, 2);
      // a fill after the read does not free room (that part is not in the read)
      await db.insert(schema.fills).values({ id: "f2", orderId: gtc.id, venue: "hyperliquid", venueOrderId: gtc.voId, px: "76000", sz: "0.005", feeUsd: "0", builderFeeUsd: "0", ts: new Date(MIDNIGHT + 5 * 60_000 + 1) });
      expect(Number((await store.agentUsage(ref, MIDNIGHT + 6 * 60_000, w)).grossNotionalUsd)).toBeCloseTo(gtc.notional / 2, 2);
      // before the policy was issued: not counted
      expect(Number((await store.agentUsage(ref, MIDNIGHT + 6 * 60_000, { ...w, restingSinceMs: MIDNIGHT + 2_000 })).grossNotionalUsd)).toBe(0);
    } finally {
      await closeDb(db);
      await tmp.drop();
    }
  }, 60_000);

  (process.env.DATABASE_URL ? test : test.skip)("pg-usage-window", async () => {
    const tmp = await createTempDatabase(process.env.DATABASE_URL!, { migrated: true, prefix: "capstan_sec_r106" });
    const db = createDb(tmp.url, { max: 2 });
    try {
      const s = relayStack();
      stacks.push(s);
      const store = pgRelayStore(db);
      const ref = "hl:pg-gross-agent";
      const put = async (at: number, reduceOnly: boolean) => {
        const h = await s.hl({ size: "0.01", reduceOnly }, { agentRef: ref });
        await saveBuild(db, { build: h.b, owner: h.s.owner, agentRef: ref, facts: { intent: null, kind: "order", mode: "relay", requestHash: h.s.requestHash, policyId: null, leverage: 1 } });
        await store.insertOrder({ id: h.b.buildId, buildId: h.b.buildId, venue: "hyperliquid", marketId: h.b.preview.marketId, owner: h.s.owner, signedPayloadHash: h.b.digest, mode: "relay", status: "accepted", builderFeeBps: 0, submittedAt: new Date(at) });
        return Number(h.b.preview.notionalUsd);
      };
      const yesterday = await put(MIDNIGHT - 60_000, false);
      const today = await put(MIDNIGHT + 60_000, false);
      await put(MIDNIGHT + 61_000, true); // reduce-only: counted as an order, never as gross
      const all = await store.agentUsage(ref, MIDNIGHT + 120_000, { sinceMs: 0, restingSinceMs: 0 });
      expect(Number(all.grossNotionalUsd)).toBeCloseTo(yesterday + today, 2);
      expect(all.ordersToday).toBe(2);
      const recent = await store.agentUsage(ref, MIDNIGHT + 120_000, { sinceMs: MIDNIGHT, restingSinceMs: MIDNIGHT });
      expect(Number(recent.grossNotionalUsd)).toBeCloseTo(today, 2);
    } finally {
      await closeDb(db);
      await tmp.drop();
    }
  }, 60_000);
});
