// A receipt draft for the Postgres and anchor tests.
import type { Hex } from "@capstan/schema";
import type { ReceiptDraft } from "../../src";

export function draft(owner: Hex | null, i: number, extra: Partial<ReceiptDraft> = {}): ReceiptDraft {
  const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex; // not-a-key
  return {
    action: "order.submit",
    owner,
    agentRef: null,
    venue: "hyperliquid",
    marketId: "hyperliquid:-:BTC",
    canonicalAsset: "BTC",
    requestHash: h(1_000_000 + i),
    buildId: `b_${i}`,
    signedPayloadHash: null,
    builder: null,
    quoteSnapshotHash: null,
    eligibilityDecisionId: `el_${i}`,
    policyId: null,
    venueResponseHash: null,
    venueOrderId: null,
    txHash: null,
    ...extra,
  };
}
