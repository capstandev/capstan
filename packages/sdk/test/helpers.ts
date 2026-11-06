// Test helpers: seed-derived test keys (public labels, never real), server-shaped builds for each encoding, and a
// seeded PRNG. Builds here follow the adapters' encodings exactly (the e2e test also runs the real HL adapter).
import type { Hex, OrderIntent, UnsignedVenuePayload } from "@capstan/schema";
import { digestTrade, queryString, type Param } from "@capstan/signer-aster";
import { formatPrice, formatSize, l1Digest, type HlOrderAction } from "@capstan/signer-hl";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { bound, fromUnits, toUnits } from "../src/dec";
import { addressOfSecret } from "../src/keys/secp";
import { mergePins, PINS, type Pins } from "../src/pins";

export const testKey = (label: string): Uint8Array => keccak_256(utf8ToBytes(`capstan-sdk-test:${label}`)); // test-key
export const labelAddr = (label: string): Hex => `0x${Buffer.from(keccak_256(utf8ToBytes(`capstan-sdk-addr:${label}`))).toString("hex").slice(24)}` as Hex;

export const BUILDER_HL = labelAddr("builder-hl");
export const BUILDER_ASTER = labelAddr("builder-aster");
export const OWNER = addressOfSecret(testKey("owner"));
export const AGENT = addressOfSecret(testKey("agent"));
export const T0 = 1793929036000;

export function testPins(over: { templateHashes?: Partial<Pins["networks"]["mainnet"]["templateHashes"]>; receiptSigners?: Hex[]; lighterIntegratorIndex?: Partial<Record<"lighter-mainnet" | "lighter-rh", number | null>> } = {}): Pins {
  const base = PINS.networks.mainnet;
  return mergePins(PINS, {
    networks: {
      mainnet: {
        builders: { hyperliquid: BUILDER_HL, aster: BUILDER_ASTER },
        templateHashes: { ...base.templateHashes, ...(over.templateHashes ?? {}) },
        receiptSigners: (over.receiptSigners ?? []).map((address) => ({ address })),
        lighterIntegratorIndex: { ...base.lighterIntegratorIndex, ...(over.lighterIntegratorIndex ?? {}) },
      },
    },
  });
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const preview = (intent: OrderIntent, px: string, size: string) => ({
  marketId: intent.marketId,
  side: intent.side,
  size,
  px,
  notionalUsd: "100",
  venueFeeBps: 4.5,
  builderFeeBps: 2,
  builderFee: null,
  slippageBps: 0,
  estLiqPx: null,
  collateralAsset: "USDC",
  reduceOnly: intent.reduceOnly,
  warnings: [],
});

// ---------------------------------------------------------------- Hyperliquid
export const HL_SPEC = { venue: "hyperliquid" as const, marketId: "hyperliquid:-:BTC", assetId: 0, szDecimals: 5 };
export const HL_REF = "76154.5";

export function hlBuild(intent: OrderIntent, o: { nowMs?: number; f?: number; builder?: Hex | null; ref?: string; mutate?: (a: HlOrderAction) => void } = {}): UnsignedVenuePayload {
  const now = o.nowMs ?? T0;
  const dir = intent.side === "buy" ? "down" : "up";
  const raw = intent.type === "limit" ? intent.limitPx! : bound(o.ref ?? HL_REF, intent.maxSlippageBps, intent.side);
  const p = formatPrice(raw, HL_SPEC.szDecimals, dir);
  const s = formatSize(intent.size, HL_SPEC.szDecimals);
  const tif = intent.type === "market" ? "Ioc" : ({ ioc: "Ioc", gtc: "Gtc", alo: "Alo" } as const)[intent.tif];
  const c = (intent.clientOrderId ?? `0x${"ab".repeat(16)}`) as Hex;
  const builder = o.builder === undefined ? BUILDER_HL : o.builder;
  const action: HlOrderAction = builder
    ? { type: "order", orders: [{ a: HL_SPEC.assetId, b: intent.side === "buy", p, s, r: intent.reduceOnly, t: { limit: { tif } }, c }], grouping: "na", builder: { b: builder.toLowerCase() as Hex, f: o.f ?? 20 } }
    : { type: "order", orders: [{ a: HL_SPEC.assetId, b: intent.side === "buy", p, s, r: intent.reduceOnly, t: { limit: { tif } }, c }], grouping: "na" };
  o.mutate?.(action);
  const nonce = now;
  const expiresAfter = now + 30_000;
  return { buildId: `b-${now}`, venue: "hyperliquid", signer: "delegated_key", encoding: "hl_l1_action", payload: { action, nonce, vaultAddress: null, expiresAfter }, digest: l1Digest(action, null, nonce, "Mainnet", expiresAfter), preview: preview(intent, p, s), expiresAt: expiresAfter, eligibilityDecisionId: "elig-test" };
}

// ---------------------------------------------------------------- Aster
export const ASTER_REF = "76147.47";

export function asterParams(intent: OrderIntent, o: { nowMs?: number; feeRate?: string; builder?: Hex; ref?: string; owner?: Hex; signer?: Hex } = {}): Param[] {
  const now = o.nowMs ?? T0;
  const price = intent.type === "limit" ? intent.limitPx! : (() => {
    const b = bound(o.ref ?? ASTER_REF, intent.maxSlippageBps, intent.side);
    const u = toUnits(b, 1, intent.side === "buy" ? "down" : "up"); // tick 0.1
    return fromUnits(u, 1);
  })();
  const tif = intent.type === "market" ? "IOC" : ({ ioc: "IOC", gtc: "GTC", alo: "GTX" } as const)[intent.tif];
  const params: Param[] = [
    ["symbol", intent.marketId.slice("aster:-:".length)],
    ["type", "LIMIT"],
    ["side", intent.side === "buy" ? "BUY" : "SELL"],
    ["timeInForce", tif],
    ["quantity", intent.size],
    ["price", price],
  ];
  if (intent.reduceOnly) params.push(["reduceOnly", "true"]);
  params.push(["newClientOrderId", intent.clientOrderId ?? "cp01test"], ["builder", o.builder ?? BUILDER_ASTER], ["feeRate", o.feeRate ?? "0.0002"], ["asterChain", "Mainnet"], ["user", o.owner ?? OWNER], ["signer", o.signer ?? AGENT], ["nonce", now * 1000]);
  return params;
}

export function asterBuild(intent: OrderIntent, o: Parameters<typeof asterParams>[1] & { mutate?: (p: Param[]) => Param[] } = {}): UnsignedVenuePayload {
  const now = o.nowMs ?? T0;
  let params = asterParams(intent, o);
  if (o.mutate) params = o.mutate(params);
  const price = String(params.find(([k]) => k === "price")?.[1]);
  return { buildId: `a-${now}`, venue: "aster", signer: "delegated_key", encoding: "aster_v3_params", payload: { method: "POST", path: "/fapi/v3/order", chainId: 1666, params, signer: o.signer ?? AGENT, clientOrderId: intent.clientOrderId ?? "cp01test", kind: "order" }, digest: digestTrade(queryString(params), 1666), preview: preview(intent, price, intent.size), expiresAt: now + 30_000, eligibilityDecisionId: "elig-test" };
}

// ---------------------------------------------------------------- Lighter
export const LIGHTER_SPEC = { venue: "lighter-mainnet" as const, marketId: "lighter-mainnet:-:ETH", marketIndex: 0, sizeDecimals: 4, priceDecimals: 2 };
export const LIGHTER_REF = "3000.00";
export const LIGHTER_ACCT = { accountIndex: 712, apiKeyIndex: 5 };

export function lighterArgs(intent: OrderIntent, o: { nowMs?: number; integrator?: number; ref?: string } = {}): Record<string, number | boolean> {
  const now = o.nowMs ?? T0;
  const px = intent.type === "limit" ? toUnits(intent.limitPx!, LIGHTER_SPEC.priceDecimals, intent.side === "buy" ? "down" : "up") : toUnits(bound(o.ref ?? LIGHTER_REF, intent.maxSlippageBps, intent.side), LIGHTER_SPEC.priceDecimals, intent.side === "buy" ? "down" : "up");
  return {
    marketIndex: LIGHTER_SPEC.marketIndex,
    clientOrderIndex: 77,
    baseAmount: Number(toUnits(intent.size, LIGHTER_SPEC.sizeDecimals, "down")),
    price: Number(px),
    isAsk: intent.side === "sell",
    orderType: intent.type === "market" ? 1 : 0,
    timeInForce: intent.tif === "ioc" ? 0 : intent.tif === "alo" ? 2 : 1,
    reduceOnly: intent.reduceOnly,
    triggerPrice: 0,
    orderExpiry: now + 28 * 86_400_000,
    integratorAccountIndex: o.integrator ?? 0,
    integratorTakerFee: 0,
    integratorMakerFee: 0,
    selfTradeBehaviorMode: 0,
    selfTradeEqualityMode: 0,
    nonce: 9,
    apiKeyIndex: LIGHTER_ACCT.apiKeyIndex,
    accountIndex: LIGHTER_ACCT.accountIndex,
    expiredAt: now + 10 * 60_000 - 1000,
  };
}

export function lighterBuild(intent: OrderIntent, o: Parameters<typeof lighterArgs>[1] & { mutate?: (a: Record<string, number | boolean>) => void; digest?: Hex } = {}): UnsignedVenuePayload {
  const now = o.nowMs ?? T0;
  const args = lighterArgs(intent, o);
  o.mutate?.(args);
  const digest = o.digest ?? (`0x${Buffer.from(keccak_256(utf8ToBytes(JSON.stringify(args)))).toString("hex")}` as Hex);
  return { buildId: `l-${now}`, venue: "lighter-mainnet", signer: "delegated_key", encoding: "lighter_tx", payload: { txType: 14, args }, digest, preview: preview(intent, fromUnits(args.price as number, 2), intent.size), expiresAt: now + 30_000, eligibilityDecisionId: "elig-test" };
}

export function randomIntent(r: () => number, marketId: string, ref: string, sizeDp: number): OrderIntent {
  const side = pick(r, ["buy", "sell"] as const);
  const type = pick(r, ["market", "limit"] as const);
  const size = (1 + Math.floor(r() * 5000)) / 10 ** Math.min(sizeDp, 3);
  const refN = Number(ref);
  const limit = (refN * (side === "buy" ? 1 - r() * 0.01 : 1 + r() * 0.01)).toFixed(1);
  return {
    marketId,
    side,
    size: size.toFixed(Math.min(sizeDp, 3)),
    type,
    ...(type === "limit" ? { limitPx: limit } : {}),
    tif: type === "market" ? "ioc" : pick(r, ["gtc", "ioc", "alo"] as const),
    reduceOnly: r() < 0.3,
    maxSlippageBps: 10 + Math.floor(r() * 90),
  };
}
