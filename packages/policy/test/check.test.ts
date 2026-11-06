// R2, R3, R5: checkPolicy names the breached field for each limit, refuses direct mode under a policy, and compares
// decimals exactly.
import { describe, expect, test } from "bun:test";
import { checkPolicy, type PolicyCheckInput } from "../src";
import { basePolicy, NOW } from "./fixtures";

const OWNER = "0x00000000000000000000000000000000000000aa" as const;
function input(over: Partial<PolicyCheckInput> = {}, pol = {}): PolicyCheckInput {
  return {
    policy: basePolicy(OWNER, pol),
    agentRef: "agent-a",
    venue: "hyperliquid",
    marketId: "hyperliquid:-:ETH",
    side: "buy",
    notionalUsd: "500",
    leverage: 3,
    reduceOnly: false,
    grossNotionalUsd: "1000",
    ordersToday: 2,
    nowMs: NOW,
    mode: "relay",
    ...over,
  };
}
const field = (i: PolicyCheckInput) => {
  const r = checkPolicy(i);
  return r.ok ? null : r.field;
};

describe("checkPolicy", () => {
  test("each-field", () => {
    expect(checkPolicy(input())).toEqual({ ok: true });
    // per-order notional
    expect(field(input({ notionalUsd: "1000.000001" }))).toBe("maxNotionalPerOrderUsd");
    expect(field(input({ notionalUsd: "1000" }))).toBeNull();
    // gross notional: open gross + this order
    expect(field(input({ grossNotionalUsd: "4500.01" }))).toBe("maxGrossNotionalUsd");
    expect(field(input({ grossNotionalUsd: "4500" }))).toBeNull();
    // leverage
    expect(field(input({ leverage: 5.5 }))).toBe("maxLeverage");
    expect(field(input({ leverage: 5 }))).toBeNull();
    // market not allowed
    expect(field(input({ marketId: "hyperliquid:-:SOL" }))).toBe("allowedMarkets");
    expect(field(input({ marketId: "hyperliquid:-:SOL" }, { allowedMarkets: "*" }))).toBeNull();
    expect(field(input({ marketId: "hyperliquid:-:SOL" }, { allowedMarkets: ["*"] }))).toBeNull();
    // venue not allowed (the agent is listed on that venue, the venue is not allowed)
    expect(field(input({ venue: "aster", agentRef: "agent-b" }, { agents: [{ venue: "aster", agentRef: "agent-b" }] }))).toBe("allowedVenues");
    // orders per day
    expect(field(input({ ordersToday: 10 }))).toBe("maxOrdersPerDay");
    expect(field(input({ ordersToday: 9 }))).toBeNull();
    // opening after reduceOnlyAfter
    const roa = new Date(NOW - 1).toISOString();
    expect(field(input({}, { reduceOnlyAfter: roa }))).toBe("reduceOnlyAfter");
    expect(field(input({ reduceOnly: true }, { reduceOnlyAfter: roa }))).toBeNull();
    expect(field(input({}, { reduceOnlyAfter: new Date(NOW + 1).toISOString() }))).toBeNull();
    // expired
    expect(field(input({}, { expiresAt: new Date(NOW).toISOString() }))).toBe("expiresAt");
    expect(field(input({}, { expiresAt: new Date(NOW + 1).toISOString() }))).toBeNull();
    // an agent the policy does not name
    expect(field(input({ agentRef: "agent-z" }))).toBe("agents");
    // a reduce-only order is exempt from gross and leverage, not from the per-order cap or the daily count
    expect(field(input({ reduceOnly: true, grossNotionalUsd: "99999", leverage: 50 }))).toBeNull();
    expect(field(input({ reduceOnly: true, notionalUsd: "1001" }))).toBe("maxNotionalPerOrderUsd");
    // unreadable values fail closed on their own field
    expect(field(input({ notionalUsd: "1e3" }))).toBe("maxNotionalPerOrderUsd");
    expect(field(input({ notionalUsd: "-5" }))).toBe("maxNotionalPerOrderUsd");
    expect(field(input({ grossNotionalUsd: "abc" }))).toBe("maxGrossNotionalUsd");
    expect(field(input({ leverage: Number.NaN }))).toBe("maxLeverage");
    expect(field(input({ ordersToday: 1.5 }))).toBe("maxOrdersPerDay");
    expect(field(input({}, { expiresAt: "soon" }))).toBe("expiresAt");
  });

  test("direct-refused", () => {
    expect(checkPolicy(input({ mode: "direct" }))).toEqual({ ok: false, code: "POLICY_BREACH", field: "mode" });
    // mode is checked first: even an otherwise perfect order is refused in direct mode
    expect(field(input({ mode: "direct", notionalUsd: "1" }))).toBe("mode");
  });

  test("decimal-compare", () => {
    expect(field(input({ notionalUsd: "1000.00" }))).toBeNull(); // equals "1000"
    expect(field(input({ notionalUsd: "1000.0000000000000001" }))).toBe("maxNotionalPerOrderUsd");
    expect(field(input({ notionalUsd: "100.00" }, { maxNotionalPerOrderUsd: "100" }))).toBeNull();
    expect(field(input({ notionalUsd: "100" }, { maxNotionalPerOrderUsd: "100.00" }))).toBeNull();
    // 0.1 + 0.2 == 0.3 exactly (a float sum would be 0.30000000000000004 and breach)
    expect(field(input({ grossNotionalUsd: "0.1", notionalUsd: "0.2" }, { maxGrossNotionalUsd: "0.3" }))).toBeNull();
    // more than 18 decimals is unreadable, refused
    expect(field(input({ notionalUsd: "1.0000000000000000001" }))).toBe("maxNotionalPerOrderUsd");
  });
});
