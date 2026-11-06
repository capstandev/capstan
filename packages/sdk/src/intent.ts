// The order a payload says it is, read from the payload itself. Used where the user gave no intent of their own
// (close-all, an MCP host signing a build): the full check then still enforces pins, fees, account, digest and
// policy; only "is this what the user asked for" needs a real intent.
import type { OrderIntent, UnsignedVenuePayload } from "@capstan/schema";
import type { HlOrderAction } from "@capstan/signer-hl";
import { fromUnits } from "./dec";
import { SdkError } from "./errors";
import type { VenueMarketSpec } from "./markets";

const HL_TIF: Record<string, OrderIntent["tif"]> = { Ioc: "ioc", Gtc: "gtc", Alo: "alo" };
const ASTER_TIF: Record<string, OrderIntent["tif"]> = { IOC: "ioc", GTC: "gtc", GTX: "alo" };

export function intentFromPayload(b: UnsignedVenuePayload, spec?: VenueMarketSpec, opts: { maxSlippageBps?: number } = {}): OrderIntent {
  const slip = opts.maxSlippageBps ?? 0;
  const marketId = b.preview?.marketId;
  if (typeof marketId !== "string") throw new SdkError("PAYLOAD_MISMATCH", "the build names no market", { field: "market" });
  if (b.encoding === "hl_l1_action") {
    const a = (b.payload as { action: HlOrderAction }).action;
    const o = a?.orders?.[0];
    if (a?.type !== "order" || !o) throw new SdkError("PAYLOAD_MISMATCH", "not an order", { field: "type" });
    const tif = HL_TIF[(o.t as { limit?: { tif?: string } }).limit?.tif ?? ""];
    if (!tif) throw new SdkError("PAYLOAD_MISMATCH", "unknown tif", { field: "tif" });
    return { marketId, side: o.b ? "buy" : "sell", size: o.s, type: "limit", limitPx: o.p, tif, reduceOnly: o.r, maxSlippageBps: slip, ...(o.c ? { clientOrderId: o.c } : {}) };
  }
  if (b.encoding === "aster_v3_params") {
    const m = new Map((b.payload as { params: [string, unknown][] }).params.map(([k, v]) => [k, String(v)]));
    const tif = ASTER_TIF[m.get("timeInForce") ?? ""];
    if (!tif) throw new SdkError("PAYLOAD_MISMATCH", "unknown tif", { field: "tif" });
    return { marketId, side: m.get("side") === "BUY" ? "buy" : "sell", size: m.get("quantity") ?? "", type: "limit", limitPx: m.get("price") ?? "", tif, reduceOnly: m.get("reduceOnly") === "true", maxSlippageBps: slip, ...(m.get("newClientOrderId") ? { clientOrderId: m.get("newClientOrderId")! } : {}) };
  }
  if (b.encoding === "lighter_tx") {
    if (!spec || (spec.venue !== "lighter-mainnet" && spec.venue !== "lighter-rh")) throw new SdkError("PAYLOAD_MISMATCH", "no market spec", { field: "market" });
    const a = (b.payload as { txType: number; args: Record<string, number | boolean> }).args;
    if ((b.payload as { txType: number }).txType !== 14) throw new SdkError("PAYLOAD_MISMATCH", "not an order", { field: "txType" });
    const tif: OrderIntent["tif"] = a.timeInForce === 0 ? "ioc" : a.timeInForce === 2 ? "alo" : "gtc";
    const px = fromUnits(a.price as number, spec.priceDecimals);
    const base = { marketId, side: (a.isAsk ? "sell" : "buy") as OrderIntent["side"], size: fromUnits(a.baseAmount as number, spec.sizeDecimals), tif, reduceOnly: a.reduceOnly as boolean, maxSlippageBps: slip, clientOrderId: String(a.clientOrderIndex) };
    return a.orderType === 1 ? { ...base, type: "market" } : { ...base, type: "limit", limitPx: px };
  }
  throw new SdkError("UNSUPPORTED", "unknown encoding", { field: "encoding" });
}
