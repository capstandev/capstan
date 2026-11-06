// Found on the fork run (todo 40): leg orders carried clientOrderId `<planId>-a`, which Hyperliquid refuses (a cloid is
// 0x + 32 hex), so every Hyperliquid spread leg failed at build. Each leg now gets an id its venue accepts.
import { describe, expect, test } from "bun:test";
import { ulid } from "@capstan/core";
import { legClientOrderId } from "../../src/executor";
import { legIntent } from "../../src/plan";

const CLOID = /^0x[0-9a-fA-F]{32}$/; // packages/adapters/hyperliquid/src/orders.ts

describe("leg client order ids", () => {
  test("venue-valid-and-distinct", () => {
    const a = ulid();
    const b = ulid();
    const legs = ["a", "b", "b2", "a-flat"];
    const ids = legs.map((w) => legClientOrderId(a, w, "hyperliquid"));
    for (const id of ids) expect(id).toMatch(CLOID);
    expect(new Set(ids).size).toBe(4);
    // another plan never collides, and the same plan and leg always give the same id
    expect(legs.map((w) => legClientOrderId(b, w, "hyperliquid")).some((x) => ids.includes(x))).toBe(false);
    expect(legClientOrderId(a, "a", "hyperliquid")).toBe(ids[0]!);
    // Aster keeps the readable form (36 characters at most)
    expect(legClientOrderId(a, "a-flat", "aster")).toBe(`${a}-a-flat`);
    expect(legClientOrderId(a, "a-flat", "aster").length).toBeLessThanOrEqual(36);
    // the plan's leg template uses the same id
    expect(legIntent(a, { marketId: "hyperliquid:-:BTC", side: "buy", size: "0.01" }, "a", 50).clientOrderId).toBe(ids[0]!);
  });
});
