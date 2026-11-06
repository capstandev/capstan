// Direct mode (spec 1, 7.3 step 6): the SDK host posts the signed payload to the venue itself, at the venue URL this
// SDK knows (never a URL the build names), then claims a receipt with the venue's answer.
import type { SignedEnvelope, VenueId } from "@capstan/schema";
import { SdkError } from "./errors";

export interface DirectResult {
  status: "accepted" | "rejected" | "unknown";
  venueOrderId: string | null;
  txHash: string | null;
  venueResponse: unknown;
  httpStatus: number | null;
}

export async function postDirect(venue: VenueId, env: SignedEnvelope, o: { hosts: Record<string, string>; fetch: typeof fetch; method?: "POST" | "DELETE" }): Promise<DirectResult> {
  const host = o.hosts[venue]?.replace(/\/$/, "");
  if (!host) throw new SdkError("UNSUPPORTED", `no venue host for ${venue}`);
  let r: Response;
  try {
    if (env.encoding === "hl_l1_action") {
      r = await o.fetch(`${host}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env.signedBody) });
    } else if (env.encoding === "aster_v3_params") {
      r = await o.fetch(`${host}/fapi/v3/order?${String(env.signedBody)}&signature=${String(env.signature)}`, { method: o.method ?? "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
    } else if (env.encoding === "lighter_tx") {
      const b = env.signedBody as { txType: number; txInfo: string };
      if (![14, 15].includes(b.txType)) throw new SdkError("UNSUPPORTED", "only order and cancel transactions are sent directly");
      r = await o.fetch(`${host}/api/v1/sendTx`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ tx_type: String(b.txType), tx_info: b.txInfo }).toString() });
    } else throw new SdkError("UNSUPPORTED", "unknown encoding");
  } catch (e) {
    if (e instanceof SdkError) throw e;
    // sent or not, the outcome is unknown: never resend blindly
    return { status: "unknown", venueOrderId: null, txHash: null, venueResponse: null, httpStatus: null };
  }
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (r.status >= 500) return { status: "unknown", venueOrderId: null, txHash: null, venueResponse: body, httpStatus: r.status };
  if (env.encoding === "hl_l1_action") {
    const b = body as { status?: string; response?: { data?: { statuses?: Record<string, { oid?: number }>[] } } };
    const st = b?.response?.data?.statuses?.[0];
    const oid = st?.resting?.oid ?? st?.filled?.oid;
    const ok = b?.status === "ok" && !(st && "error" in st);
    return { status: ok ? "accepted" : "rejected", venueOrderId: oid === undefined ? null : String(oid), txHash: null, venueResponse: body, httpStatus: r.status };
  }
  if (env.encoding === "aster_v3_params") {
    const b = body as { orderId?: unknown; code?: unknown };
    const ok = r.ok && !(Number(b?.code) < 0);
    return { status: ok ? "accepted" : "rejected", venueOrderId: ok && b?.orderId !== undefined ? String(b.orderId) : null, txHash: null, venueResponse: body, httpStatus: r.status };
  }
  const b = body as { code?: number; tx_hash?: string };
  if (r.ok && b?.code === 200) return typeof b.tx_hash === "string" && b.tx_hash ? { status: "accepted", venueOrderId: null, txHash: b.tx_hash, venueResponse: body, httpStatus: r.status } : { status: "unknown", venueOrderId: null, txHash: null, venueResponse: body, httpStatus: r.status };
  return { status: "rejected", venueOrderId: null, txHash: null, venueResponse: body, httpStatus: r.status };
}
