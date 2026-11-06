// sendTx: POST /api/v1/sendTx, form body tx_type + tx_info. Never retried (a duplicate order is worse than a failed
// one). Only trade tx types can be sent from here: create order, cancel, cancel all, key registration and integrator
// approval. Transfer (12), withdraw (13), sub-account, pool, stake and margin types are refused before any request.
// A submit takes the config's per-IP bucket and the owner's per-L1 bucket first.
import { CapstanError, type SignedEnvelope, type SubmitResult } from "@capstan/schema";
import { acquireLighterSubmit, type Governor, type VenueHttp } from "@capstan/venue-client";
import type { LighterConfig } from "./config";
import { parseSignedBody } from "./verify";

/** The only tx types this adapter ever sends. */
export const SENDABLE_TX_TYPES: readonly number[] = Object.freeze([8, 14, 15, 16, 45]);
/** Tx types that move funds or change account structure: never sent, never built. */
export const FORBIDDEN_TX_TYPES: readonly number[] = Object.freeze([9, 10, 11, 12, 13, 18, 19, 29, 41, 42, 43]);

export interface SubmitDeps {
  http: VenueHttp;
  cfg: Readonly<LighterConfig>;
  gov?: Governor;
  owner?: string;
}

/** Map a sendTx answer to a submit result. A 200 with no tx hash is an unknown outcome, never a success. */
export function classifySendTx(httpStatus: number | null, body: unknown, networkError?: string): SubmitResult {
  if (httpStatus === null) return { status: "unknown", venueOrderId: null, txHash: null, venueResponse: networkError ?? null, code: "NETWORK", message: networkError ?? "no answer" };
  const b = (body ?? {}) as { code?: number; message?: string; tx_hash?: string };
  if (httpStatus >= 200 && httpStatus < 300 && b.code === 200) {
    if (typeof b.tx_hash === "string" && b.tx_hash.length > 0) return { status: "accepted", venueOrderId: null, txHash: b.tx_hash, venueResponse: body };
    return { status: "unknown", venueOrderId: null, txHash: null, venueResponse: body, code: "200", message: "accepted without a tx hash" };
  }
  if (httpStatus >= 500 || httpStatus === 0) return { status: "unknown", venueOrderId: null, txHash: null, venueResponse: body, code: String(b.code ?? httpStatus), message: b.message ?? `HTTP ${httpStatus}` };
  // API server reject (4xx or a non-200 code): the nonce was not consumed (resend the same signed tx)
  return { status: "rejected", venueOrderId: null, txHash: null, venueResponse: body, code: String(b.code ?? httpStatus), message: b.message ?? `HTTP ${httpStatus}` };
}

/** Send a signed tx the client made. The envelope's signedBody is { txType, txInfo }. */
export async function submitTx(signed: { txType: number; txInfo: string }, deps: SubmitDeps): Promise<SubmitResult> {
  if (!SENDABLE_TX_TYPES.includes(signed.txType)) throw new CapstanError("INVALID_INPUT", `Lighter tx type ${signed.txType} is not a trade tx and is never sent`);
  if (deps.gov && deps.owner) await acquireLighterSubmit(deps.gov, deps.cfg.governorKey as "lighter-304" | "lighter-466324" | "lighter-300", deps.owner, { priority: signed.txType === 15 || signed.txType === 16 ? "safety" : "pro" });
  try {
    const r = await deps.http.request("POST", "/api/v1/sendTx", { form: { tx_type: String(signed.txType), tx_info: signed.txInfo } });
    return classifySendTx(r.httpStatus, r.body);
  } catch (e) {
    if (e instanceof CapstanError) throw e; // governor refusal: nothing was sent
    return classifySendTx(null, null, (e as Error).message);
  }
}

export async function submit(env: SignedEnvelope, deps: SubmitDeps): Promise<SubmitResult> {
  if (env.encoding !== "lighter_tx" || env.venue !== deps.cfg.venue) throw new CapstanError("INVALID_INPUT", `envelope is not a ${deps.cfg.venue} tx`);
  const p = parseSignedBody(env.signedBody);
  if (!p) throw new CapstanError("INVALID_INPUT", "signedBody must be { txType, txInfo }");
  const b = env.signedBody as { txType: number; txInfo: string };
  return submitTx({ txType: p.txType, txInfo: b.txInfo }, deps);
}
