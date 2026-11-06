// Submit a verified Aster envelope: POST /fapi/v3/order?{signed query}&signature=..., empty form body. Never retried.
// 503 means the venue does not know whether the order executed: the result is 'unknown' and the order must be
// reconciled by newClientOrderId with a signed read (the relay holds no key, so the SDK does it). A payload is sent
// at most once (dedupe by payload hash), so an unknown outcome is never resubmitted.
import { CapstanError, type SignedEnvelope, type SubmitResult } from "@capstan/schema";
import { payloadHashOf } from "@capstan/signer-aster";
import type { VenueHttp } from "@capstan/venue-client";
import { assertV3Path } from "./config";
import { isDepositRequiredBody } from "./preflight";

export const ASTER_NONCE_EXPIRED = -4225;

/** Remembers every payload hash sent (the relay's dedupe store implements the same port in Redis). */
export interface SubmitLedger {
  /** True when the hash was not seen before (and is now recorded). */
  claim(payloadHash: string): Promise<boolean>;
}

export function memorySubmitLedger(): SubmitLedger {
  const seen = new Set<string>();
  return {
    async claim(h) {
      if (seen.has(h)) return false;
      seen.add(h);
      return true;
    },
  };
}

export function mapVenueError(httpStatus: number, body: unknown): { code: string; message: string } {
  const c = Number((body as { code?: unknown } | null)?.code);
  const msg = String((body as { msg?: unknown } | null)?.msg ?? "");
  if (c === ASTER_NONCE_EXPIRED) return { code: "ASTER_NONCE_EXPIRED", message: "nonce expired: re-sign with a fresh nonce" };
  if (isDepositRequiredBody(body)) return { code: "ASTER_DEPOSIT_REQUIRED", message: "the wallet must complete an Aster deposit first" };
  if (httpStatus === 429 || httpStatus === 418) return { code: "VENUE_RATE_LIMITED", message: "venue rate limit" };
  return { code: "VENUE_ERROR", message: msg.slice(0, 200) || `HTTP ${httpStatus}` };
}

export async function submitAster(env: SignedEnvelope, http: VenueHttp, opts: { ledger?: SubmitLedger; method?: "POST" | "DELETE" } = {}): Promise<SubmitResult> {
  const path = assertV3Path("/fapi/v3/order");
  if (typeof env.signedBody !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(String(env.signature))) throw new CapstanError("INVALID_INPUT", "envelope needs the signed query string and a 65-byte signature");
  const hash = payloadHashOf(env.signedBody);
  if (hash !== env.payloadHash) throw new CapstanError("PAYLOAD_MISMATCH", "payload hash", { field: "payloadHash" });
  if (opts.ledger && !(await opts.ledger.claim(hash))) throw new CapstanError("DUPLICATE_PAYLOAD");
  let raw;
  try {
    raw = await http.request(opts.method ?? "POST", `${path}?${env.signedBody}&signature=${env.signature}`, { form: {}, cost: 1 });
  } catch (e) {
    if (e instanceof CapstanError && e.code === "VENUE_RATE_LIMITED") return { status: "rejected", venueOrderId: null, txHash: null, venueResponse: null, code: "VENUE_RATE_LIMITED", message: e.message };
    // a network error after sending is an unknown outcome, never a failure
    return { status: "unknown", venueOrderId: null, txHash: null, venueResponse: null, code: "VENUE_ERROR", message: "no answer from the venue: reconcile by newClientOrderId" };
  }
  const body = raw.body;
  if (raw.httpStatus === 503) return { status: "unknown", venueOrderId: null, txHash: null, venueResponse: body, code: "VENUE_ERROR", message: "status unknown (503): reconcile by newClientOrderId" };
  const errCode = Number((body as { code?: unknown } | null)?.code);
  if (raw.httpStatus >= 200 && raw.httpStatus < 300 && !(Number.isFinite(errCode) && errCode < 0)) {
    const oid = (body as { orderId?: unknown } | null)?.orderId;
    return { status: "accepted", venueOrderId: oid === undefined || oid === null ? null : String(oid), txHash: null, venueResponse: body };
  }
  const m = mapVenueError(raw.httpStatus, body);
  return { status: "rejected", venueOrderId: null, txHash: null, venueResponse: body, code: m.code, message: m.message };
}
