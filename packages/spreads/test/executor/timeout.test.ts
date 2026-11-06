// R6: leg A times out unfilled: B is never sent, the status is failed, no flatten is needed.
import { describe, expect, test } from "bun:test";
import { execute, ExecutorError } from "../../src/executor";
import { LOTS, planOf, sim } from "./sim";

describe("leg A timeout", () => {
  test("no-b-without-a", async () => {
    for (const policy of ["leave_open", "flatten_leg_a", "retry_then_flatten"] as const) {
      const p = planOf({ hedgeFailurePolicy: policy, legTimeoutMs: 3000 });
      // A's fill would only show after 10 s: the executor polls every 250 ms for 3 s, then gives up
      const v = sim((i) => (i.marketId === p.legA.marketId ? { latencyMs: 10_000 } : {}), LOTS(p));
      expect(await execute(p, v.ports)).toEqual({ status: "failed", residualDeltaBase: "0", legAFilled: "0", legBFilled: "0" });
      expect(v.subs.length).toBe(1);
      expect(v.events.map((e) => e.kind)).toEqual(["leg_a_sent", "failed"]);
      // a rejected A: same, B never sent
      const r = sim((i) => (i.marketId === p.legA.marketId ? { reject: true } : {}), LOTS(p));
      expect((await execute(p, r.ports)).status).toBe("failed");
      expect(r.subs.length).toBe(1);
    }
    // a draft plan is refused before any order
    const v = sim(() => ({}), LOTS(planOf()));
    await expect(execute(planOf({ status: "draft" }), v.ports)).rejects.toBeInstanceOf(ExecutorError);
    expect(v.subs.length).toBe(0);
    // a policy refusal of leg A: nothing sent, failed
    const pc = sim(() => ({}), LOTS(planOf()));
    expect((await execute(planOf(), { ...pc.ports, checkPolicy: () => ({ ok: false, field: "maxNotionalPerOrderUsd" }) })).status).toBe("failed");
    expect(pc.subs.length).toBe(0);
    expect(pc.events.at(-1)).toMatchObject({ kind: "failed", data: { reason: "policy refused (maxNotionalPerOrderUsd)" } });
  });
});
