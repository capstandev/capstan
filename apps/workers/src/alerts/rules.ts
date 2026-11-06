// Alert rules: which events become user alerts, with plain words that never suggest a trade.
//   liq_distance     a position within 10% or 5% of its own venue's liquidation price; one per level per position per
//                    30 minutes (the tightest level crossed is sent)
//   plan_unhedged    a spread plan that ended unhedged, with the residual; exactly once per plan
//   approval_expiry  an agent approval (HL valid_until, Aster expiry) 7 days and 1 day before it lapses; once per level
//   policy_breach    a relay POLICY_BREACH refusal, naming the field; one per agent per 10 minutes
import type { CapstanRiskView } from "@capstan/risk";
import type { schema } from "@capstan/core";
import type { Hex, VenueId } from "@capstan/schema";
import type { AlertEvent } from "./dispatch";

export type DelegationRow = typeof schema.delegations.$inferSelect;

export const LIQ_LEVELS_PCT = [10, 5] as const;
export const LIQ_WINDOW_MS = 30 * 60_000;
export const POLICY_BREACH_WINDOW_MS = 10 * 60_000;
export const EXPIRY_LEVELS = [
  { level: "7d", ms: 7 * 86_400_000 },
  { level: "1d", ms: 86_400_000 },
] as const;
const FOREVER_MS = 10 * 365 * 86_400_000;

export function liqDistanceRule(view: Pick<CapstanRiskView, "liquidationLadder">, thresholdPct: number): { marketId: string; venue: VenueId; distancePct: number }[] {
  return view.liquidationLadder.filter((r) => r.distancePct !== null && r.distancePct <= thresholdPct).map((r) => ({ marketId: r.marketId, venue: r.venue, distancePct: r.distancePct! }));
}

const pct = (x: number) => (Math.round(x * 10) / 10).toFixed(1);

export function liqAlerts(owner: Hex, view: Pick<CapstanRiskView, "liquidationLadder">, levels: readonly number[] = LIQ_LEVELS_PCT): AlertEvent[] {
  const sorted = [...levels].sort((a, b) => a - b);
  const out: AlertEvent[] = [];
  for (const r of view.liquidationLadder) {
    if (r.distancePct === null) continue;
    const level = sorted.find((l) => r.distancePct! <= l);
    if (level === undefined) continue;
    out.push({
      kind: "liq_distance",
      owner,
      data: { marketId: r.marketId, venue: r.venue, distancePct: r.distancePct, level, liqPx: r.liqPx, markPx: r.markPx, text: `Your ${r.marketId} position on ${r.venue} is ${pct(r.distancePct)}% from that venue's own liquidation price. Each venue liquidates independently.` },
      dedupeKey: `liq:${owner.toLowerCase()}:${r.venue}:${r.marketId}:${level}`,
      dedupeWindowMs: LIQ_WINDOW_MS,
    });
  }
  return out;
}

export function approvalExpiryRule(delegations: DelegationRow[], now: Date): DelegationRow[] {
  return delegations.filter((d) => d.state === "active" && d.expiresAt !== null && d.expiresAt.getTime() > now.getTime() && d.expiresAt.getTime() - now.getTime() <= EXPIRY_LEVELS[0].ms);
}

export function expiryAlerts(delegations: DelegationRow[], now: Date): AlertEvent[] {
  const out: AlertEvent[] = [];
  for (const d of approvalExpiryRule(delegations, now)) {
    const left = d.expiresAt!.getTime() - now.getTime();
    const lv = left <= EXPIRY_LEVELS[1].ms ? EXPIRY_LEVELS[1] : EXPIRY_LEVELS[0];
    out.push({
      kind: "approval_expiry",
      owner: d.owner as Hex,
      data: { agentRef: d.id, venue: d.venue, expiresAt: d.expiresAt!.toISOString(), level: lv.level, text: `Your ${d.venue} agent approval ends on ${d.expiresAt!.toISOString().slice(0, 10)} (${lv.level === "1d" ? "within a day" : "within 7 days"}). After that the relay cannot route for this agent until you onboard again.` },
      dedupeKey: `exp:${d.id}:${lv.level}`,
      dedupeWindowMs: FOREVER_MS,
    });
  }
  return out;
}

export function unhedgedAlert(ev: { planId: string; owner: Hex; kind: string; data: { residualDeltaBase?: string; reason?: string } }): AlertEvent | null {
  if (ev.kind !== "unhedged") return null;
  const residual = ev.data.residualDeltaBase ?? "unknown";
  return {
    kind: "plan_unhedged",
    owner: ev.owner,
    data: { planId: ev.planId, residualDeltaBase: residual, reason: ev.data.reason ?? null, text: `Spread plan ${ev.planId} ended unhedged: ${residual} base units of leg A have no matching leg B. Legging risk is yours.` },
    dedupeKey: `plan:${ev.planId}:unhedged`,
    dedupeWindowMs: FOREVER_MS,
  };
}

export function policyBreachAlert(ev: { owner: Hex; agentRef: string; field: string; venue?: VenueId }): AlertEvent {
  return {
    kind: "policy_breach",
    owner: ev.owner,
    data: { agentRef: ev.agentRef, field: ev.field, venue: ev.venue ?? null, text: `The relay refused an order from agent ${ev.agentRef}: it breaks your agent policy (${ev.field}). If you did not send it, stop the agent.` },
    dedupeKey: `pb:${ev.agentRef}`,
    dedupeWindowMs: POLICY_BREACH_WINDOW_MS,
  };
}
