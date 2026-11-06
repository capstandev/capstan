// Submit (spec 4.1): POST /exchange, weight 1 + floor(n / 40), never retried (a duplicate order is worse than a failed
// one). A builder refusal maps to BUILDER_APPROVAL_REQUIRED and is never resubmitted without the field. A transport
// failure is an UNKNOWN outcome, never assumed rejected: the relay checks orderStatus by cloid before anything else.
import { CapstanError, type Hex, type Receipt, type SignedEnvelope, type SubmitResult } from "@capstan/schema";
import { hlExchangeWeight, VenueHttpError, type VenueHttp } from "@capstan/venue-client";
import { sha256Jcs, type HlUnsignedPayload } from "./orders";
import { payloadHash, type HlSignedBody } from "./verify";

const BUILDER_ERR = /builder/i;

interface HlExchangeResponse {
  status: "ok" | "err";
  response?: string | { type?: string; data?: { statuses?: ({ resting?: { oid: number | string; cloid?: string } } | { filled?: { totalSz: string; avgPx: string; oid: number | string; cloid?: string } } | { error?: string } | string)[] } };
}

function firstStatus(r: HlExchangeResponse): { oid: string | null; error: string | null } {
  if (typeof r.response !== "object" || !r.response) return { oid: null, error: null };
  const st = r.response.data?.statuses?.[0];
  if (!st) return { oid: null, error: null };
  if (typeof st === "string") return { oid: null, error: st === "success" ? null : st };
  if ("error" in st && st.error) return { oid: null, error: st.error };
  if ("resting" in st && st.resting) return { oid: String(st.resting.oid), error: null };
  if ("filled" in st && st.filled) return { oid: String(st.filled.oid), error: null };
  return { oid: null, error: null };
}

export async function submit(env: SignedEnvelope, http: VenueHttp): Promise<SubmitResult> {
  const body = env.signedBody as HlSignedBody;
  if (!body?.action) throw new CapstanError("INVALID_INPUT", "signedBody has no action");
  const n = (body.action as { orders?: unknown[]; cancels?: unknown[] }).orders?.length ?? (body.action as { cancels?: unknown[] }).cancels?.length ?? 1;
  let resp: HlExchangeResponse;
  try {
    resp = await http.postJson<HlExchangeResponse>("/exchange", body, hlExchangeWeight(n));
  } catch (e) {
    if (e instanceof VenueHttpError && e.httpStatus >= 400 && e.httpStatus < 500 && e.httpStatus !== 429) {
      const text = typeof e.body === "string" ? e.body : JSON.stringify(e.body).slice(0, 300);
      return { status: "rejected", venueOrderId: null, txHash: null, venueResponse: e.body, code: BUILDER_ERR.test(text) ? "BUILDER_APPROVAL_REQUIRED" : "VENUE_ERROR", message: text };
    }
    // timeout, 5xx, network: the order may or may not exist at the venue
    return { status: "unknown", venueOrderId: null, txHash: null, venueResponse: e instanceof VenueHttpError ? e.body : String((e as Error)?.message ?? e), code: "VENUE_ERROR", message: "no clear answer from Hyperliquid; check the order by cloid before any resend" };
  }
  if (resp?.status === "err") {
    const text = typeof resp.response === "string" ? resp.response : JSON.stringify(resp.response ?? null);
    return { status: "rejected", venueOrderId: null, txHash: null, venueResponse: resp, code: BUILDER_ERR.test(text) ? "BUILDER_APPROVAL_REQUIRED" : "VENUE_ERROR", message: text };
  }
  if (resp?.status !== "ok") return { status: "unknown", venueOrderId: null, txHash: null, venueResponse: resp, code: "VENUE_ERROR", message: "unexpected exchange response" };
  const st = firstStatus(resp);
  if (st.error) return { status: "rejected", venueOrderId: null, txHash: null, venueResponse: resp, code: BUILDER_ERR.test(st.error) ? "BUILDER_APPROVAL_REQUIRED" : "VENUE_ERROR", message: st.error };
  return { status: "accepted", venueOrderId: st.oid, txHash: null, venueResponse: resp };
}

/** Receipt draft as todo 24 defines it: the receipt minus v, id, ts, brand, chain link and signature. */
export type HlReceiptDraft = Omit<Receipt, "v" | "receiptId" | "ts" | "brand" | "prevReceiptHash" | "sig">;

export function toReceiptDraft(build: HlUnsignedPayload, env: SignedEnvelope, venueResp: unknown, opts: { canonicalAsset?: string | null } = {}): HlReceiptDraft {
  const st = venueResp && typeof venueResp === "object" ? firstStatus(venueResp as HlExchangeResponse) : { oid: null, error: null };
  const b = build.meta.builder;
  return {
    action: build.meta.kind === "cancel" ? "order.cancel" : "order.submit",
    owner: build.meta.owner,
    agentRef: build.meta.agentRef,
    venue: "hyperliquid",
    marketId: build.meta.marketId,
    canonicalAsset: opts.canonicalAsset ?? null,
    requestHash: build.meta.requestHash,
    buildId: build.buildId,
    signedPayloadHash: payloadHash(env.signedBody),
    builder: b ? { address: b.b, feeBps: b.f / 10, rawUnit: `f=${b.f}` } : null,
    quoteSnapshotHash: build.meta.quoteSnapshotHash,
    eligibilityDecisionId: build.eligibilityDecisionId,
    policyId: build.meta.policyId,
    venueResponseHash: sha256Jcs(venueResp ?? null) as Hex,
    venueOrderId: st.oid,
    txHash: null,
  };
}
