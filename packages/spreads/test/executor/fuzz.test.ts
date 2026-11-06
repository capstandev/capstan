// R7: 2,000 simulated runs with random fills, rejects, latencies, lots and policies. The executor never leaves an
// unreported residual, never sends B larger than A's fill, and never sends an opening order after a failure.
import { describe, expect, test } from "bun:test";
import { Dec } from "@capstan/schema";
import { execute } from "../../src/executor";
import { LOTS, planOf, sim, type Behaviour } from "./sim";

const d = (x: string) => Dec.parse(x, 18, "half_even");

describe("executor fuzz", () => {
  test("invariants", async () => {
    let seed = 20261106;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const p = planOf({ hedgeFailurePolicy: pick(["leave_open", "flatten_leg_a", "retry_then_flatten"] as const), lotA: pick(["0.001", "0.01", "0.1"]), lotB: pick(["0.001", "0.01", "0.05", "0.3"]), legTimeoutMs: pick([1000, 3000, 5000]), sizeBase: pick(["1", "0.5", "2.37"]) });
      const behave = (): Behaviour => ({ reject: r() < 0.15, fillFrac: r() < 0.2 ? 0 : r() < 0.5 ? 1 : r(), latencyMs: Math.floor(r() * 6000), noId: r() < 0.03, throwOnSubmit: r() < 0.02 });
      const v = sim(behave, LOTS(p));
      const res = await execute(p, v.ports);
      counts[res.status] = (counts[res.status] ?? 0) + 1;

      // true net exposure from what the simulated venues actually filled (a fill reads as 0 until its latency passed,
      // so use what the executor could see: the posted fills)
      const last = v.events.at(-1)!;
      expect(["complete", "unhedged", "flattened", "failed"]).toContain(last.kind);
      expect(last.kind).toBe(res.status as never);
      const sumFilled = (kind: "leg_a_filled" | "leg_b_filled") => v.events.filter((e) => e.kind === kind).reduce((t, e) => Dec.add(t, d((e.data as { filled: string }).filled)), d("0"));
      const aSeen = sumFilled("leg_a_filled");
      const bSeen = sumFilled("leg_b_filled");
      const flatSeen = last.kind === "flattened" ? d((last.data as { filled: string }).filled) : d("0");
      const expected = Dec.sub(Dec.sub(aSeen, bSeen), flatSeen);
      if (res.status !== "failed") expect(Dec.eq(d((last.data as { residualDeltaBase: string }).residualDeltaBase), expected), `run ${i}`).toBe(true);
      expect(Dec.eq(d(res.residualDeltaBase), res.status === "failed" ? d("0") : expected), `run ${i}`).toBe(true);
      expect(Dec.cmp(d(res.residualDeltaBase), d("0"))).toBeGreaterThanOrEqual(0);

      // when every order was confirmed finished, the reported residual is the venues' true final exposure
      const unknown = (last.data as { stateUnknown?: unknown }).stateUnknown !== undefined;
      const eventual = (pred: (x: (typeof v.subs)[number]) => boolean) => v.subs.filter(pred).reduce((t, x) => Dec.add(t, d(x.filled)), d("0"));
      const opening = v.subs.filter((x) => !x.intent.reduceOnly);
      if (!unknown && res.status !== "failed") {
        const trueExposure = Dec.sub(Dec.sub(eventual((x) => !x.intent.reduceOnly && x.venue === p.legA.venue), eventual((x) => !x.intent.reduceOnly && x.venue === p.legB.venue)), eventual((x) => x.intent.reduceOnly));
        expect(Dec.eq(trueExposure, d(res.residualDeltaBase)), `run ${i}`).toBe(true);
      }
      if (res.status === "failed" && !unknown) expect(Dec.isZero(eventual(() => true)), `run ${i}`).toBe(true);

      // B never larger than A's fill: each B order is at most A's fill minus what B already filled
      let bBefore = d("0");
      for (const x of opening.filter((y) => y.venue === p.legB.venue)) {
        expect(Dec.cmp(Dec.add(d(x.intent.size), bBefore), d(res.legAFilled)), `run ${i}`).toBeLessThanOrEqual(0);
        bBefore = Dec.add(bBefore, d(x.filled));
      }

      // never an opening order after a failure: A first, then at most one B (two with retry_then_flatten) only when
      // A filled; reduce-only orders are the flatten on A only
      expect(opening[0]?.venue ?? p.legA.venue).toBe(p.legA.venue);
      const bOrders = opening.slice(1);
      expect(bOrders.every((x) => x.venue === p.legB.venue)).toBe(true);
      expect(bOrders.length).toBeLessThanOrEqual(p.hedgeFailurePolicy === "retry_then_flatten" ? 2 : 1);
      if (Dec.isZero(d(res.legAFilled))) expect(bOrders.length).toBe(0);
      const flats = v.subs.filter((x) => x.intent.reduceOnly);
      expect(flats.length).toBeLessThanOrEqual(1);
      if (flats.length) {
        expect(flats[0]!.venue).toBe(p.legA.venue);
        expect(p.hedgeFailurePolicy).not.toBe("leave_open");
        expect(v.subs.indexOf(flats[0]!)).toBe(v.subs.length - 1); // the flatten is the last order sent
        expect(Dec.cmp(d(flats[0]!.intent.size), Dec.sub(d(res.legAFilled), d(res.legBFilled)))).toBeLessThanOrEqual(0);
      }
      if (res.status === "failed") expect(v.subs.length).toBeLessThanOrEqual(1);
    }
    // every outcome happened
    for (const s of ["complete", "unhedged", "flattened", "failed"]) expect(counts[s] ?? 0, s).toBeGreaterThan(20);
  }, 60_000);
});
