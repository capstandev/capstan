// todo 47 R7: a venue routes fees only when every builder row reads true.
import { describe, expect, test } from "bun:test";
import { asterRows, hlRows, venueReady } from "../builder-balances";

const B = "0x4444444444444444444444444444444444444444";
const fake = (cs: unknown, abs: unknown): typeof fetch =>
  (async (_u: unknown, init?: RequestInit) => {
    const t = JSON.parse(String(init?.body)).type;
    return new Response(JSON.stringify(t === "clearinghouseState" ? cs : abs), { status: 200 });
  }) as typeof fetch;

describe("builder balances", () => {
  test("hyperliquid needs 100 USDC and the default abstraction", async () => {
    expect(venueReady(await hlRows(B, fake({ marginSummary: { accountValue: "100.0" } }, "default")), "hyperliquid")).toBe(true);
    expect(venueReady(await hlRows(B, fake({ marginSummary: { accountValue: "99.99" } }, "default")), "hyperliquid")).toBe(false);
    expect(venueReady(await hlRows(B, fake({ marginSummary: { accountValue: "500" } }, "unifiedAccount")), "hyperliquid")).toBe(false);
    expect(venueReady(await hlRows(null), "hyperliquid")).toBe(false);
  });
  test("aster is never ready from this Mac (VPS signed read)", () => {
    expect(venueReady(asterRows(B, {}), "aster")).toBe(false);
    expect(asterRows(B, {}).every((r) => r.state === "not checked")).toBe(true);
  });
});
