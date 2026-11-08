// Spread plans on the client (spec 7.5): funding-rate spread trades (at-risk). Legging risk is yours. The SDK fetches
// an acknowledged plan, runs the executor here (where the keys are), builds and signs each leg with the local agent
// key through the normal payload checks, applies the agent-safe policy before each build, and posts every step to
// POST /v1/spreads/{id}/events. The server never executes a plan.
import { Dec, type Hex, type OrderIntent, type SignedEnvelope, type SpreadPlan, type SubmitResult, type UnsignedVenuePayload, type VenueId } from "@capstan/schema";
import { execute, type ExecuteResult, type ExecutorEvent, type ExecutorPorts } from "@capstan/spreads/src/executor";
import type { Api } from "./api";
import type { CapstanClient, CheckedBuild, Mode } from "./client";
import { capstanMessage } from "./signed-message";

export { execute as executeSpread, type ExecuteResult, type ExecutorEvent, type ExecutorPorts };

export const SPREAD_ACK_TEXT = (planId: string) => `I acknowledge spread plan ${planId}. At-risk. Legging risk is yours.`;

/** The text an owner or agent signs to acknowledge a plan (purpose spread_ack, body = the ack sentence). */
export function spreadAckMessage(o: { planId: string; owner: `0x${string}`; host: string; chainId: number; nonce: string; issuedAt: number; ttlMs?: number }): string {
  return capstanMessage({ purpose: "spread_ack", owner: o.owner, host: o.host, chainId: o.chainId, nonce: o.nonce, issuedAt: o.issuedAt, expiresAt: o.issuedAt + (o.ttlMs ?? 15 * 60_000), body: SPREAD_ACK_TEXT(o.planId) });
}

export interface SpreadPortOptions {
  mode?: Mode;
  /** Fill of an order this client sent (the venue read the SDK already uses for that venue). */
  fillOf(venue: VenueId, venueOrderId: string): Promise<{ filled: string; avgPx: string | null; done: boolean }>;
  /** False for a venue whose fills fillOf cannot read: the executor then refuses the plan before sending anything. */
  canReadFill?: ExecutorPorts["canReadFill"];
  checkPolicy?: ExecutorPorts["checkPolicy"];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Executor ports over a CapstanClient: build through the checked build path, submit through signAndSubmit. */
export function clientSpreadPorts(client: Pick<CapstanClient, "buildOrder" | "signAndSubmit" | "signer">, api: Pick<Api, "post">, planId: string, o: SpreadPortOptions): ExecutorPorts {
  const checked = new Map<string, CheckedBuild>();
  return {
    async build(intent: OrderIntent, venue: VenueId): Promise<UnsignedVenuePayload> {
      const cb = await client.buildOrder(intent, venue, o.mode ?? "relay");
      checked.set(cb.build.buildId, cb);
      return cb.build;
    },
    sign: (p: UnsignedVenuePayload): Promise<SignedEnvelope> => client.signer.sign(p),
    async submit(env: SignedEnvelope): Promise<SubmitResult> {
      const cb = checked.get(env.buildId);
      if (!cb) throw new Error("spread executor: unknown build");
      const r = await client.signAndSubmit(cb);
      return { status: r.order.status === "rejected" ? "rejected" : "accepted", venueOrderId: r.order.venueOrderId || null, txHash: null, venueResponse: { receiptId: r.receiptId } };
    },
    fillOf: (v, id) => o.fillOf(v, id),
    post: async (ev: ExecutorEvent) => void (await api.post(`/spreads/${encodeURIComponent(planId)}/events`, ev)),
    now: o.now ?? Date.now,
    sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    ...(o.checkPolicy ? { checkPolicy: o.checkPolicy } : {}),
    ...(o.canReadFill ? { canReadFill: o.canReadFill } : {}),
  };
}

/** Venues whose order fills a browser or SDK host can read without a signed account read. */
export const FILL_READABLE_VENUES: readonly VenueId[] = ["hyperliquid"];
/**
 * Hyperliquid order statuses that are final: the order can no longer fill. "open" and "triggered" (a trigger order that
 * is now resting) are not, and any status not listed here reads as not final.
 */
const HL_FINAL = /^(filled|canceled|rejected|scheduledCancel|[a-zA-Z]+Canceled|[a-zA-Z]+Rejected)$/;
const DEC = /^\d+(\.\d+)?$/;

/**
 * The fill port the dashboard and SDK hosts use (R1-8-01). Hyperliquid fills are public (orderStatus by the master
 * address and oid). Any other venue, an order Hyperliquid does not know yet (unknownOid), a bad answer or a status
 * that is not final reads as "not confirmed" (done false), never as a confirmed no-fill. avgPx stays null: orderStatus
 * gives the limit price, not the average fill price.
 */
export function venueFillReader(o: { owner: Hex; fetch?: typeof fetch; hyperliquidHost?: string }): Pick<SpreadPortOptions, "fillOf" | "canReadFill"> {
  const f = o.fetch ?? fetch;
  const hl = (o.hyperliquidHost ?? "https://api.hyperliquid.xyz").replace(/\/$/, "");
  const unknown = { filled: "0", avgPx: null, done: false };
  return {
    canReadFill: (v) => FILL_READABLE_VENUES.includes(v),
    async fillOf(venue, venueOrderId) {
      if (venue !== "hyperliquid" || !/^\d{1,15}$/.test(venueOrderId)) return unknown;
      const res = await f(`${hl}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "orderStatus", user: o.owner.toLowerCase(), oid: Number(venueOrderId) }) });
      if (!res.ok) return unknown;
      const j = (await res.json().catch(() => null)) as { status?: unknown; order?: { order?: { sz?: unknown; origSz?: unknown }; status?: unknown } } | null;
      const ord = j?.order?.order;
      const status = j?.order?.status;
      if (j?.status !== "order" || typeof status !== "string" || typeof ord?.origSz !== "string" || typeof ord.sz !== "string" || !DEC.test(ord.origSz) || !DEC.test(ord.sz)) return unknown;
      const filled = Dec.sub(Dec.parse(ord.origSz, 18), Dec.parse(ord.sz, 18));
      if (Dec.cmp(filled, Dec.parse("0", 18)) < 0) return unknown;
      return { filled: Dec.toString(filled), avgPx: null, done: HL_FINAL.test(status) };
    },
  };
}

/** Fetch an acknowledged plan and run it here. */
export async function executeSpreadPlan(planId: string, client: Pick<CapstanClient, "buildOrder" | "signAndSubmit" | "signer">, api: Pick<Api, "get" | "post">, o: SpreadPortOptions): Promise<ExecuteResult> {
  const { plan } = await api.get<{ plan: SpreadPlan }>(`/spreads/${encodeURIComponent(planId)}`);
  return execute(plan, clientSpreadPorts(client, api, planId, o));
}
