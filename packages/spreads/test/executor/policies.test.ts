// R5: each hedge-failure policy when leg B is rejected or fills partly.
import { describe, expect, test } from "bun:test";
import { legClientOrderId } from "../../src/executor";
import { execute } from "../../src/executor";
import { LOTS, planOf, sim } from "./sim";

describe("hedge failure policies", () => {
  test("each-policy", async () => {
    // leave_open: B rejected -> unhedged, residual = A's fill, no other order
    const p1 = planOf({ hedgeFailurePolicy: "leave_open" });
    const v1 = sim((i) => (i.marketId === p1.legB.marketId ? { reject: true } : {}), LOTS(p1));
    expect(await execute(p1, v1.ports)).toEqual({ status: "unhedged", residualDeltaBase: "1", legAFilled: "1", legBFilled: "0" });
    expect(v1.subs.length).toBe(2);
    expect(v1.events.at(-1)).toMatchObject({ kind: "unhedged", data: { residualDeltaBase: "1" } });

    // flatten_leg_a: B rejected -> one reduce-only IOC on A for the unhedged amount, opposite side, then flattened
    const p2 = planOf({ hedgeFailurePolicy: "flatten_leg_a" });
    const v2 = sim((i) => (i.marketId === p2.legB.marketId ? { reject: true } : {}), LOTS(p2));
    expect(await execute(p2, v2.ports)).toEqual({ status: "flattened", residualDeltaBase: "0", legAFilled: "1", legBFilled: "0" });
    const flat = v2.subs[2]!;
    expect([flat.venue, flat.intent.marketId, flat.intent.side, flat.intent.size, flat.intent.reduceOnly, flat.intent.tif]).toEqual(["lighter-mainnet", p2.legA.marketId, "buy", "1", true, "ioc"]);
    expect(v2.events.at(-1)).toMatchObject({ kind: "flattened", data: { residualDeltaBase: "0", filled: "1" } });

    // flatten_leg_a on a partial B: only the unhedged part is flattened
    const v2b = sim((i) => (i.marketId === p2.legB.marketId ? { fillFrac: 0.4 } : {}), LOTS(p2));
    expect(await execute(p2, v2b.ports)).toEqual({ status: "flattened", residualDeltaBase: "0", legAFilled: "1", legBFilled: "0.4" });
    expect(v2b.subs[2]!.intent).toMatchObject({ size: "0.6", reduceOnly: true });

    // retry_then_flatten: B rejected, retried once (rejected again), then flatten
    const p3 = planOf({ hedgeFailurePolicy: "retry_then_flatten" });
    const v3 = sim((i) => (i.marketId === p3.legB.marketId ? { reject: true } : {}), LOTS(p3));
    expect(await execute(p3, v3.ports)).toEqual({ status: "flattened", residualDeltaBase: "0", legAFilled: "1", legBFilled: "0" });
    expect(v3.subs.map((x) => [x.venue, x.intent.reduceOnly])).toEqual([["lighter-mainnet", false], ["hyperliquid", false], ["hyperliquid", false], ["lighter-mainnet", true]]);
    // leg B here is Hyperliquid: its retry carries the cloid form of PLAN0001 leg b2 (legClientOrderId)
    expect(v3.subs[2]!.intent.clientOrderId).toBe(legClientOrderId("PLAN0001", "b2", "hyperliquid"));

    // retry_then_flatten where the retry fills: complete, no flatten
    const v4 = sim((i, _v, nth) => (i.marketId === p3.legB.marketId && nth === 1 ? { fillFrac: 0.5 } : {}), LOTS(p3));
    expect(await execute(p3, v4.ports)).toEqual({ status: "complete", residualDeltaBase: "0", legAFilled: "1", legBFilled: "1" });
    expect(v4.subs.map((x) => x.intent.size)).toEqual(["1", "1", "0.5"]);

    // a flatten that does not fill ends unhedged with the residual reported, never silently
    const v5 = sim((i) => (i.marketId === p2.legB.marketId ? { reject: true } : i.reduceOnly ? { reject: true } : {}), LOTS(p2));
    expect(await execute(p2, v5.ports)).toEqual({ status: "unhedged", residualDeltaBase: "1", legAFilled: "1", legBFilled: "0" });
  });
});
