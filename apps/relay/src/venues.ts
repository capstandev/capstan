// One RelayVenue per executable venue: the adapter's own verifySigned and submit, the governor bucket and weight of a
// submit, the payload hash recomputed from the signed body, and the receipt draft (the adapter's draft where it has
// one, so builder fields come from the adapter, invariant 4).
import { payloadHash as hlPayloadHash, toReceiptDraft as hlDraft, type HlUnsignedPayload } from "@capstan/adapter-hyperliquid";
import { toReceiptDraft as asterDraft } from "@capstan/adapter-aster";
import { draft, jcs, type ReceiptDraft } from "@capstan/receipts";
import type { Hex, SignedEnvelope, SubmitResult, VenueAdapter, VenueId } from "@capstan/schema";
import { payloadHashOf as asterPayloadHash } from "@capstan/signer-aster";
import { asterWeight, hlExchangeWeight, VenueHttpError, type BucketKey, type VenueHttp } from "@capstan/venue-client";
import { createHash } from "node:crypto";
import { flagOf } from "./flags";
import type { RelayVenue, StoredBuild } from "./types";

export const sha256Jcs = (v: unknown): Hex => `0x${createHash("sha256").update(jcs(v === undefined ? null : v)).digest("hex")}` as Hex;

type Adapter = Pick<VenueAdapter, "caps" | "verifySigned" | "submit">;

/** Normalise any draft through the receipts package builder (checks every field the action needs). */
function checked(d: ReceiptDraft): ReceiptDraft {
  const { action, ...rest } = d;
  return draft(action, rest);
}

function hlCount(env: SignedEnvelope): number {
  const a = (env.signedBody as { action?: { orders?: unknown[]; cancels?: unknown[] } } | null)?.action;
  return a?.orders?.length ?? a?.cancels?.length ?? 1;
}

type Lookup = NonNullable<RelayVenue["lookup"]>;
const HL_CLOID = /^0x[0-9a-fA-F]{32}$/;

/**
 * Hyperliquid orderStatus by the order's cloid (public info read, weight 2): any known order was accepted by the
 * venue (open, filled, canceled and so on), a status naming a rejection is rejected. unknownOid, a cancel (no cloid)
 * or a bad answer gives no answer: Hyperliquid answers an exchange post at once, but the sweep never guesses.
 */
export function hlLookup(http: Pick<VenueHttp, "postJson">): Lookup {
  return async (b) => {
    const action = (b.build as HlUnsignedPayload).payload?.action as { type?: string; orders?: { c?: unknown }[] } | undefined;
    const cloid = action?.type === "order" ? action.orders?.[0]?.c : undefined;
    if (typeof cloid !== "string" || !HL_CLOID.test(cloid)) return null;
    const j = await http.postJson<{ status?: unknown; order?: { order?: { oid?: unknown }; status?: unknown } }>("/info", { type: "orderStatus", user: b.owner.toLowerCase(), oid: cloid.toLowerCase() }, 2);
    if (j?.status !== "order" || typeof j.order?.status !== "string") return null;
    const oid = j.order.order?.oid;
    const venueOrderId = typeof oid === "number" || typeof oid === "string" ? String(oid) : null;
    const status: SubmitResult["status"] = /rejected/i.test(j.order.status) ? "rejected" : "accepted";
    return { status, venueOrderId, txHash: null, venueResponse: j };
  };
}

/** Lighter tx by its hash (the payload hash the build carries; public read). Found means the venue took the tx. */
export function lighterLookup(http: Pick<VenueHttp, "getJson">): Lookup {
  return async (_b, payloadHash) => {
    try {
      const r = await http.getJson<{ hash?: unknown; status?: unknown }>("/api/v1/tx", { by: "hash", value: payloadHash });
      if (!r || typeof r !== "object" || r.hash === undefined) return null;
      return { status: "accepted", venueOrderId: null, txHash: typeof r.hash === "string" ? r.hash : payloadHash, venueResponse: r };
    } catch (e) {
      if (e instanceof VenueHttpError && e.httpStatus >= 400 && e.httpStatus < 500) return null;
      throw e;
    }
  };
}

export function hlRelayVenue(adapter: Adapter, o: { governorKey?: BucketKey; lookup?: Lookup } = {}): RelayVenue {
  return {
    ...(o.lookup ? { lookup: o.lookup } : {}),
    venue: "hyperliquid",
    flag: "HL_ENABLED",
    adapter,
    governorKey: o.governorKey ?? "hyperliquid",
    costOf: (env) => hlExchangeWeight(hlCount(env)),
    payloadHashOf: (env) => hlPayloadHash(env.signedBody),
    draft(b, env, result) {
      const d = hlDraft(b.build as HlUnsignedPayload, env, result.venueResponse) as ReceiptDraft;
      return checked({ ...d, action: b.kind === "cancel" ? "order.cancel" : "order.submit", venueOrderId: result.venueOrderId ?? d.venueOrderId, txHash: result.txHash });
    },
  };
}

export function asterRelayVenue(adapter: Adapter, o: { governorKey?: BucketKey } = {}): RelayVenue {
  return {
    venue: "aster",
    flag: "ASTER_ENABLED",
    adapter,
    governorKey: o.governorKey ?? "aster",
    costOf: () => asterWeight("/fapi/v3/order"),
    payloadHashOf: (env) => asterPayloadHash(typeof env.signedBody === "string" ? env.signedBody : jcs(env.signedBody ?? null)),
    draft(b, _env, result, payloadHash) {
      const a = asterDraft(b.build, result);
      return checked({
        action: b.kind === "cancel" ? "order.cancel" : "order.submit",
        owner: b.owner,
        agentRef: b.agentRef,
        venue: "aster",
        marketId: b.marketId,
        canonicalAsset: null,
        requestHash: b.requestHash,
        buildId: b.build.buildId,
        signedPayloadHash: payloadHash,
        builder: a.builder,
        quoteSnapshotHash: null,
        eligibilityDecisionId: b.eligibilityDecisionId,
        policyId: b.policyId,
        venueResponseHash: sha256Jcs(result.venueResponse),
        venueOrderId: a.venueOrderId,
        txHash: null,
      });
    },
  };
}

const LIGHTER_CANCEL_TYPES = new Set([15, 16]);

export function lighterRelayVenue(venue: Extract<VenueId, "lighter-mainnet" | "lighter-rh">, adapter: Adapter, o: { governorKey?: BucketKey; l1Of: (b: StoredBuild) => string; lookup?: Lookup }): RelayVenue {
  return {
    ...(o.lookup ? { lookup: o.lookup } : {}),
    venue,
    flag: flagOf(venue)!,
    adapter,
    governorKey: o.governorKey ?? (venue === "lighter-rh" ? "lighter-466324" : "lighter-304"),
    costOf: () => 1,
    lighterL1: o.l1Of,
    // the Lighter tx hash is the pre-signature hash the build already carries; verifySigned holds env to it
    payloadHashOf: (env) => (typeof env.payloadHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(env.payloadHash) ? (env.payloadHash.toLowerCase() as Hex) : sha256Jcs(env.signedBody)),
    draft(b, env, result, payloadHash) {
      const t = (env.signedBody as { txType?: number } | null)?.txType;
      return checked({
        action: b.kind === "cancel" || (t !== undefined && LIGHTER_CANCEL_TYPES.has(t)) ? "order.cancel" : "order.submit",
        owner: b.owner,
        agentRef: b.agentRef,
        venue,
        marketId: b.marketId,
        canonicalAsset: null,
        requestHash: b.requestHash,
        buildId: b.build.buildId,
        signedPayloadHash: payloadHash,
        builder: null, // Lighter integrator attribution charges 0 (no builder fee field)
        quoteSnapshotHash: null,
        eligibilityDecisionId: b.eligibilityDecisionId,
        policyId: b.policyId,
        venueResponseHash: sha256Jcs(result.venueResponse),
        venueOrderId: result.venueOrderId,
        txHash: result.txHash,
      });
    },
  };
}

/** Result for a failed submit the relay must still receipt. */
export const venueErrorText = (r: SubmitResult): string => (r.message ?? r.code ?? "venue error").slice(0, 200);
