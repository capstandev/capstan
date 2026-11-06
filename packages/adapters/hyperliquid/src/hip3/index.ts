// HIP-3 execution (spec 4.2; venue-hyperliquid.md sections 4 and 5): asset ids from the raw perpDexs order and raw
// universe index, the per-market fee formula (deployerFeeScale, growthMode), OI caps, the builder-fee gate per dex,
// isolated-only margin, and the own-account collateral step. Only xyz, io and para can ever execute; equity markets
// stay off unless EQ_EXECUTION_ALLOWED is set (DECISIONS #44).
import { CapstanError, Dec, type CanonicalAsset, type FundingSnapshot, type Hex, type Market, type OnboardingStep, type OrderBook, type OrderIntent, type VenueQuote } from "@capstan/schema";
import { l1Digest, type HlNetwork, type HlUpdateLeverageAction } from "@capstan/signer-hl";
import type { VenueHttp } from "@capstan/venue-client";
import { assetId, HIP3_WIRING } from "../meta";
import { mulStr, type HlMarket } from "../normalize";
import { BUILD_LIFE_MS, type HlBuildContext, type HlBuildDeps, type Hip3Hook } from "../orders";
import { fx, fxStr, HL_BASE_FEES, quote, type HlFeeTier, type HlQuoteInput } from "../quote";
import type { HlReader } from "../read";
import { collateralMoveStep } from "../templates";

export type Hip3WiredDex = (typeof HIP3_WIRING)[number];

export function hip3AssetId(dexIndex: number, indexInMeta: number): number {
  if (dexIndex < 1) throw new CapstanError("INVALID_INPUT", "HIP-3 dex indexes start at 1 (0 is the core dex)");
  return assetId(dexIndex, indexInMeta);
}

/**
 * Taker fee in bps for a HIP-3 market, from the venue's published formula (trading_fees.md, 2026-11-05):
 * base taker x scaleIfHip3 x growthModeScale x (1 - referral), with scaleIfHip3 = scale + 1 when scale < 1, else
 * scale x 2, and growthModeScale 0.1 in growth mode. Never the core schedule alone.
 */
export function hip3TakerRate(m: Market, baseTier: HlFeeTier, referralDiscount = "0"): string {
  if (m.venue !== "hyperliquid" || m.dex === null) throw new CapstanError("INVALID_INPUT", "hip3TakerRate is for HIP-3 markets only");
  const scale = m.deployerFeeScale ?? "1";
  const s = fx(scale);
  const one = fx("1");
  const scaleIfHip3 = s < one ? s + one : s * 2n;
  const growth = m.growthMode ? fx("0.1") : one;
  const ref = one - fx(referralDiscount);
  const rate = (((((fx(baseTier.takerRate) * scaleIfHip3) / one) * growth) / one) * ref) / one;
  return fxStr(rate, 12);
}

export function hip3TakerFeeBps(m: Market, baseTier: HlFeeTier, referralDiscount = "0"): number {
  return Number(Dec.toString(Dec.mul(Dec.parse(hip3TakerRate(m, baseTier, referralDiscount), 12), Dec.parse("10000", 0), 8)));
}

export function hip3FeeTier(m: Market, baseTier: HlFeeTier, referralDiscount = "0"): HlFeeTier {
  const scale = fx(m.deployerFeeScale ?? "1");
  const one = fx("1");
  const scaleIfHip3 = scale < one ? scale + one : scale * 2n;
  const growth = m.growthMode ? fx("0.1") : one;
  const ref = one - fx(referralDiscount);
  const maker = (((((fx(baseTier.makerRate) * scaleIfHip3) / one) * growth) / one) * ref) / one;
  return { takerRate: hip3TakerRate(m, baseTier, referralDiscount), makerRate: fxStr(maker, 12), source: baseTier.source };
}

/** OI cap: refuse a size that would push open interest past the per-coin cap. */
export function oiCheck(m: Market, notionalUsd: string, currentOiUsd: string): { ok: true } | { ok: false; code: "insufficient_depth" } {
  if (!m.oiCapUsd) return { ok: true };
  return fx(currentOiUsd) + fx(notionalUsd) > fx(m.oiCapUsd) ? { ok: false, code: "insufficient_depth" } : { ok: true };
}

export interface Hip3Gate {
  builderFeeSupported(dex: string): boolean;
  /** Apply testnet results: a false switches a dex off; a true never turns one back on. */
  apply(results: Record<string, boolean>): void;
  off(): string[];
}

export function createHip3Gate(env: Record<string, string | undefined> = process.env): Hip3Gate {
  const off = new Set(
    (env.HIP3_BUILDER_OFF ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return {
    // builder codes are confirmed on HIP-3 mainnet (xyz and io fills); para by protocol default
    builderFeeSupported: (dex) => !off.has(dex),
    apply(results) {
      for (const [dex, ok] of Object.entries(results)) if (ok === false) off.add(dex);
    },
    off: () => [...off].sort(),
  };
}

/** Equity check for the AE rule (todo 23): true for EQ, ETF and IX assets; an unmapped market on an equity dex is true. */
export function isEquityMarket(m: Pick<Market, "canonicalAsset" | "dex" | "assetClassHint">): boolean {
  const cls = (m.canonicalAsset as CanonicalAsset | null)?.split(":")[0] ?? m.assetClassHint ?? null;
  if (cls) return cls === "EQ" || cls === "ETF" || cls === "IX";
  return true; // unknown: fail closed
}

export interface TestnetSigner {
  readonly address: Hex;
  /** Signs an L1 digest with an agent key already approved for `address`'s account on testnet. */
  signL1(digest: Hex): { r: Hex; s: Hex; v: number };
  readonly owner: Hex;
}

/**
 * Testnet gate (BACKLOG A2): one tiny builder order per testnet dex, priced far from the book so it cannot fill.
 * A builder refusal records false; anything else records true. Results only ever switch a dex off (Hip3Gate.apply).
 */
export async function runHip3TestnetGate(r: HlReader, http: VenueHttp, signer: TestnetSigner, opts: { builder: Hex; dexes?: string[]; nowMs?: () => number } = { builder: "0x0000000000000000000000000000000000000000" }): Promise<Record<string, boolean>> {
  const now = opts.nowMs ?? Date.now;
  const out: Record<string, boolean> = {};
  const dexes = (await r.perpDexs()).filter((d) => d.name !== null && (!opts.dexes || opts.dexes.includes(d.name)));
  for (const d of dexes) {
    const [meta, ctxs] = await r.metaAndAssetCtxs(d.name);
    const i = meta.universe.findIndex((u) => !u.isDelisted);
    if (i < 0) continue;
    const mark = ctxs[i]?.markPx ?? "1";
    const px = fxStr(fx(mark) / 2n, 0) === "0" ? "1" : fxStr(fx(mark) / 2n, 0);
    const action = { type: "order" as const, orders: [{ a: hip3AssetId(d.index, i), b: true, p: px, s: "1", r: false, t: { limit: { tif: "Ioc" as const } } }], grouping: "na" as const, builder: { b: opts.builder.toLowerCase() as Hex, f: 1 } };
    const nonce = now();
    const expiresAfter = nonce + BUILD_LIFE_MS;
    const sig = signer.signL1(l1Digest(action, null, nonce, "Testnet", expiresAfter));
    const resp = await http.postJson<{ status: string; response: unknown }>("/exchange", { action, nonce, signature: sig, vaultAddress: null, expiresAfter });
    const text = JSON.stringify(resp);
    out[d.name!] = !/builder/i.test(text);
  }
  return out;
}

export interface Hip3Deps {
  reader: HlReader;
  gate: Hip3Gate;
  /** Catalog executability (todo 03). Required for any opening HIP-3 order. */
  isExecutable: (marketId: string) => boolean | Promise<boolean>;
  /** Catalog dex status: a dex gone from perpDexs is 'reduce_only'. */
  dexStatus?: (dex: string) => "active" | "reduce_only" | "unknown" | Promise<"active" | "reduce_only" | "unknown">;
  /** EQ_EXECUTION_ALLOWED (off until the lawyer item clears). */
  eqExecutionAllowed?: () => boolean;
  baseFees?: (owner: Hex) => Promise<{ tier: HlFeeTier; referralDiscount: string }>;
  /** For the collateral step the user signs: the network and the wallet's chain id (default Mainnet, 0xa4b1). */
  network?: HlNetwork;
  signatureChainId?: Hex;
}

/** Thrown with the onboarding step that moves the missing collateral from the core account to the market's dex. */
export class HlCollateralRequired extends CapstanError {
  readonly hint = "HL_COLLATERAL_REQUIRED" as const;
  readonly step: OnboardingStep;
  readonly shortfall: string;
  constructor(message: string, step: OnboardingStep, shortfall: string) {
    super("INVALID_INPUT", message);
    this.step = step;
    this.shortfall = shortfall;
  }
}

function roundUp2(x: string): string {
  return Dec.toString(Dec.parse(x, 2, "up"));
}

async function currentOiUsd(r: HlReader, m: HlMarket): Promise<{ oiUsd: string; mark: string }> {
  const [meta, ctxs] = await r.metaAndAssetCtxs(m.dex);
  const i = meta.universe.findIndex((u) => u.name === m.venueSymbol);
  const c = ctxs[i];
  if (!c) throw new CapstanError("VENUE_ERROR", `no asset context for ${m.venueSymbol}`);
  return { oiUsd: mulStr(c.openInterest, c.markPx), mark: c.markPx };
}

export function createHip3Hook(d: Hip3Deps): Hip3Hook & { quoteFees(marketId: string): Promise<{ builderOn: boolean; feeTier: HlFeeTier }> } {
  async function fees(owner: Hex | null): Promise<HlFeeTier & { referral: string }> {
    if (owner && d.baseFees) {
      const f = await d.baseFees(owner);
      return { ...f.tier, referral: f.referralDiscount };
    }
    if (owner) {
      try {
        const u = await d.reader.userFees(owner);
        return { takerRate: String(u.userCrossRate), makerRate: String(u.userAddRate), source: "user", referral: String((u as { activeReferralDiscount?: string }).activeReferralDiscount ?? "0") };
      } catch {
        /* base tier below */
      }
    }
    return { ...HL_BASE_FEES, referral: "0" };
  }
  return {
    async prepare(m, intent: OrderIntent, ctx: HlBuildContext) {
      const dex = m.dex!;
      const warnings: string[] = [];
      const status = d.dexStatus ? await d.dexStatus(dex) : "active";
      if (!intent.reduceOnly) {
        if (!(HIP3_WIRING as readonly string[]).includes(dex)) throw new CapstanError("MARKET_NOT_EXECUTABLE", `${dex} is not an executable HIP-3 dex`);
        if (status === "reduce_only") throw new CapstanError("MARKET_NOT_EXECUTABLE", `${dex} is reduce-only: only closing orders are accepted`);
        if (!(await d.isExecutable(m.id))) throw new CapstanError("MARKET_NOT_EXECUTABLE", `${m.id} is not executable`);
        if (isEquityMarket(m) && !(d.eqExecutionAllowed?.() ?? process.env.EQ_EXECUTION_ALLOWED === "1")) throw new CapstanError("MARKET_NOT_EXECUTABLE", `${m.id} is an equity market and equity execution is off`);
        // OI cap and collateral on this dex
        const { oiUsd, mark } = await currentOiUsd(d.reader, m);
        const notional = mulStr(intent.size, intent.type === "limit" && intent.limitPx ? intent.limitPx : mark);
        if (!oiCheck(m, notional, oiUsd).ok) throw new CapstanError("INVALID_INPUT", `insufficient_depth: ${m.id} is at its open-interest cap`);
        const lev = intent.leverage && intent.leverage > 0 ? intent.leverage : 1;
        const need = fxStr(fx(notional) / BigInt(Math.round(lev * 1000)) * 1000n, 8);
        const acct = await d.reader.dexAccount(ctx.owner, dex);
        if (fx(acct.withdrawable) < fx(need)) {
          const shortfall = roundUp2(fxStr(fx(need) - fx(acct.withdrawable), 8));
          const step = collateralMoveStep({ network: d.network ?? "Mainnet", signatureChainId: d.signatureChainId ?? "0xa4b1", nonce: ctx.nowMs, owner: ctx.owner, toDex: dex, token: m.collateralAsset, amount: shortfall });
          throw new HlCollateralRequired(`Move at least ${shortfall} ${m.collateralAsset} to your ${dex} account first.`, step, shortfall);
        }
      }
      if (m.marginModes.length === 1 && m.marginModes[0] === "isolated") warnings.push("isolated margin only");
      const builderOn = d.gate.builderFeeSupported(dex);
      if (!builderOn) warnings.push(`builder fee off on ${dex}`);
      const f = await fees(ctx.owner);
      return { builderOn, feeTier: hip3FeeTier(m, f, f.referral), warnings };
    },
    async quoteFees(marketId: string) {
      const m = await d.reader.instrument(marketId);
      return { builderOn: d.gate.builderFeeSupported(m.dex!), feeTier: hip3FeeTier(m, HL_BASE_FEES) };
    },
  };
}

/** Quote for a HIP-3 market: the book walk with the HIP-3 fee, the builder fee on top, and the OI cap. */
export async function hip3Quote(req: HlQuoteInput, m: HlMarket, book: OrderBook, d: { reader: HlReader; gate: Hip3Gate }, baseTier: HlFeeTier = HL_BASE_FEES, funding?: FundingSnapshot | null): Promise<VenueQuote> {
  const builderOn = d.gate.builderFeeSupported(m.dex!);
  const q = quote({ ...req, builderTenthsBp: builderOn ? (req.builderTenthsBp ?? 20) : 0, collateralAsset: m.collateralAsset, maxLeverage: m.maxLeverage }, book, hip3FeeTier(m, baseTier), funding);
  const { limitPx: _l, filledSize: _f, ...out } = q;
  if (out.status !== "ok") return out;
  const { oiUsd } = await currentOiUsd(d.reader, m);
  const notional = mulStr(q.filledSize, q.avgFillPx);
  return oiCheck(m, notional, oiUsd).ok ? out : { ...out, status: "insufficient_depth" };
}

/**
 * Leverage update (L1 action) for a market. Isolated-only markets refuse cross: enabling cross on a HIP-3 asset is
 * validator-gated and irreversible.
 */
export function buildLeverageUpdate(m: HlMarket, leverage: number, isCross: boolean, ctx: HlBuildContext, d: Pick<HlBuildDeps, "nonces" | "cfg">): { action: HlUpdateLeverageAction; nonce: number; expiresAfter: number; digest: Hex } {
  if (isCross && !m.marginModes.includes("cross")) throw new CapstanError("INVALID_INPUT", `${m.id} is isolated-only; cross margin cannot be set`);
  if (!Number.isInteger(leverage) || leverage < 1 || (m.maxLeverage !== null && leverage > m.maxLeverage)) throw new CapstanError("INVALID_INPUT", `leverage must be 1 to ${m.maxLeverage}`);
  const agent = ctx.identity?.agentAddress;
  if (!agent) throw new CapstanError("INVALID_INPUT", "the delegation's agent address is required");
  const action: HlUpdateLeverageAction = { type: "updateLeverage", asset: m.assetId, isCross, leverage };
  const nonce = d.nonces.next(agent, ctx.nowMs);
  const expiresAfter = ctx.nowMs + BUILD_LIFE_MS;
  return { action, nonce, expiresAfter, digest: l1Digest(action, null, nonce, d.cfg.network, expiresAfter) };
}

