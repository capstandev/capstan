// R9: alert text uses plain words, passes the banned-word scan and never suggests a trade.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expiryAlerts, liqAlerts, policyBreachAlert, unhedgedAlert } from "../../src/alerts";
import { NOW, OWNER } from "./helpers";

const banned = readFileSync(join(import.meta.dir, "../../../../ops/ci/banned-words.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => new RegExp(l, "i"));
const TRADE_ADVICE = /\b(buy|sell|close (it|the|your)|open (a|an)|add (margin|collateral)|deposit|top up|increase|reduce your|hedge|rebalance|you should|we recommend|consider)\b/i;

describe("alert copy", () => {
  test("plain", () => {
    const texts = [
      ...liqAlerts(OWNER, { liquidationLadder: [{ marketId: "lighter-rh:-:HYPE", venue: "lighter-rh", liqPx: "201.1", distancePct: 3.14159, liqPxSource: "venue", markPx: "195", side: "short" }] }),
      ...expiryAlerts([{ id: "a1", venue: "aster", owner: OWNER, accountIndex: null, agentAddress: "0x0000000000000000000000000000000000000abc", apiKeyIndex: null, builderMaxBps: 2, expiresAt: new Date(NOW.getTime() + 3600_000), state: "active", createdAt: NOW }], NOW),
      unhedgedAlert({ planId: "P1", owner: OWNER, kind: "unhedged", data: { residualDeltaBase: "0.5" } })!,
      policyBreachAlert({ owner: OWNER, agentRef: "hl:0xabc", field: "allowedMarkets" }),
    ].map((a) => (a.data as { text: string }).text);
    expect(texts.length).toBe(4);
    for (const t of texts) {
      for (const re of banned) expect(t).not.toMatch(re);
      expect(t).not.toMatch(TRADE_ADVICE);
      expect(t).not.toMatch(/[–—]/); // no long dashes
      expect(t.length).toBeLessThan(220);
    }
    expect(texts[0]).toBe("Your lighter-rh:-:HYPE position on lighter-rh is 3.1% from that venue's own liquidation price. Each venue liquidates independently.");
  });
});
