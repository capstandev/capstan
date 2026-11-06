// verifySigned (spec 2): the relay never forwards a payload the build did not produce. Every field of the signed body
// is compared with the build (naming the first field that differs), the msgpack bytes must be identical, the digest
// is recomputed, and the signature must recover to the delegation's agent address.
import { CapstanError, type Hex, type SignedEnvelope, type VerifyResult } from "@capstan/schema";
import { actionMsgpack, l1Digest, recoverSigner, sigToHl, type HlL1Action, type HlOrderAction } from "@capstan/signer-hl";
import { sha256Jcs, type AgentState, type HlUnsignedPayload } from "./orders";

export type HlVerifyResult = VerifyResult | { ok: false; code: "RETIRED_AGENT" | "AGENT_KILLED"; field?: string };

export interface HlSignedBody {
  action: HlL1Action;
  nonce: number;
  signature: { r: Hex; s: Hex; v: number };
  vaultAddress: Hex | null;
  expiresAfter: number | null;
}

/** Dedupe key: sha256 of the JCS of the signed body. Deterministic for equal bodies. */
export function payloadHash(signedBody: unknown): Hex {
  return sha256Jcs(signedBody);
}

const mismatch = (field: string): HlVerifyResult => ({ ok: false, code: "PAYLOAD_MISMATCH", field });

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function tifOf(t: unknown): string | null {
  const x = t as { limit?: { tif?: string }; trigger?: unknown } | undefined;
  return x?.limit?.tif ?? (x?.trigger ? "trigger" : null);
}

function compareOrder(a: HlOrderAction, b: HlOrderAction): string | null {
  if (!Array.isArray(a.orders) || a.orders.length !== b.orders.length) return "orders";
  for (let i = 0; i < b.orders.length; i++) {
    const x = a.orders[i]!;
    const y = b.orders[i]!;
    if (x.a !== y.a) return `orders[${i}].market`;
    if (x.b !== y.b) return `orders[${i}].side`;
    if (x.s !== y.s) return `orders[${i}].size`;
    if (x.p !== y.p) return `orders[${i}].price`;
    if (x.r !== y.r) return `orders[${i}].reduceOnly`;
    if (tifOf(x.t) !== tifOf(y.t) || !eq(x.t, y.t)) return `orders[${i}].tif`;
    if ((x.c ?? null)?.toString().toLowerCase() !== (y.c ?? null)?.toString().toLowerCase()) return `orders[${i}].cloid`;
    if (!eq(Object.keys(x), Object.keys(y))) return `orders[${i}].keys`;
  }
  if (a.grouping !== b.grouping) return "grouping";
  const ab = a.builder;
  const bb = b.builder;
  if (!!ab !== !!bb) return "builder";
  if (ab && bb) {
    if (String(ab.b).toLowerCase() !== String(bb.b).toLowerCase()) return "builder.address";
    if (ab.f !== bb.f) return "builder.f";
  }
  return null;
}

export interface VerifyOptions {
  nowMs?: number;
  /** Current delegation state (the relay reads it at submit time). */
  agentState?: AgentState;
}

export function verifySigned(env: SignedEnvelope, build: HlUnsignedPayload, opts: VerifyOptions = {}): HlVerifyResult {
  const now = opts.nowMs ?? Date.now();
  if (opts.agentState === "retired") return { ok: false, code: "RETIRED_AGENT" };
  if (opts.agentState === "killed") return { ok: false, code: "AGENT_KILLED" };
  if (now > build.expiresAt) return { ok: false, code: "BUILD_EXPIRED" };
  if (env.buildId !== build.buildId) return mismatch("buildId");
  if (env.venue !== "hyperliquid" || env.encoding !== "hl_l1_action") return mismatch("encoding");
  const body = env.signedBody as HlSignedBody | null;
  if (!body || typeof body !== "object" || !body.action || typeof body.action !== "object") return mismatch("signedBody");
  const want = build.payload;
  if (body.action.type !== want.action.type) return mismatch("type");
  if (want.action.type === "order") {
    const f = compareOrder(body.action as HlOrderAction, want.action);
    if (f) return mismatch(f);
  } else if (!eq(body.action, want.action)) return mismatch("action");
  if (body.nonce !== want.nonce) return mismatch("nonce");
  if ((body.expiresAfter ?? null) !== want.expiresAfter) return mismatch("expiresAfter");
  if ((body.vaultAddress ?? null) !== null) return mismatch("vaultAddress");
  // byte-level: nothing else may differ (key order included)
  if (Buffer.compare(Buffer.from(actionMsgpack(body.action)), Buffer.from(actionMsgpack(want.action))) !== 0) return mismatch("action");
  const digest = l1Digest(body.action, null, body.nonce, build.meta.network, body.expiresAfter ?? undefined);
  if (digest !== build.digest) return mismatch("digest");
  if (env.payloadHash !== payloadHash(body)) return mismatch("payloadHash");
  const agent = build.meta.agentAddress;
  if (!agent) return { ok: false, code: "BAD_SIGNATURE", field: "agent" };
  try {
    const sig = body.signature;
    if (typeof env.signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(env.signature)) {
      const s2 = sigToHl(env.signature as Hex);
      if (BigInt(s2.r) !== BigInt(sig.r) || BigInt(s2.s) !== BigInt(sig.s) || s2.v !== sig.v) return { ok: false, code: "BAD_SIGNATURE", field: "signature" };
    }
    if (recoverSigner(digest, sig).toLowerCase() !== agent.toLowerCase()) return { ok: false, code: "BAD_SIGNATURE", field: "signer" };
  } catch {
    return { ok: false, code: "BAD_SIGNATURE", field: "signature" };
  }
  return { ok: true };
}

/** Throwing form for callers that prefer an error. */
export function assertSigned(env: SignedEnvelope, build: HlUnsignedPayload, opts: VerifyOptions = {}): void {
  const r = verifySigned(env, build, opts);
  if (r.ok) return;
  const code = r.code === "BAD_SIGNATURE" ? "UNAUTHORIZED" : r.code;
  throw new CapstanError(code, r.field ? `${r.code}: ${r.field}` : undefined, r.field ? { field: r.field } : undefined);
}
