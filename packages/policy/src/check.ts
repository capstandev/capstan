// The agent-safe policy check (spec 7.6). Pure and synchronous: the relay calls it on every relay-mode submit and the
// SDK calls the same function before it signs. Amounts compare as exact decimals (Dec), never floats, so "100.00"
// equals "100". Anything it cannot read (a bad decimal, a bad time) is a breach of that field: it fails closed.
// Agent-safe mode forces relay mode: a direct-mode order under a policy is refused with field 'mode', because a
// modified client could skip a check that only runs on its own host.
import { Dec, type AgentPolicy, type VenueId } from "@capstan/schema";
import { policyTimeMs } from "./typed";

export type PolicyCheckInput = {
  policy: AgentPolicy;
  agentRef: string;
  venue: VenueId;
  marketId: string;
  side: "buy" | "sell";
  notionalUsd: string;
  leverage: number;
  reduceOnly: boolean;
  grossNotionalUsd: string; // the agent's open gross notional before this order
  ordersToday: number; // orders already sent today (UTC) by this agent under the policy
  nowMs: number;
  mode: "relay" | "direct";
};

export type PolicyField = keyof AgentPolicy | "mode";
export type PolicyCheckResult = { ok: true } | { ok: false; code: "POLICY_BREACH"; field: PolicyField };

const SCALE = 18;
const PLAIN = /^\d+(\.\d+)?$/;

/** A non-negative plain decimal with at most 18 decimals, or null. */
export function policyDec(x: unknown): Dec | null {
  if (typeof x !== "string" || !PLAIN.test(x)) return null;
  const frac = x.split(".")[1] ?? "";
  if (frac.replace(/0+$/, "").length > SCALE) return null;
  return Dec.parse(x, SCALE, "down");
}

function timeOrNull(x: string | undefined): number | null | "bad" {
  if (x === undefined || x === "") return null;
  try {
    return policyTimeMs(x);
  } catch {
    return "bad";
  }
}

const breach = (field: PolicyField): PolicyCheckResult => ({ ok: false, code: "POLICY_BREACH", field });

export function marketAllowed(allowed: AgentPolicy["allowedMarkets"], marketId: string): boolean {
  if (allowed === "*") return true;
  return Array.isArray(allowed) && (allowed.includes("*") || allowed.includes(marketId));
}

export function checkPolicy(i: PolicyCheckInput): PolicyCheckResult {
  const p = i.policy;
  if (i.mode !== "relay") return breach("mode");
  const exp = timeOrNull(p.expiresAt);
  if (exp === null || exp === "bad" || !Number.isFinite(i.nowMs) || i.nowMs >= exp) return breach("expiresAt");
  if (!p.agents.some((a) => a.agentRef === i.agentRef && a.venue === i.venue)) return breach("agents");
  if (!p.allowedVenues.includes(i.venue)) return breach("allowedVenues");
  if (!marketAllowed(p.allowedMarkets, i.marketId)) return breach("allowedMarkets");
  const roa = timeOrNull(p.reduceOnlyAfter);
  if (roa === "bad" || (roa !== null && i.nowMs >= roa && !i.reduceOnly)) return breach("reduceOnlyAfter");
  const notional = policyDec(i.notionalUsd);
  const maxOrder = policyDec(p.maxNotionalPerOrderUsd);
  if (!notional || !maxOrder || Dec.cmp(notional, maxOrder) > 0) return breach("maxNotionalPerOrderUsd");
  if (!i.reduceOnly) {
    // opening orders only: a reduce-only order cannot add exposure or leverage
    const gross = policyDec(i.grossNotionalUsd);
    const maxGross = policyDec(p.maxGrossNotionalUsd);
    if (!gross || !maxGross || Dec.cmp(Dec.add(gross, notional), maxGross) > 0) return breach("maxGrossNotionalUsd");
    if (!Number.isFinite(i.leverage) || i.leverage <= 0 || i.leverage > p.maxLeverage) return breach("maxLeverage");
  }
  if (!Number.isInteger(i.ordersToday) || i.ordersToday < 0 || i.ordersToday + 1 > p.maxOrdersPerDay) return breach("maxOrdersPerDay");
  return { ok: true };
}
