// Facilitator service: the stock x402 facilitator (exact scheme, EVM + SVM) behind Capstan's safety layer.
// - /verify writes nothing.
// - /settle is durable and idempotent: key = sha256 of the canonical payment payload; a second call returns the
//   first result and never broadcasts again; a broadcast without a receipt stays settlement_pending until the
//   reconciler confirms it on chain (no retry before that).
// - Mainnet guard: no broadcast on Base, RHC or Solana mainnet unless armed (X402_SETTLE_ARMED=1 plus the arming file).
// - Amount 0 is refused; Solana payments must pass the layout rules first; the float guard alerts above $200.
import type { Logger } from "@capstan/core";
import { recordX402SettleFailure, SERVICE_METRICS } from "@capstan/telemetry";
import { MAINNET_NETWORKS, isSvmNetwork, SOLANA_MAX_CU_PRICE_MICROLAMPORTS, validateSvmLayout, type floatGuard, type FloatHolding } from "@capstan/x402";
import type { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PaymentRow, PaymentStore } from "./store";

export const ERR = {
  invalidPayload: "invalid_payload",
  zeroAmount: "invalid_payment_amount",
  notArmed: "settle_not_armed",
  pending: "settlement_pending",
  txState: "invalid_transaction_state",
  unexpected: "unexpected_settle_error",
  svmLayout: "invalid_exact_svm_payload_transaction",
  unsupportedNetwork: "invalid_network",
} as const;

/** Canonical JSON (sorted keys, no whitespace) so one payment always hashes to one key. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}
export function paymentKey(p: PaymentPayload): string {
  return createHash("sha256").update(canonicalJson(p)).digest("hex");
}

const Req = z.object({
  scheme: z.string().min(1),
  network: z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9]+$/),
  asset: z.string().min(1),
  amount: z.string().regex(/^\d{1,78}$/),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).default({}),
});
export const RequestBody = z.object({
  x402Version: z.literal(2),
  paymentPayload: z.object({ x402Version: z.literal(2), accepted: Req, payload: z.record(z.string(), z.unknown()) }).passthrough(),
  paymentRequirements: Req,
});
export type RequestBody = z.infer<typeof RequestBody>;

/** Ties a broadcast hash, reported by a signer before it sends, to the settle that is running. */
export function broadcastTracker() {
  const als = new AsyncLocalStorage<{ id: string; store: PaymentStore; hashes: string[] }>();
  return {
    run<T>(id: string, store: PaymentStore, fn: () => Promise<T>): Promise<T> {
      return als.run({ id, store, hashes: [] }, fn);
    },
    async onBroadcast(hash: string): Promise<void> {
      const ctx = als.getStore();
      if (!ctx) throw new Error("broadcast outside a settle: refused");
      ctx.hashes.push(hash);
      await ctx.store.markPending(ctx.id, hash);
    },
  };
}
export type BroadcastTracker = ReturnType<typeof broadcastTracker>;

export interface ChainProbe {
  /** "success" / "reverted" when mined, null when no receipt yet. */
  receipt(hash: string): Promise<"success" | "reverted" | null>;
  /** Whether the node knows the transaction at all (mempool or chain). */
  known(hash: string): Promise<boolean>;
}

export interface Alert {
  kind: string;
  [k: string]: unknown;
}

export interface ServiceOptions {
  facilitator: x402Facilitator;
  store: PaymentStore;
  tracker: BroadcastTracker;
  probes: Partial<Record<string, ChainProbe>>;
  log: Logger;
  alert: (a: Alert) => Promise<void> | void;
  /** True only when mainnet settles are armed (checked on every settle). */
  isArmed: () => boolean;
  /** Solana sponsor address per network (for the layout pre-check). */
  svmFeePayers?: Partial<Record<string, string>>;
  float?: ReturnType<typeof floatGuard>;
  /** Addresses whose collected balance the float guard watches (a sweep payTo). Lower case. */
  floatHolders?: string[];
  /** A pending row whose tx the node never saw is marked dropped after this long (default 10 min). */
  dropAfterMs?: number;
  now?: () => number;
}

export type Outcome<T> = { status: number; body: T };

function methodOf(p: Record<string, unknown>, network: string): "permit2" | "eip3009" | "spl" | "unknown" {
  if (isSvmNetwork(network)) return "spl";
  if (p.permit2Authorization) return "permit2";
  if (p.authorization) return "eip3009";
  return "unknown";
}
function payerOf(p: Record<string, unknown>): string {
  const a = (p.authorization ?? p.permit2Authorization) as { from?: unknown } | undefined;
  return typeof a?.from === "string" ? a.from : "";
}
const statusFor = (reason: string | undefined, ok: boolean): number => (ok ? 200 : reason === "permit2_allowance_required" ? 412 : reason === ERR.notArmed ? 403 : reason === ERR.invalidPayload ? 400 : 402);

export function createFacilitatorService(o: ServiceOptions) {
  const now = o.now ?? Date.now;
  const dropAfter = o.dropAfterMs ?? 10 * 60 * 1000;

  function parse(body: unknown): { ok: true; b: RequestBody } | { ok: false; reason: string } {
    const r = RequestBody.safeParse(body);
    if (!r.success) return { ok: false, reason: ERR.invalidPayload };
    if (BigInt(r.data.paymentRequirements.amount) === 0n || BigInt(r.data.paymentPayload.accepted.amount) === 0n) return { ok: false, reason: ERR.zeroAmount };
    return { ok: true, b: r.data };
  }

  function svmCheck(b: RequestBody): string | null {
    const n = b.paymentRequirements.network;
    if (!isSvmNetwork(n)) return null;
    const feePayer = o.svmFeePayers?.[n];
    const tx = b.paymentPayload.payload.transaction;
    if (!feePayer) return ERR.unsupportedNetwork;
    if (typeof tx !== "string") return ERR.svmLayout;
    const r = validateSvmLayout(tx, { feePayer, maxCuPriceMicrolamports: SOLANA_MAX_CU_PRICE_MICROLAMPORTS });
    return r.ok ? null : ERR.svmLayout;
  }

  async function verify(body: unknown): Promise<Outcome<VerifyResponse>> {
    const p = parse(body);
    if (!p.ok) return { status: p.reason === ERR.invalidPayload ? 400 : 402, body: { isValid: false, invalidReason: p.reason } };
    const svm = svmCheck(p.b);
    if (svm) return { status: 402, body: { isValid: false, invalidReason: svm } };
    try {
      const r = await o.facilitator.verify(p.b.paymentPayload as PaymentPayload, p.b.paymentRequirements as PaymentRequirements);
      return { status: r.isValid ? 200 : statusFor(r.invalidReason, false), body: r };
    } catch (err) {
      o.log.warn("verify threw", { err });
      return { status: 500, body: { isValid: false, invalidReason: "unexpected_verify_error" } };
    }
  }

  function fromRow(r: PaymentRow): Outcome<SettleResponse> {
    const network = r.chain as SettleResponse["network"];
    if (r.status === "settled") return { status: 200, body: { success: true, transaction: r.txHash ?? "", network, payer: r.payer, amount: r.amount } };
    if (r.status === "settling" || r.status === "settlement_pending") {
      return { status: 202, body: { success: false, errorReason: ERR.pending, transaction: r.txHash ?? "", network, payer: r.payer } };
    }
    return { status: 402, body: { success: false, errorReason: ERR.txState, transaction: r.txHash ?? "", network, payer: r.payer } };
  }

  async function reconcileRow(r: PaymentRow): Promise<PaymentRow> {
    if (r.status !== "settlement_pending" || !r.txHash) return r;
    const probe = o.probes[r.chain];
    if (!probe) return r;
    try {
      const rc = await probe.receipt(r.txHash);
      if (rc === "success") {
        await o.store.finish(r.id, "settled", r.txHash);
        SERVICE_METRICS.x402Settled.inc(r.chain);
        return { ...r, status: "settled" };
      }
      if (rc === "reverted") {
        await o.store.finish(r.id, "failed", r.txHash);
        recordX402SettleFailure(r.chain);
        return { ...r, status: "failed" };
      }
      if (now() - r.ts.getTime() > dropAfter && !(await probe.known(r.txHash))) {
        await o.store.finish(r.id, "dropped", r.txHash);
        recordX402SettleFailure(r.chain);
        await o.alert({ kind: "x402.settle_dropped", id: r.id, chain: r.chain });
        return { ...r, status: "dropped" };
      }
    } catch (err) {
      o.log.warn("reconcile check failed", { err, id: r.id });
    }
    return r;
  }

  async function settle(body: unknown): Promise<Outcome<SettleResponse>> {
    const p = parse(body);
    if (!p.ok) return { status: p.reason === ERR.invalidPayload ? 400 : 402, body: { success: false, errorReason: p.reason, transaction: "", network: "unknown:unknown" } };
    const { paymentPayload, paymentRequirements: req } = p.b;
    const network = req.network as SettleResponse["network"];
    if ((MAINNET_NETWORKS as readonly string[]).includes(network) && !o.isArmed()) {
      o.log.warn("mainnet settle refused: not armed", { network });
      return { status: 403, body: { success: false, errorReason: ERR.notArmed, transaction: "", network } };
    }
    const svm = svmCheck(p.b);
    if (svm) return { status: 402, body: { success: false, errorReason: svm, transaction: "", network } };

    const id = paymentKey(paymentPayload as PaymentPayload);
    const inner = paymentPayload.payload;
    const claim = await o.store.claim({
      id,
      chain: network,
      asset: req.asset,
      method: methodOf(inner, network),
      payer: payerOf(inner),
      amount: req.amount,
      endpoint: (paymentPayload as PaymentPayload).resource?.url ?? "",
      ts: new Date(now()),
    });
    if (!claim.claimed) {
      const row = claim.row.status === "settlement_pending" ? await reconcileRow(claim.row) : claim.row;
      return fromRow(row);
    }

    if (o.float && o.floatHolders?.includes(req.payTo.toLowerCase())) {
      const incoming: FloatHolding = { network, asset: req.asset, holder: req.payTo, atomic: BigInt(req.amount), decimals: 6 };
      await o.float.check([incoming]);
    }

    // Verify first (read-only), so a payment that cannot settle never reaches a broadcast or a gas estimate.
    let pre: VerifyResponse;
    try {
      pre = await o.facilitator.verify(paymentPayload as PaymentPayload, req as PaymentRequirements);
    } catch (err) {
      o.log.warn("pre-settle verify threw", { err, id });
      pre = { isValid: false, invalidReason: "unexpected_verify_error" };
    }
    if (!pre.isValid) {
      await o.store.finish(id, "failed", null, pre.payer);
      recordX402SettleFailure(network);
      const reason = pre.invalidReason ?? ERR.invalidPayload;
      return { status: statusFor(reason, false), body: { success: false, errorReason: reason, transaction: "", network, payer: pre.payer } };
    }

    let r: SettleResponse;
    try {
      r = await o.tracker.run(id, o.store, () => o.facilitator.settle(paymentPayload as PaymentPayload, req as PaymentRequirements));
    } catch (err) {
      o.log.error("settle threw", { err, id });
      const row = await o.store.get(id);
      if (row?.status === "settlement_pending") return fromRow(row);
      await o.store.finish(id, "failed", null);
      recordX402SettleFailure(network);
      return { status: 500, body: { success: false, errorReason: ERR.unexpected, transaction: "", network } };
    }
    const tx = r.transaction || null;
    if (r.success) {
      await o.store.finish(id, "settled", tx, r.payer);
      SERVICE_METRICS.x402Settled.inc(network);
    } else if (r.errorReason === ERR.pending && tx) {
      await o.store.markPending(id, tx);
      return { status: 202, body: r };
    } else {
      const row = await o.store.get(id);
      // a recorded broadcast with a failed result: keep it pending, only the reconciler decides
      if (row?.status === "settlement_pending" && !tx) return fromRow(row);
      await o.store.finish(id, "failed", tx, r.payer);
      recordX402SettleFailure(network);
    }
    return { status: statusFor(r.errorReason, r.success), body: r };
  }

  async function reconcile(): Promise<{ checked: number; settled: number; failed: number; dropped: number }> {
    const rows = await o.store.pending();
    const out = { checked: rows.length, settled: 0, failed: 0, dropped: 0 };
    for (const r of rows) {
      const n = await reconcileRow(r);
      if (n.status === "settled") out.settled++;
      else if (n.status === "failed") out.failed++;
      else if (n.status === "dropped") out.dropped++;
    }
    return out;
  }

  return { verify, settle, reconcile, supported: () => o.facilitator.getSupported() };
}

export type FacilitatorService = ReturnType<typeof createFacilitatorService>;
