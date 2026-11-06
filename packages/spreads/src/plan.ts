// Spread planner (spec 7.5 steps 2 to 4): a draft plan for a funding-rate spread trade (at-risk) on one approved
// equivalence. Legging risk is yours: the plan must be acknowledged with a signature before anything runs, and the
// executor runs only where the keys are (SDK or MCP host), never on the server. Each leg keeps its own venue, its own
// collateral and its own estimated liquidation price; the planner never nets margin, never moves collateral between
// venues and never rebalances anything server-side.
import { bodyHash, ulid, verifyCapstanMessage, type NonceStore } from "@capstan/core";
import { quoteHash, type QuoteMarket } from "@capstan/quote";
import { Dec, SPREAD_RISK_LABEL, type Hex, type OrderIntent, type SpreadLeg, type SpreadPlan, type UnsignedVenuePayload, type VenueId } from "@capstan/schema";
import { DATA_ONLY, scan, type ScanDeps, type ScanLeg, type ScanRow } from "./scan";

export const DEFAULT_LEG_TIMEOUT_MS = 3000;
export const DEFAULT_LEG_SLIPPAGE_BPS = 50;
export const ACK_TEXT = (planId: string) => `I acknowledge spread plan ${planId}. At-risk. Legging risk is yours.`;

export type PlanErrorCode = "NOT_APPROVED" | "VENUE_DATA_ONLY" | "NO_PAIR" | "INVALID_INPUT" | "NOT_FOUND" | "BAD_ACK" | "BAD_STATE";

export class PlanError extends Error {
  readonly code: PlanErrorCode;
  constructor(code: PlanErrorCode, message: string) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

export interface StoredPlan {
  plan: SpreadPlan;
  owner: Hex;
  ackSig: string | null;
  quoteSnapshotHash: Hex;
}

/** Plan persistence (spread_plans, spread_events, quote_snapshots); dbPlanStore in events.ts. */
export interface PlanStore {
  insert(p: StoredPlan, quoteBody: unknown): Promise<void>;
  get(planId: string): Promise<StoredPlan | null>;
  setStatus(planId: string, status: SpreadPlan["status"], ackSig?: string): Promise<void>;
}

export interface PlanRequest {
  owner: Hex;
  equivalenceId: string;
  sizeBase: string;
  leverage: number;
  hedgeFailurePolicy: SpreadPlan["hedgeFailurePolicy"];
  maxLegSlippageBps?: number;
  legTimeoutMs?: number;
  /** The two markets to pair; default: the best-ranked pair of the equivalence. */
  marketIds?: [string, string];
}

export interface PlanDeps extends ScanDeps {
  store?: PlanStore;
  id?: () => string;
}

const S = 18;
const d = (x: string) => Dec.parse(x, S, "half_even");
const str = (x: Dec) => Dec.toString(x);

/** Largest size <= x that is a multiple of every lot (steps that nest, as venue lots do). */
export function commonFloor(x: string, lots: string[]): string {
  let v = d(x);
  for (let i = 0; i < 8; i++) {
    let next = v;
    for (const l of lots) if (Dec.cmp(d(l), Dec.parse("0", 0)) > 0) next = Dec.roundToStep(next, d(l), "down");
    if (Dec.eq(next, v)) break;
    v = next;
  }
  return str(v);
}

/** The intent template each leg carries: an IOC market order of the leg's size (A first, then B sized to A's fill). */
export function legIntent(planId: string, leg: Pick<SpreadLeg, "marketId" | "side" | "size">, which: "a" | "b", maxSlippageBps: number): OrderIntent {
  return { marketId: leg.marketId, side: leg.side, size: leg.size, type: "market", tif: "ioc", reduceOnly: false, clientOrderId: `${planId}-${which}`, maxSlippageBps };
}

function encodingOf(v: VenueId): UnsignedVenuePayload["encoding"] {
  return v === "hyperliquid" ? "hl_l1_action" : v === "aster" ? "aster_v3_params" : "lighter_tx";
}

function template(planId: string, s: ScanLeg, m: QuoteMarket, size: string, which: "a" | "b", slip: number): SpreadLeg {
  const intent = legIntent(planId, { marketId: s.marketId, side: s.side, size }, which, slip);
  const payloadTemplate: UnsignedVenuePayload = {
    buildId: `template-${planId}-${which}`,
    venue: s.venue,
    signer: "delegated_key",
    encoding: encodingOf(s.venue),
    payload: { template: true, intent, lotSize: m.lotSize, tickSize: m.tickSize },
    digest: "0x",
    preview: { marketId: s.marketId, side: s.side, size, px: null, notionalUsd: "0", venueFeeBps: 0, builderFeeBps: 0, builderFee: null, slippageBps: 0, estLiqPx: s.estLiqPx, collateralAsset: s.collateralAsset, reduceOnly: false, warnings: ["Template only: the executor builds and signs the real order on the client."] },
    expiresAt: 0,
    eligibilityDecisionId: "template",
  };
  return { marketId: s.marketId, venue: s.venue, side: s.side, size, collateralAsset: s.collateralAsset, estLiqPx: s.estLiqPx, payloadTemplate };
}

export async function plan(req: PlanRequest, deps: PlanDeps): Promise<SpreadPlan> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.owner)) throw new PlanError("INVALID_INPUT", "owner must be an address");
  if (!/^\d+(\.\d+)?$/.test(req.sizeBase) || Dec.isZero(d(req.sizeBase))) throw new PlanError("INVALID_INPUT", "sizeBase must be a positive decimal");
  const all = await deps.catalog.equivalences();
  const eq = all.find((e) => e.id === req.equivalenceId);
  if (!eq || eq.status !== "approved") throw new PlanError("NOT_APPROVED", "only approved equivalences can be planned");
  const markets = await deps.catalog.marketsByIds(eq.marketIds);
  if (req.marketIds) {
    if (req.marketIds[0] === req.marketIds[1] || !req.marketIds.every((id) => eq.marketIds.includes(id))) throw new PlanError("INVALID_INPUT", "both markets must belong to the equivalence");
    const dataOnly = markets.find((m) => req.marketIds!.includes(m.id) && DATA_ONLY.includes(m.venue));
    if (dataOnly) throw new PlanError("VENUE_DATA_ONLY", `${dataOnly.venue} is data only and cannot be a leg`);
  }
  const rows: ScanRow[] = await scan({ asset: eq.canonicalAsset as ScanRow["canonicalAsset"], equivalenceId: eq.id, sizeBase: req.sizeBase, leverage: req.leverage, ...(req.marketIds ? { marketIds: req.marketIds } : {}) }, deps);
  const row = rows[0];
  if (!row) throw new PlanError("NO_PAIR", "no executable pair with fresh quotes and funding for this equivalence");
  for (const l of [row.legA, row.legB]) if (DATA_ONLY.includes(l.venue)) throw new PlanError("VENUE_DATA_ONLY", "a data-only venue cannot be a leg"); // defence in depth
  const mA = markets.find((m) => m.id === row.legA.marketId)!;
  const mB = markets.find((m) => m.id === row.legB.marketId)!;
  const size = commonFloor(req.sizeBase, [mA.lotSize, mB.lotSize]);
  if (Dec.isZero(d(size))) throw new PlanError("INVALID_INPUT", "sizeBase rounds to zero on the legs' lot sizes");
  const planId = (deps.id ?? (() => ulid(deps.now().getTime())))();
  const slip = req.maxLegSlippageBps ?? DEFAULT_LEG_SLIPPAGE_BPS;
  const legA = template(planId, row.legA, mA, size, "a", slip);
  const legB = template(planId, row.legB, mB, size, "b", slip);
  const p: SpreadPlan = {
    planId,
    canonicalAsset: row.canonicalAsset,
    equivalenceId: eq.id,
    legA,
    legB,
    sizeBase: size,
    residualDeltaBase: str(Dec.abs(Dec.sub(d(legA.size), d(legB.size)))),
    fundingDiffPerHourBps: row.fundingDiffPerHourBps,
    roundTripCostBps: row.roundTripCostBps,
    breakevenHours: row.breakevenHours,
    nextSettlements: row.nextSettlements,
    hedgeFailurePolicy: req.hedgeFailurePolicy,
    maxLegSlippageBps: slip,
    legTimeoutMs: req.legTimeoutMs ?? DEFAULT_LEG_TIMEOUT_MS,
    riskLabel: SPREAD_RISK_LABEL,
    ackRequired: true,
    status: "draft",
  };
  const quoteBody = { planId, row, sizeBase: size, leverage: req.leverage, asOf: deps.now().toISOString() };
  await deps.store?.insert({ plan: p, owner: req.owner.toLowerCase() as Hex, ackSig: null, quoteSnapshotHash: quoteHash(quoteBody) }, quoteBody);
  return p;
}

export interface AckDeps {
  store: PlanStore;
  nonces: NonceStore;
  host: string;
  nowMs: number;
  /** Active agent addresses (secp keys) bound to the owner; an agent of the owner may ack. */
  agentsOf(owner: Hex): Promise<Hex[]>;
}

/**
 * Acknowledge a draft plan. The signature must be the 01 capstanMessage with purpose spread_ack and body
 * ACK_TEXT(planId) (SIG-1: it works for nothing else), signed by the owner or an active agent of the owner.
 */
export async function ack(planId: string, sig: Hex, by: Hex | null, deps: AckDeps & { message: string }): Promise<{ status: "acked" }> {
  const sp = await deps.store.get(planId);
  if (!sp) throw new PlanError("NOT_FOUND", "unknown plan");
  if (sp.plan.status !== "draft") {
    if (sp.plan.status === "acked" && sp.ackSig === sig) return { status: "acked" }; // the same ack again
    throw new PlanError("BAD_STATE", `the plan is ${sp.plan.status}`);
  }
  const signers = [sp.owner, ...(await deps.agentsOf(sp.owner))];
  if (by && !signers.some((s) => s.toLowerCase() === by.toLowerCase())) throw new PlanError("BAD_ACK", "the signer is neither the owner nor an active agent of the owner");
  const r = await verifyCapstanMessage(deps.message, sig, { purpose: "spread_ack", signers, host: deps.host, nowMs: deps.nowMs, body: ACK_TEXT(planId) }, deps.nonces);
  if (!r.ok) throw new PlanError("BAD_ACK", `the acknowledgement is not valid (${r.reason})`);
  if (r.message.owner.toLowerCase() !== sp.owner.toLowerCase()) throw new PlanError("BAD_ACK", "the acknowledgement names another owner");
  if (by && r.signer.toLowerCase() !== by.toLowerCase()) throw new PlanError("BAD_ACK", "the signature is not by the named signer");
  await deps.store.setStatus(planId, "acked", sig);
  return { status: "acked" };
}

/** The body hash an ack message must carry (for clients that build the message themselves). */
export const ackBodyHash = (planId: string) => bodyHash(ACK_TEXT(planId));
