// Checks a client-signed Lighter tx against its build before anything is sent: tx type, every field of txInfo, the
// L2 attributes (integrator index, zero fees, no nonce skip), and the pre-signature hash. The Schnorr signature
// itself is checked by the venue (no TS port of the ECgFp5 curve in v1); a hash that matches the build plus the
// venue's own signature check means a different payload cannot pass.
import { CapstanError, type DelegationState, type SignedEnvelope, type VenueIdentity, type VerifyResult } from "@capstan/schema";
import { parseJsonLossless } from "@capstan/venue-client";
import type { HashOnly, LighterBuild } from "./orders";
import type { LighterReader } from "./read";

export interface LighterSignedBody {
  txType: number;
  txInfo: string;
}

const SIG_RE = /^[A-Za-z0-9+/]{106,108}={0,2}$/;
// L2TxAttributes keys (lighter-go types/txtypes/tx_attributes.go)
const ATTR = { integratorAccountIndex: "1", integratorTakerFee: "2", integratorMakerFee: "3", skipNonce: "4", selfTradeBehavior: "6", selfTradeEquality: "7" } as const;
const ALLOWED_ATTRS = new Set<string>([ATTR.integratorAccountIndex, ATTR.integratorTakerFee, ATTR.integratorMakerFee, ATTR.selfTradeBehavior, ATTR.selfTradeEquality]);

export function parseSignedBody(body: unknown): { txType: number; info: Record<string, unknown> } | null {
  const b = body as Partial<LighterSignedBody> | null;
  if (!b || typeof b.txType !== "number" || typeof b.txInfo !== "string") return null;
  try {
    const info = parseJsonLossless(b.txInfo);
    if (!info || typeof info !== "object" || Array.isArray(info)) return null;
    return { txType: b.txType, info: info as Record<string, unknown> };
  } catch {
    return null;
  }
}

const bit = (b: boolean) => (b ? 1 : 0);

function expectedFields(build: LighterBuild): Record<string, number> {
  const p = build.payload;
  if (p.txType === 14) {
    const a = p.args;
    return {
      AccountIndex: a.accountIndex,
      ApiKeyIndex: a.apiKeyIndex,
      MarketIndex: a.marketIndex,
      ClientOrderIndex: a.clientOrderIndex,
      BaseAmount: a.baseAmount,
      Price: a.price,
      IsAsk: bit(a.isAsk),
      Type: a.orderType,
      TimeInForce: a.timeInForce,
      ReduceOnly: bit(a.reduceOnly),
      TriggerPrice: a.triggerPrice,
      OrderExpiry: a.orderExpiry,
      ExpiredAt: a.expiredAt,
      Nonce: a.nonce,
    };
  }
  const a = p.args;
  return { AccountIndex: a.accountIndex, ApiKeyIndex: a.apiKeyIndex, MarketIndex: a.marketIndex, Index: a.orderIndex, ExpiredAt: a.expiredAt, Nonce: a.nonce };
}

function expectedAttrs(build: LighterBuild): Record<string, number> {
  if (build.payload.txType !== 14) return {};
  const a = build.payload.args;
  const out: Record<string, number> = {};
  if (a.integratorAccountIndex !== 0) out[ATTR.integratorAccountIndex] = a.integratorAccountIndex;
  if (a.selfTradeBehaviorMode !== 0) out[ATTR.selfTradeBehavior] = a.selfTradeBehaviorMode;
  if (a.selfTradeEqualityMode !== 0) out[ATTR.selfTradeEquality] = a.selfTradeEqualityMode;
  return out;
}

const mismatch = (field: string): VerifyResult => ({ ok: false, code: "PAYLOAD_MISMATCH", field });

/** Synchronous part: envelope identity, expiry, every field, the attributes and the digest. */
export function verifySignedSync(env: SignedEnvelope, build: LighterBuild, nowMs: number = Date.now()): VerifyResult {
  if (env.buildId !== build.buildId) return mismatch("buildId");
  if (env.venue !== build.venue) return mismatch("venue");
  if (env.encoding !== "lighter_tx" || build.encoding !== "lighter_tx") return mismatch("encoding");
  if (nowMs > build.expiresAt) return { ok: false, code: "BUILD_EXPIRED" };
  const parsed = parseSignedBody(env.signedBody);
  if (!parsed) return mismatch("signedBody");
  if (parsed.txType !== build.payload.txType) return mismatch("txType");
  const info = parsed.info;
  const want = expectedFields(build);
  for (const [k, v] of Object.entries(want)) if (info[k] !== v) return mismatch(k);
  // no field outside the expected set (plus Sig and L2TxAttributes) may appear
  for (const k of Object.keys(info)) if (!(k in want) && k !== "Sig" && k !== "L2TxAttributes") return mismatch(k);
  const attrs = (info.L2TxAttributes ?? {}) as Record<string, unknown> | null;
  const got = attrs && typeof attrs === "object" ? attrs : {};
  const wantAttrs = expectedAttrs(build);
  for (const k of Object.keys(got)) {
    if (!ALLOWED_ATTRS.has(k)) return mismatch(`L2TxAttributes.${k}`);
    if ((k === ATTR.integratorTakerFee || k === ATTR.integratorMakerFee) && got[k] !== 0) return mismatch(`L2TxAttributes.${k}`);
  }
  for (const [k, v] of Object.entries(wantAttrs)) if (got[k] !== v) return mismatch(`L2TxAttributes.${k}`);
  for (const k of Object.keys(got)) if (k !== ATTR.integratorTakerFee && k !== ATTR.integratorMakerFee && !(k in wantAttrs)) return mismatch(`L2TxAttributes.${k}`);
  const sig = info.Sig;
  if (typeof sig !== "string" || !SIG_RE.test(sig)) return { ok: false, code: "BAD_SIGNATURE", field: "Sig" };
  if (typeof env.signature === "string" && env.signature !== sig) return { ok: false, code: "BAD_SIGNATURE", field: "signature" };
  if (env.payloadHash.toLowerCase() !== build.digest.toLowerCase()) return mismatch("txHash");
  return { ok: true };
}

/** Full check: the synchronous part, then the hash recomputed from the build with a hash-only instance. */
export async function verifySigned(env: SignedEnvelope, build: LighterBuild, hasher: HashOnly, nowMs: number = Date.now()): Promise<VerifyResult> {
  const r = verifySignedSync(env, build, nowMs);
  if (!r.ok) return r;
  const p = build.payload;
  const h = p.txType === 14 ? await hasher.txHashForOrder(p.args) : await hasher.txHashForCancel(p.args);
  const recomputed = `0x${h}`.toLowerCase();
  if (recomputed !== build.digest.toLowerCase() || recomputed !== env.payloadHash.toLowerCase()) return mismatch("txHash");
  return { ok: true };
}

/** Key registration is active only when apikeys lists our public key at the chosen index. */
export async function verifyOnboarding(r: Pick<LighterReader, "apiKeys">, id: VenueIdentity & { pubKey: string }): Promise<DelegationState> {
  if (id.accountIndex === undefined || id.apiKeyIndex === undefined) throw new CapstanError("INVALID_INPUT", "verifyOnboarding needs accountIndex and apiKeyIndex");
  const want = id.pubKey.replace(/^0x/i, "").toLowerCase();
  const keys = await r.apiKeys(id.accountIndex);
  const at = keys.find((k) => k.apiKeyIndex === id.apiKeyIndex);
  const active = !!at && at.publicKey.replace(/^0x/i, "").toLowerCase() === want && !/^0+$/.test(want);
  return { agentActive: active, builderMaxBps: 0, routing: "ok" };
}
