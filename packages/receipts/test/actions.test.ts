import { describe, expect, test } from "bun:test";
import { type Hex, RECEIPT_ACTIONS, type ReceiptAction } from "@capstan/schema";
import { draft, DraftError, drafts, issue, memoryLock, memoryStore, type ReceiptDraft, verifyReceiptSig } from "../src";
import { labelSigner } from "./helpers";

const H = (c: string) => `0x${c.repeat(64)}` as Hex;
const OWNER = "0x3333333333333333333333333333333333333333" as Hex;
const BUILDER = { address: "0x4444444444444444444444444444444444444444" as Hex, feeBps: 2, rawUnit: "20" };
const base = { requestHash: H("a"), eligibilityDecisionId: "el_1" };

describe("actions", () => {
  test("all-actions", async () => {
    const built: Record<ReceiptAction, ReceiptDraft> = {
      "onboarding.complete": drafts.onboardingComplete({ ...base, owner: OWNER, venue: "hyperliquid", builder: BUILDER }),
      "order.submit": drafts.orderSubmit({ ...base, owner: OWNER, venue: "hyperliquid", marketId: "hyperliquid:-:BTC", canonicalAsset: "BTC", buildId: "b1", signedPayloadHash: H("b"), builder: BUILDER, quoteSnapshotHash: H("c"), venueResponseHash: H("d"), venueOrderId: "123456789012345678" }),
      "order.claim": drafts.orderClaim({ ...base, owner: OWNER, venue: "lighter-mainnet", marketId: "lighter-mainnet:-:ETH", buildId: "b2", signedPayloadHash: H("b"), txHash: "abc" }),
      "order.cancel": drafts.orderCancel({ ...base, owner: OWNER, venue: "hyperliquid", marketId: "hyperliquid:-:BTC", buildId: "b3", venueOrderId: "1" }),
      "spread.leg": drafts.spreadLeg({ ...base, owner: OWNER, venue: "aster", marketId: "aster:-:BTCUSDT", buildId: "b4", policyId: "pol_1", agentRef: "agent-1" }),
      "spread.plan": drafts.spreadPlan({ ...base, owner: OWNER, quoteSnapshotHash: H("e") }),
      refusal: drafts.refusal({ ...base, eligibilityDecisionId: "el_refused_9", venue: "hyperliquid", marketId: "hyperliquid:-:BTC" }),
      "agent.kill": drafts.agentKill({ ...base, owner: OWNER, agentRef: "agent-1", policyId: "pol_1" }),
    };
    expect(Object.keys(built).sort()).toEqual([...RECEIPT_ACTIONS].sort());
    const deps = { store: memoryStore(), signer: labelSigner("actions"), now: () => new Date("2026-11-06T01:02:03.000Z"), id: (() => { let n = 0; return () => `r${n++}`; })(), lock: memoryLock() };
    for (const a of RECEIPT_ACTIONS) {
      const r = await issue(built[a], deps);
      expect(r.action).toBe(a);
      expect(verifyReceiptSig(r, [deps.signer.address])).toBe(true);
      // every spec 11 field is present (null, not missing)
      for (const k of ["owner", "agentRef", "venue", "marketId", "canonicalAsset", "buildId", "signedPayloadHash", "builder", "quoteSnapshotHash", "policyId", "venueResponseHash", "venueOrderId", "txHash", "prevReceiptHash"]) expect(k in r).toBe(true);
    }
    const refusal = await deps.store.get("r6");
    expect(refusal!.action).toBe("refusal");
    expect(refusal!.eligibilityDecisionId).toBe("el_refused_9");
    expect(refusal!.venueOrderId).toBeNull();
    expect(refusal!.owner).toBeNull();
  });

  test("draft-rules", () => {
    expect(() => drafts.refusal({ ...base, venueOrderId: "1" })).toThrow(/venueOrderId must be null/);
    expect(() => draft("order.submit", { ...base, owner: OWNER })).toThrow(/venue is required/);
    expect(() => draft("refusal", { ...base, eligibilityDecisionId: "" })).toThrow(DraftError);
    expect(() => draft("refusal", { ...base, requestHash: "0x12" as Hex })).toThrow(/requestHash/);
    expect(() => draft("refusal", { ...base, venue: "binance" as never })).toThrow(/unknown venue/);
    // nothing private slips into a receipt: unknown fields are refused
    expect(() => draft("refusal", { ...base, ip: "1.2.3.4" } as never)).toThrow(/unknown field ip/);
    expect(() => draft("refusal", { ...base, country: "CA" } as never)).toThrow(/unknown field country/);
    expect(() => draft("refusal", { ...base, apiKey: "k" } as never)).toThrow(/unknown field apiKey/);
    expect(() => draft("bogus" as ReceiptAction, base)).toThrow(/unknown action/);
  });
});
