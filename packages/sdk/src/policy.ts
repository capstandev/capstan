// Local copy of the agent-safe policy check (spec 7.6). Same input and answer shape as the policy package (todo 22):
// pure, decimal-exact, returns the first breached field. Under a policy the SDK forces relay mode, because policy
// enforcement binds relay traffic only and a modified client could skip this check.
import type { AgentPolicy, VenueId } from "@capstan/schema";
import { cmp, isDec } from "./dec";

export type PolicyCheckInput = {
  policy: AgentPolicy;
  agentRef: string;
  venue: VenueId;
  marketId: string;
  side: "buy" | "sell";
  notionalUsd: string;
  leverage: number;
  reduceOnly: boolean;
  grossNotionalUsd: string;
  ordersToday: number;
  nowMs: number;
  mode: "relay" | "direct";
};

export type PolicyCheckResult = { ok: true } | { ok: false; code: "POLICY_BREACH"; field: keyof AgentPolicy | "mode" };

/** Swappable so the integrator can wire the policy package's own function (one implementation, two callers). */
export type PolicyChecker = (i: PolicyCheckInput) => PolicyCheckResult;

const breach = (field: keyof AgentPolicy | "mode"): PolicyCheckResult => ({ ok: false, code: "POLICY_BREACH", field });

function timeOf(x: string | undefined): number | null {
  if (x === undefined || x === "") return null;
  const n = /^\d+$/.test(x) ? Number(x) * (x.length <= 10 ? 1000 : 1) : Date.parse(x);
  return Number.isFinite(n) ? n : NaN;
}

export function sumDec(a: string, b: string): string {
  const [ai = "0", af = ""] = a.split(".");
  const [bi = "0", bf = ""] = b.split(".");
  const s = Math.max(af.length, bf.length);
  const v = BigInt(ai + af.padEnd(s, "0")) + BigInt(bi + bf.padEnd(s, "0"));
  if (s === 0) return v.toString();
  const t = v.toString().padStart(s + 1, "0");
  return `${t.slice(0, -s)}.${t.slice(-s)}`;
}

export const checkPolicy: PolicyChecker = (i) => {
  const p = i.policy;
  if (i.mode !== "relay") return breach("mode");
  const exp = timeOf(p.expiresAt);
  if (exp === null || Number.isNaN(exp) || i.nowMs >= exp) return breach("expiresAt");
  if (!p.agents.some((a) => a.agentRef === i.agentRef && a.venue === i.venue)) return breach("agents");
  if (!p.allowedVenues.includes(i.venue)) return breach("allowedVenues");
  if (p.allowedMarkets !== "*" && !(Array.isArray(p.allowedMarkets) && (p.allowedMarkets.includes(i.marketId) || p.allowedMarkets.includes("*")))) return breach("allowedMarkets");
  const roa = timeOf(p.reduceOnlyAfter);
  if (roa !== null && (Number.isNaN(roa) || (i.nowMs >= roa && !i.reduceOnly))) return breach("reduceOnlyAfter");
  if (!isDec(i.notionalUsd) || !isDec(p.maxNotionalPerOrderUsd) || cmp(i.notionalUsd, p.maxNotionalPerOrderUsd) > 0) return breach("maxNotionalPerOrderUsd");
  if (!i.reduceOnly) {
    if (!isDec(i.grossNotionalUsd) || !isDec(p.maxGrossNotionalUsd) || cmp(sumDec(i.grossNotionalUsd, i.notionalUsd), p.maxGrossNotionalUsd) > 0) return breach("maxGrossNotionalUsd");
    if (!Number.isFinite(i.leverage) || i.leverage > p.maxLeverage) return breach("maxLeverage");
  }
  if (!Number.isInteger(i.ordersToday) || i.ordersToday + 1 > p.maxOrdersPerDay) return breach("maxOrdersPerDay");
  return { ok: true };
};
