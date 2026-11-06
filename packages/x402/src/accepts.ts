// Which payment options a priced route offers, in a fixed order: Base USDC, Solana USDC, RHC USDG permit2, then RHC
// USDG eip3009 (only when detection passed AND, on mainnet, the X402_USDG_EIP3009_MAINNET flag is set).
// Every amount is exact atomic units from the token's decimals read at boot; a rail without token facts is left out.
import type { Hex } from "@capstan/schema";
import type { PaymentRequirements } from "@x402/core/types";
import { RAIL_IDS, railDefs, type RailId, type X402Env } from "./networks";
import type { TokenInfo } from "./tokens";

export type PricedRoute = { usd: string; perRows?: 1000; description: string };

export interface X402State {
  usdgEip3009: Record<"4663" | "46630", boolean>;
  payTo: { evm: Hex; sol: string };
  /** Token facts per rail, read from chain at boot. Required for every EVM rail; Solana USDC defaults to 6 decimals. */
  tokens?: Partial<Record<RailId, TokenInfo>>;
  /** Rails dropped by the boot economics check (REL-3) or by ops. */
  droppedRails?: readonly RailId[];
  /**
   * Settle cost per rail in USD from the boot economics check (null: unknown). A rail is offered on a route only when
   * its cost is at most 50% of that route's price, so a rail too dear for a $0.01 call still serves a $0.02 one.
   */
  railCostsUsd?: Partial<Record<RailId, number | null>>;
  /** Mainnet USDG EIP-3009 switch (BACKLOG E7). Undefined = read X402_USDG_EIP3009_MAINNET from the environment. */
  eip3009MainnetEnabled?: boolean;
  /** Solana fee payer (the facilitator's sponsor address from /supported). */
  solFeePayer?: string;
  /** Facilitator hot key addresses: payTo may never be one of them. */
  hotKeys?: readonly string[];
}

export const MAX_TIMEOUT_SECONDS = 60;
const USD_RE = /^(0|[1-9]\d{0,8})(\.\d{1,18})?$/;

export class AcceptsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptsError";
  }
}

/** Exact conversion of a decimal USD string to atomic units of a 1-USD token. Refuses zero and lossy rounding (REL-1). */
export function usdToAtomic(usd: string, decimals: number): bigint {
  if (!USD_RE.test(usd)) throw new AcceptsError(`bad usd amount "${usd}"`);
  const [whole, frac = ""] = usd.split(".") as [string, string?];
  const f = frac.replace(/0+$/, "");
  if (f.length > decimals) throw new AcceptsError(`usd amount "${usd}" has more precision than ${decimals} decimals`);
  const v = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((f || "0").padEnd(decimals, "0") || "0");
  if (v <= 0n) throw new AcceptsError("a payment of amount 0 is refused");
  return v;
}

export function usdOfRoute(route: PricedRoute, rows?: number): string {
  if (!route.perRows) return route.usd;
  const units = Math.max(1, Math.ceil((rows ?? route.perRows) / route.perRows));
  // multiply as a decimal string with 18 places, then trim
  const atom = usdToAtomic(route.usd, 18) * BigInt(units);
  const s = atom.toString().padStart(19, "0");
  const out = `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, "");
  return out;
}

function eip3009Enabled(state: X402State, env: X402Env): boolean {
  const detected = env === "mainnet" ? state.usdgEip3009["4663"] : state.usdgEip3009["46630"];
  if (!detected) return false;
  if (env === "testnet") return true;
  const flag = state.eip3009MainnetEnabled ?? process.env.X402_USDG_EIP3009_MAINNET === "1";
  return flag === true;
}

export function acceptsFor(route: PricedRoute, state: X402State, env: X402Env, opts: { rows?: number } = {}): PaymentRequirements[] {
  const usd = usdOfRoute(route, opts.rows);
  const hot = new Set((state.hotKeys ?? []).map((a) => a.toLowerCase()));
  if (hot.has(state.payTo.evm.toLowerCase()) || hot.has(state.payTo.sol.toLowerCase())) throw new AcceptsError("payTo is the facilitator hot key");
  const defs = railDefs(env);
  const dropped = new Set(state.droppedRails ?? []);
  const out: PaymentRequirements[] = [];
  for (const id of RAIL_IDS) {
    if (dropped.has(id)) continue;
    // REL-3 per route: the settle must cost at most half of what this call earns
    const cost = state.railCostsUsd?.[id];
    if (cost !== undefined && (cost === null || cost > Number(usd) * 0.5)) continue;
    if (id === "rhc-usdg-eip3009" && !eip3009Enabled(state, env)) continue;
    const def = defs[id];
    const info = state.tokens?.[id];
    if (def.method === "spl") {
      if (!state.solFeePayer) continue; // the SVM scheme cannot be paid without a sponsor
      const decimals = info?.decimals ?? 6;
      out.push({
        scheme: "exact",
        network: def.network,
        asset: def.asset,
        amount: usdToAtomic(usd, decimals).toString(),
        payTo: state.payTo.sol,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: { feePayer: state.solFeePayer },
      });
      continue;
    }
    if (!info || info.asset.toLowerCase() !== def.asset.toLowerCase()) continue; // no token facts read: fail closed
    if (def.domain && (info.name !== def.domain.name || info.version !== def.domain.version)) continue;
    const extra: Record<string, unknown> = { name: info.name, version: info.version };
    if (def.method === "permit2") extra.assetTransferMethod = "permit2";
    out.push({
      scheme: "exact",
      network: def.network,
      asset: def.asset,
      amount: usdToAtomic(usd, info.decimals).toString(),
      payTo: state.payTo.evm,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra,
    });
  }
  return out;
}

/** Which rail a requirement belongs to (by network + transfer method). */
export function railOf(req: Pick<PaymentRequirements, "network" | "extra">, env: X402Env): RailId | null {
  const defs = railDefs(env);
  const method = req.extra?.assetTransferMethod === "permit2" ? "permit2" : undefined;
  for (const id of RAIL_IDS) {
    const d = defs[id];
    if (d.network !== req.network) continue;
    if (d.method === "spl") return id;
    if (d.method === "permit2" && method === "permit2") return id;
    if (d.method === "eip3009" && method === undefined) return id;
  }
  return null;
}

// ---- REL-3: rail economics -------------------------------------------------------------------------------------

/**
 * Settle gas ceilings, from fork measurements on 2026-11-06 (first payment to a fresh payTo, the most expensive case):
 * Base USDC eip3009 102,828; RHC USDG eip3009 102,495; RHC USDG permit2 proxy 118,951. Each ceiling adds about 12%;
 * test/fork/*.test.ts assert the live measurement stays at or below it.
 */
export const SETTLE_GAS: Record<Exclude<RailId, "solana-usdc">, bigint> = {
  "base-usdc": 115_000n,
  "rhc-usdg-permit2": 135_000n,
  "rhc-usdg-eip3009": 115_000n,
};
/**
 * Solana: the sponsor pays one signature (5,000 lamports) plus the client's priority fee. The x402 layout allows up to
 * 5 lamports per CU, which on a 20,000 CU limit costs more than a $0.01 call earns, so the facilitator also refuses a
 * compute price above SOLANA_MAX_CU_PRICE_MICROLAMPORTS (clients default to 1 microlamport).
 */
export const SOLANA_MAX_CU_PRICE_MICROLAMPORTS = 50_000n;
export const SOLANA_CU_LIMIT = 20_000n;
export const SOLANA_SETTLE_LAMPORTS = 5_000n + (SOLANA_MAX_CU_PRICE_MICROLAMPORTS * SOLANA_CU_LIMIT) / 1_000_000n;

export interface RailCostInput {
  /** Settle cost in USD, already computed; or the parts to compute it. */
  usd?: number;
  gasUnits?: bigint;
  gasPriceWei?: bigint;
  nativeUsd?: number;
}

export function settleCostUsd(c: RailCostInput): number | null {
  if (c.usd !== undefined) return Number.isFinite(c.usd) && c.usd >= 0 ? c.usd : null;
  if (c.gasUnits === undefined || c.gasPriceWei === undefined || c.nativeUsd === undefined || !Number.isFinite(c.nativeUsd) || c.nativeUsd <= 0) return null;
  return (Number(c.gasUnits * c.gasPriceWei) / 1e18) * c.nativeUsd;
}

export interface RailEconomics {
  minRouteUsd: number;
  /** 50% of the cheapest route: a rail at or under it is offered on every route. */
  limitUsd: number;
  /** 50% of the dearest route: a rail above it (or of unknown cost) serves no route and is dropped. */
  maxLimitUsd: number;
  costs: Partial<Record<RailId, number | null>>;
  dropped: RailId[];
  /** Rails offered only on routes priced at least twice their settle cost (acceptsFor checks per route). */
  limited: RailId[];
  alerts: { kind: "x402.rail_dropped" | "x402.rail_limited"; rail: RailId; costUsd: number | null; limitUsd: number }[];
}

/**
 * REL-3, every settle stays positive: a rail is offered on a route only when its settle cost is at most 50% of that
 * route's price (acceptsFor applies it per route from X402State.railCostsUsd). A rail whose cost is unknown (fail
 * closed) or above 50% of the dearest route is dropped everywhere; one above 50% of the cheapest route is limited to
 * the dearer routes. Found on the fork run (todo 40): at the live RHC gas price the USDG rails cost about $0.006 to
 * settle, over half of the $0.01 routes, and the old global rule dropped them from every route.
 */
export function railEconomics(routes: Record<string, PricedRoute>, costs: Partial<Record<RailId, RailCostInput>>): RailEconomics {
  const prices = Object.values(routes).map((r) => Number(r.usd));
  if (!prices.length) throw new AcceptsError("no priced routes");
  for (const p of prices) if (!(p > 0)) throw new AcceptsError("a payment of amount 0 is refused");
  const minRouteUsd = Math.min(...prices);
  const limitUsd = minRouteUsd * 0.5;
  const maxLimitUsd = Math.max(...prices) * 0.5;
  const out: RailEconomics = { minRouteUsd, limitUsd, maxLimitUsd, costs: {}, dropped: [], limited: [], alerts: [] };
  for (const id of RAIL_IDS) {
    const c = costs[id];
    const usd = c ? settleCostUsd(c) : null;
    out.costs[id] = usd;
    if (usd === null || usd > maxLimitUsd) {
      out.dropped.push(id);
      out.alerts.push({ kind: "x402.rail_dropped", rail: id, costUsd: usd, limitUsd: maxLimitUsd });
    } else if (usd > limitUsd) {
      out.limited.push(id);
      out.alerts.push({ kind: "x402.rail_limited", rail: id, costUsd: usd, limitUsd });
    }
  }
  return out;
}
