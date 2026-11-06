// Draft builders, one per spec 11 action. Each fills every nullable field with null, checks the fields that action
// needs, and refuses fields that make no sense for it (a refusal never carries a venue order id or a tx hash).
// Order builds get no receipt of their own: their buildId and hashes sit in the submit, claim, cancel or refusal receipt.
import { type Hex, RECEIPT_ACTIONS, type ReceiptAction, type VenueId, VENUE_IDS } from "@capstan/schema";
import type { ReceiptDraft } from "./chain";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftError";
  }
}

export type DraftInput = Partial<Omit<ReceiptDraft, "action">> & { requestHash: Hex; eligibilityDecisionId: string };

const EMPTY: Omit<ReceiptDraft, "action" | "requestHash" | "eligibilityDecisionId"> = {
  owner: null,
  agentRef: null,
  venue: null,
  marketId: null,
  canonicalAsset: null,
  buildId: null,
  signedPayloadHash: null,
  builder: null,
  quoteSnapshotHash: null,
  policyId: null,
  venueResponseHash: null,
  venueOrderId: null,
  txHash: null,
};

type Field = keyof Omit<ReceiptDraft, "action">;
const NEEDS: Record<ReceiptAction, Field[]> = {
  "onboarding.complete": ["owner", "venue"],
  "order.submit": ["owner", "venue", "marketId", "buildId", "signedPayloadHash"],
  "order.claim": ["owner", "venue", "marketId", "buildId", "signedPayloadHash"],
  "order.cancel": ["owner", "venue", "marketId", "buildId"],
  "spread.leg": ["owner", "venue", "marketId", "buildId", "policyId"],
  "spread.plan": ["owner", "quoteSnapshotHash"],
  refusal: [],
  "agent.kill": ["owner", "agentRef"],
};
const FORBIDS: Partial<Record<ReceiptAction, Field[]>> = {
  refusal: ["venueOrderId", "txHash", "venueResponseHash"],
  "spread.plan": ["venueOrderId", "txHash"],
  "agent.kill": ["venueOrderId", "txHash", "builder"],
};

function check(action: ReceiptAction, d: ReceiptDraft): void {
  if (!HEX32.test(d.requestHash)) throw new DraftError(`${action}: requestHash must be a 32-byte hex`);
  if (typeof d.eligibilityDecisionId !== "string" || d.eligibilityDecisionId.length === 0) throw new DraftError(`${action}: eligibilityDecisionId is required`);
  if (d.owner !== null && !ADDR.test(d.owner)) throw new DraftError(`${action}: owner must be an address`);
  if (d.venue !== null && !(VENUE_IDS as readonly string[]).includes(d.venue)) throw new DraftError(`${action}: unknown venue ${d.venue}`);
  for (const f of ["signedPayloadHash", "quoteSnapshotHash", "venueResponseHash"] as const) {
    const v = d[f];
    if (v !== null && !HEX32.test(v)) throw new DraftError(`${action}: ${f} must be a 32-byte hex`);
  }
  if (d.builder !== null) {
    const b = d.builder;
    if (!ADDR.test(b.address) || !Number.isInteger(b.feeBps) || b.feeBps < 0 || typeof b.rawUnit !== "string") throw new DraftError(`${action}: builder must be { address, feeBps (integer >= 0), rawUnit }`);
  }
  for (const f of NEEDS[action]) if (d[f] === null || d[f] === undefined) throw new DraftError(`${action}: ${f} is required`);
  for (const f of FORBIDS[action] ?? []) if (d[f] !== null) throw new DraftError(`${action}: ${f} must be null`);
}

/** Build a checked draft for `action`. Unknown keys are refused, so nothing private (IP, country, API key) slips in. */
export function draft(action: ReceiptAction, input: DraftInput): ReceiptDraft {
  if (!(RECEIPT_ACTIONS as readonly string[]).includes(action)) throw new DraftError(`unknown action ${action}`);
  const known = new Set<string>([...Object.keys(EMPTY), "requestHash", "eligibilityDecisionId"]);
  for (const k of Object.keys(input)) if (!known.has(k)) throw new DraftError(`${action}: unknown field ${k}`);
  const d: ReceiptDraft = { ...EMPTY, ...input, action } as ReceiptDraft;
  for (const [k, v] of Object.entries(d)) if (v === undefined) (d as Record<string, unknown>)[k] = null;
  check(action, d);
  return d;
}

export const drafts = {
  onboardingComplete: (i: DraftInput & { owner: Hex; venue: VenueId }) => draft("onboarding.complete", i),
  orderSubmit: (i: DraftInput & { owner: Hex; venue: VenueId; marketId: string; buildId: string; signedPayloadHash: Hex }) => draft("order.submit", i),
  orderClaim: (i: DraftInput & { owner: Hex; venue: VenueId; marketId: string; buildId: string; signedPayloadHash: Hex }) => draft("order.claim", i),
  orderCancel: (i: DraftInput & { owner: Hex; venue: VenueId; marketId: string; buildId: string }) => draft("order.cancel", i),
  spreadLeg: (i: DraftInput & { owner: Hex; venue: VenueId; marketId: string; buildId: string; policyId: string }) => draft("spread.leg", i),
  spreadPlan: (i: DraftInput & { owner: Hex; quoteSnapshotHash: Hex }) => draft("spread.plan", i),
  refusal: (i: DraftInput) => draft("refusal", i),
  agentKill: (i: DraftInput & { owner: Hex; agentRef: string }) => draft("agent.kill", i),
};
