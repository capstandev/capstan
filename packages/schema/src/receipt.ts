// Receipt shape (spec section 11). Types only: packages/receipts implements canonicalisation, signing and proofs.
import type { Hex, VenueId } from "./adapter";

export const RECEIPT_ACTIONS = [
  "onboarding.complete",
  "order.submit",
  "order.claim",
  "order.cancel",
  "spread.leg",
  "spread.plan",
  "refusal",
  "agent.kill",
] as const;
export type ReceiptAction = (typeof RECEIPT_ACTIONS)[number];

export interface Receipt {
  v: 1;
  receiptId: string;
  ts: string;
  brand: "capstan";
  action: ReceiptAction;
  owner: Hex | null;
  agentRef: string | null;
  venue: VenueId | null;
  marketId: string | null;
  canonicalAsset: string | null;
  requestHash: Hex; // sha256(JCS(request body))
  buildId: string | null;
  signedPayloadHash: Hex | null;
  builder: { address: Hex; feeBps: number; rawUnit: string } | null; // fee charged, published
  quoteSnapshotHash: Hex | null;
  eligibilityDecisionId: string;
  policyId: string | null;
  venueResponseHash: Hex | null;
  venueOrderId: string | null;
  txHash: string | null;
  prevReceiptHash: Hex | null; // per-owner hash chain
  sig: { alg: "secp256k1-eip191"; signer: Hex; value: Hex };
}

export type UnsignedReceipt = Omit<Receipt, "sig">;
