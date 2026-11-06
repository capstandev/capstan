// Simulated venues for the executor: each order gets a behaviour (reject, fill fraction, latency, no order id), the
// clock is virtual, and every submission and posted event is recorded so tests can check the invariants.
import { Dec, type OrderIntent, type SignedEnvelope, type SpreadPlan, type SubmitResult, type UnsignedVenuePayload, type VenueId } from "@capstan/schema";
import type { ExecutorEvent, ExecutorPorts } from "../../src/executor";

export interface Behaviour {
  reject?: boolean;
  fillFrac?: number; // of the order size, floored to the lot
  latencyMs?: number; // fill appears (and the order is done) this long after submit
  noId?: boolean;
  throwOnSubmit?: boolean;
}

export interface Submission {
  intent: OrderIntent;
  venue: VenueId;
  t: number;
  id: string | null;
  b: Behaviour;
  filled: string;
}

const S = 18;
const d = (x: string) => Dec.parse(x, S, "half_even");

export function sim(behave: (intent: OrderIntent, venue: VenueId, nth: number) => Behaviour, lots: Record<string, string>) {
  let clock = 1_793_000_000_000;
  let n = 0;
  const subs: Submission[] = [];
  const events: ExecutorEvent[] = [];
  const builds = new Map<string, { intent: OrderIntent; venue: VenueId }>();
  const orders = new Map<string, Submission>();
  const filledOf = (x: Submission): string => {
    if (x.b.reject) return "0";
    const frac = Math.max(0, Math.min(1, x.b.fillFrac ?? 1));
    const raw = Dec.mul(d(x.intent.size), Dec.parse(frac.toFixed(6), 6), S);
    const lot = lots[x.intent.marketId] ?? "0";
    return Dec.toString(Dec.cmp(d(lot), d("0")) > 0 ? Dec.roundToStep(raw, d(lot), "down") : raw);
  };
  const ports: ExecutorPorts = {
    async build(intent, venue) {
      const buildId = `b${String(++n).padStart(4, "0")}`;
      builds.set(buildId, { intent, venue });
      return { buildId, venue, signer: "delegated_key", encoding: "hl_l1_action", payload: { intent }, digest: "0x00", preview: { marketId: intent.marketId, side: intent.side, size: intent.size, px: null, notionalUsd: "0", venueFeeBps: 0, builderFeeBps: 0, builderFee: null, slippageBps: 0, estLiqPx: null, collateralAsset: "USDC", reduceOnly: intent.reduceOnly, warnings: [] }, expiresAt: clock + 30_000, eligibilityDecisionId: "e" } as UnsignedVenuePayload;
    },
    async sign(p) {
      return { buildId: p.buildId, venue: p.venue, encoding: p.encoding, signedBody: p.payload, signature: "0x00", signerRef: "agent", payloadHash: `0x${p.buildId.padEnd(64, "0").replace(/[^0-9a-f]/g, "0")}` } as SignedEnvelope;
    },
    async submit(env): Promise<SubmitResult> {
      const { intent, venue } = builds.get(env.buildId)!;
      const b = behave(intent, venue, subs.length);
      const id = b.noId || b.reject ? null : `v${subs.length}`;
      const x: Submission = { intent, venue, t: clock, id, b, filled: "0" };
      x.filled = filledOf(x);
      subs.push(x);
      if (id) orders.set(id, x);
      if (b.throwOnSubmit) throw new Error("socket hang up");
      if (b.reject) return { status: "rejected", venueOrderId: null, txHash: null, venueResponse: { error: "rejected" }, code: "REJECTED" };
      return { status: b.noId ? "unknown" : "accepted", venueOrderId: id, txHash: null, venueResponse: {} };
    },
    async fillOf(_venue, id) {
      const x = orders.get(id)!;
      const ready = clock >= x.t + (x.b.latencyMs ?? 0);
      return { filled: ready ? x.filled : "0", avgPx: ready ? "2000" : null, done: ready };
    },
    async post(ev) {
      events.push(structuredClone(ev));
    },
    now: () => clock,
    async sleep(ms) {
      clock += ms;
    },
  };
  return { ports, subs, events, advance: (ms: number) => (clock += ms) };
}

export function planOf(o: Partial<SpreadPlan> & { lotA?: string; lotB?: string } = {}): SpreadPlan {
  const leg = (marketId: string, venue: VenueId, side: "buy" | "sell", lot: string) => ({
    marketId,
    venue,
    side,
    size: o.sizeBase ?? "1",
    collateralAsset: "USDC",
    estLiqPx: null,
    payloadTemplate: { buildId: "t", venue, signer: "delegated_key" as const, encoding: "hl_l1_action" as const, payload: { template: true, lotSize: lot }, digest: "0x" as const, preview: {} as never, expiresAt: 0, eligibilityDecisionId: "template" },
  });
  return {
    planId: "PLAN0001",
    canonicalAsset: "CR:ETH",
    equivalenceId: "eq-eth",
    legA: leg("lighter-mainnet:-:ETH", "lighter-mainnet", "sell", o.lotA ?? "0.01"),
    legB: leg("hyperliquid:-:ETH", "hyperliquid", "buy", o.lotB ?? "0.01"),
    sizeBase: "1",
    residualDeltaBase: "0",
    fundingDiffPerHourBps: 0.8,
    roundTripCostBps: 13,
    breakevenHours: 16.25,
    nextSettlements: [],
    hedgeFailurePolicy: "flatten_leg_a",
    maxLegSlippageBps: 50,
    legTimeoutMs: 3000,
    riskLabel: "At-risk. Legging risk is yours.",
    ackRequired: true,
    status: "acked",
    ...o,
  };
}

export const LOTS = (p: SpreadPlan) => ({ [p.legA.marketId]: (p.legA.payloadTemplate.payload as { lotSize: string }).lotSize, [p.legB.marketId]: (p.legB.payloadTemplate.payload as { lotSize: string }).lotSize });
