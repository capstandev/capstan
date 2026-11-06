// Plans and tiers. Core use is always free: locking CPST is never required. Locking gives higher limits and a lower
// integration fee only (Lock Holder >= 100,000 CPST locked: 2x limits, builder fee 1 bp; Lock Whale >= 1,000,000:
// 5x limits, 1 bp, plus a monthly premium-call allowance). Tiers read the locked amount only; any duration counts.
import { DEPLOYMENTS } from "@capstan/schema";

export type Tier = "free" | "payg" | "pro" | "lock_holder" | "lock_whale";
export const TIERS: readonly Tier[] = ["free", "payg", "pro", "lock_holder", "lock_whale"];

export interface Limits {
  readsPerMin: number;
  buildsPerMin: number;
  relayOrdersPerMinPerWallet: number;
  wsSubs: number;
  relayLane: "free" | "pro";
}

const FREE: Limits = { readsPerMin: 60, buildsPerMin: 20, relayOrdersPerMinPerWallet: 2, wsSubs: 50, relayLane: "free" };
const scale = (l: Limits, k: number): Limits => ({ ...l, readsPerMin: l.readsPerMin * k, buildsPerMin: l.buildsPerMin * k, relayOrdersPerMinPerWallet: l.relayOrdersPerMinPerWallet * k, wsSubs: l.wsSubs * k });

/** Per-tier limits; the gateway enforces them (free relay lane: 2 orders per minute per wallet, spec 14). */
export const LIMITS: Record<Tier, Limits> = {
  free: FREE,
  payg: FREE, // pay-as-you-go pays per premium call; free routes keep the free limits
  pro: { readsPerMin: 600, buildsPerMin: 120, relayOrdersPerMinPerWallet: 20, wsSubs: 500, relayLane: "pro" },
  lock_holder: scale(FREE, 2),
  lock_whale: scale(FREE, 5),
};

export const CPST_DECIMALS = 18;
export const LOCK_THRESHOLDS = { holder: 100_000n * 10n ** 18n, whale: 1_000_000n * 10n ** 18n } as const;

/** Lock Whale monthly premium allowance, credited as USD of premium calls (1,000 calls at $0.01). */
export const WHALE_MONTHLY_ALLOWANCE_USD = "10";

/** Boot check: every deployment file that lists CPST must say 18 decimals (the thresholds assume it). */
export function assertCpstDecimals(deployments: Record<number, { contracts: { CPST?: { decimals?: number } } }> = DEPLOYMENTS): void {
  for (const [chainId, d] of Object.entries(deployments)) {
    const dec = d.contracts.CPST?.decimals;
    if (dec !== undefined && dec !== CPST_DECIMALS) throw new Error(`CPST on chain ${chainId} has ${dec} decimals; tiers need ${CPST_DECIMALS}`);
  }
}

export function lockTierOf(locked: bigint): "lock_whale" | "lock_holder" | null {
  if (locked >= LOCK_THRESHOLDS.whale) return "lock_whale";
  if (locked >= LOCK_THRESHOLDS.holder) return "lock_holder";
  return null;
}

export type BuilderFee = { hlTenthsBp: 10 | 20; asterRate: "0.0001" | "0.0002" };
export const STANDARD_FEE: BuilderFee = { hlTenthsBp: 20, asterRate: "0.0002" };
export const LOCK_FEE: BuilderFee = { hlTenthsBp: 10, asterRate: "0.0001" };

export function multiplierOf(lock: "lock_whale" | "lock_holder" | null): 1 | 2 | 5 {
  return lock === "lock_whale" ? 5 : lock === "lock_holder" ? 2 : 1;
}

/**
 * The BuildContext.builderFee value for one venue (the only way the discount reaches an adapter).
 * Hyperliquid: tenths of a bp (20 or 10). Aster: decimal rate ("0.0002" or "0.0001"). Lighter: zero-fee
 * integrator attribution, no builder fee field (null).
 */
export function buildContextFee(fee: BuilderFee, venue: string): { tenthsBp?: number; decimalRate?: string } | null {
  if (venue === "hyperliquid") return { tenthsBp: fee.hlTenthsBp };
  if (venue === "aster") return { decimalRate: fee.asterRate };
  return null;
}

/** Sybil rule (spec 14): a wallet younger than 24 h with no venue activity gets half the free build and relay rate. */
export const NEW_WALLET_AGE_MS = 24 * 60 * 60 * 1000;

export function limitsFor(tier: Tier, opts: { newWallet?: boolean } = {}): Limits {
  const l = { ...LIMITS[tier] };
  if (opts.newWallet && (tier === "free" || tier === "payg")) {
    l.buildsPerMin = Math.max(1, Math.floor(l.buildsPerMin / 2));
    l.relayOrdersPerMinPerWallet = Math.max(1, Math.floor(l.relayOrdersPerMinPerWallet / 2));
  }
  return l;
}

/** Plain perk wording for API answers and copy: limits and the integration fee only, nothing else. */
export const PERK_COPY: Record<Tier, string> = {
  free: "Free plan: keyless reads and quotes, order build and relay, within the free limits.",
  payg: "Pay as you go: premium calls are paid per call with x402.",
  pro: "Pro: prepaid premium-call credits, websocket fan-out and the priority relay lane.",
  lock_holder: "Lock Holder: higher limits (2x) and a lower integration fee (1 bp).",
  lock_whale: "Lock Whale: higher limits (5x), a lower integration fee (1 bp) and a monthly premium-call allowance.",
};
