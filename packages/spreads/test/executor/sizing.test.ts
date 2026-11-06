// R4: leg B is sized to leg A's ACTUAL fill (the simulated venue fills 0.7 of 1.0), rounded down to B's lot; the
// residual is reported exactly.
import { describe, expect, test } from "bun:test";
import { execute } from "../../src/executor";
import { LOTS, planOf, sim } from "./sim";

describe("executor sizing", () => {
  test("actual-fill", async () => {
    const p = planOf({ lotA: "0.1", lotB: "0.3" });
    const v = sim((intent) => (intent.marketId === p.legA.marketId ? { fillFrac: 0.7, latencyMs: 400 } : { fillFrac: 1, latencyMs: 100 }), LOTS(p));
    const r = await execute(p, v.ports);
    expect(v.subs.map((x) => [x.venue, x.intent.size, x.intent.reduceOnly])).toEqual([
      ["lighter-mainnet", "1", false],
      ["hyperliquid", "0.6", false], // floor(0.7 / 0.3) x 0.3
    ]);
    expect(r).toEqual({ status: "complete", residualDeltaBase: "0.1", legAFilled: "0.7", legBFilled: "0.6" });
    expect(v.events.map((e) => e.kind)).toEqual(["leg_a_sent", "leg_a_filled", "leg_b_sent", "leg_b_filled", "complete"]);
    expect(v.events.at(-1)!.data).toMatchObject({ residualDeltaBase: "0.1" });
    // the side of each leg is the plan's (A short here, B long), both IOC market orders
    expect(v.subs.map((x) => [x.intent.side, x.intent.tif, x.intent.type])).toEqual([["sell", "ioc", "market"], ["buy", "ioc", "market"]]);
    // a fill that is an exact multiple: no residual
    const v2 = sim((intent) => (intent.marketId === p.legA.marketId ? { fillFrac: 0.6 } : {}), LOTS(p));
    expect((await execute(p, v2.ports)).residualDeltaBase).toBe("0");
  });
});
