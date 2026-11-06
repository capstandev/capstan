// The remaining eleven Capstan tools (spec 13.3) and the paid variant of capstan_risk. Paid tools (spread scan, risk on
// third-party addresses) are charged over MCP with x402 (server.ts wraps them); once paid, the MCP server calls the
// priced API route as an internal caller. Nothing here builds, signs or sends anything on its own.
import { ERROR_CODES } from "@capstan/schema";
import { z } from "zod";
import { capstan_risk, ownerReadZ, RISK_LINE } from "./core";
import { fromApi, type ToolDef } from "./types";

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Wallet address (0x...)");
const venue = z.enum(["hyperliquid", "lighter-mainnet", "lighter-rh", "aster", "variational", "arcus"]);
const asset = z.string().regex(/^(CR|EQ|ETF|IX|FX|CM|RT|VX|PI):[A-Za-z0-9._-]{1,32}$/).describe("Canonical asset, e.g. CR:BTC or EQ:TSLA");
const sig = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const requestSignature = z
  .object({ message: z.string().min(16).max(4000).describe("Base64 of the Capstan api_request message for this exact request"), signature: sig.describe("The owner's or its agent's signature of that message") })
  .strict()
  .describe("Your signature of this request (purpose api_request); made by your wallet or agent, never a key");
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export const REGION_TEXT = "Not available in your region." as const;

export const capstan_funding: ToolDef = {
  name: "capstan_funding",
  description: "Current funding for one asset on every venue, data-only venues included, each normalised per hour.",
  inputSchema: { asset },
  annotations: READ,
  async handler(input, { api, auth }) {
    return fromApi(await api.get("/funding", { asset: (input as { asset: string }).asset }, auth));
  },
};

export const capstan_onboarding_build: ToolDef = {
  name: "capstan_onboarding_build",
  description: "Build the onboarding steps for one venue. Your main wallet signs them; each step comes with a plain sentence saying what it does.",
  inputSchema: {
    venue,
    owner: addr,
    agentAddress: addr.optional().describe("Public address of the agent key your host made"),
    lighterPubKey: z.string().regex(/^0x[0-9a-fA-F]+$/).optional().describe("Public part of the Lighter key your host made"),
    builderMaxBps: z.number().min(0).max(10).optional(),
    policy: z.unknown().optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(input, { api, auth }) {
    return fromApi(await api.post("/onboarding/build", input, auth));
  },
};

export const capstan_cancel_build: ToolDef = {
  name: "capstan_cancel_build",
  description: "Build a cancel for one of your orders. Returns an unsigned payload; sign it locally with the Capstan SDK.",
  inputSchema: { owner: addr, agentRef: z.string().min(1).max(64), venueOrderId: z.string().min(1).max(80) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(input, { api, auth }) {
    return fromApi(await api.post("/orders/cancel/build", input, auth));
  },
};

export const capstan_spread_scan: ToolDef = {
  name: "capstan_spread_scan",
  description: `Funding spreads between approved equivalent markets, ranked by break-even hours. Paid per call with x402 ($0.02). ${RISK_LINE}`,
  inputSchema: { asset: asset.optional(), minBreakevenHours: z.number().min(0).max(8760).optional() },
  annotations: READ,
  priced: { usd: "0.02" },
  async handler(input, { api, auth }) {
    const i = input as { asset?: string; minBreakevenHours?: number };
    return fromApi(await api.get("/spreads/scan", { asset: i.asset, minHours: i.minBreakevenHours === undefined ? undefined : String(i.minBreakevenHours) }, auth));
  },
};

export const capstan_spread_plan: ToolDef = {
  name: "capstan_spread_plan",
  description: "Plan a funding spread on two venues. Returns the plan with its risk label; it must be acknowledged and runs only on your side, never on Capstan's servers.",
  inputSchema: {
    owner: addr,
    equivalenceId: z.string().min(1).max(64),
    sizeBase: decimal,
    leverage: z.number().min(1).max(100),
    hedgeFailurePolicy: z.enum(["leave_open", "flatten_leg_a", "retry_then_flatten"]),
    requestSignature: requestSignature.optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(input, { api, auth }) {
    const { requestSignature: rs, ...body } = input as Record<string, unknown> & { requestSignature?: { message: string; signature: string } };
    return fromApi(await api.post("/spreads/plan", body, { ...auth, ...(rs ? { ownerRead: rs } : {}) }));
  },
};

export const capstan_plan_status: ToolDef = {
  name: "capstan_plan_status",
  description: "Status of one of your spread plans and its events.",
  inputSchema: { planId: z.string().min(1).max(64), requestSignature: requestSignature.optional() },
  annotations: READ,
  async handler(input, { api, auth }) {
    const i = input as { planId: string; requestSignature?: { message: string; signature: string } };
    return fromApi(await api.get(`/spreads/${encodeURIComponent(i.planId)}`, {}, { ...auth, ...(i.requestSignature ? { ownerRead: i.requestSignature } : {}) }));
  },
};

export const capstan_set_policy: ToolDef = {
  name: "capstan_set_policy",
  description: "Store an agent policy your main wallet signed (limits per order, gross, leverage, markets, venues, orders per day). Orders under it go through the relay, which checks it.",
  inputSchema: { policy: z.record(z.string(), z.unknown()).describe("The CapstanAgentPolicy your wallet signed"), ownerSig: sig.describe("Your wallet's signature of that policy") },
  annotations: WRITE,
  async handler(input, { api, auth }) {
    return fromApi(await api.post("/agents/policy", input, auth));
  },
};

export const capstan_kill: ToolDef = {
  name: "capstan_kill",
  description: "Stop an agent on the Capstan relay at once. Returns the venue revocation steps for your wallet and, when asked, reduce-only close payloads. It cannot remove the key from the venue by itself.",
  inputSchema: {
    agentRef: z.string().min(1).max(128),
    sig,
    message: z.string().min(1).max(2000).describe("The signed kill message (purpose kill, body = agentRef)"),
    closeAll: z.boolean().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input, { api, auth }) {
    const { agentRef, ...body } = input as { agentRef: string; sig: string; message: string; closeAll?: boolean };
    return fromApi(await api.post(`/agents/${encodeURIComponent(agentRef)}/kill`, body, auth));
  },
};

export const capstan_get_receipt: ToolDef = {
  name: "capstan_get_receipt",
  description: "One signed receipt by id: what was routed, the builder fee charged and the hashes that prove it.",
  inputSchema: { receiptId: z.string().min(1).max(64) },
  annotations: READ,
  async handler(input, { api, auth }) {
    return fromApi(await api.get(`/receipts/${encodeURIComponent((input as { receiptId: string }).receiptId)}`, {}, auth));
  },
};

export const capstan_verify_receipt: ToolDef = {
  name: "capstan_verify_receipt",
  description: "Check a receipt: signature, leaf, Merkle proof and the root anchored on Robinhood Chain.",
  inputSchema: { receiptId: z.string().min(1).max(64).optional(), receipt: z.record(z.string(), z.unknown()).optional().describe("A receipt you hold; checked against the stored one") },
  annotations: READ,
  async handler(input, { api, auth }) {
    const i = input as { receiptId?: string; receipt?: { receiptId?: unknown } };
    const id = i.receiptId ?? (typeof i.receipt?.receiptId === "string" ? i.receipt.receiptId : undefined);
    if (!id) return fromApi({ status: 400, body: { error: { code: "INVALID_INPUT", message: "Give receiptId or receipt." } } });
    const v = await api.get(`/receipts/${encodeURIComponent(id)}/verify`, {}, auth);
    if (i.receipt && v.status < 400) {
      // a held receipt must be the stored one, byte for byte in canonical form
      const stored = await api.get(`/receipts/${encodeURIComponent(id)}`, {}, auth);
      const same = JSON.stringify(sortKeys(stored.body)) === JSON.stringify(sortKeys(i.receipt));
      if (!same) return fromApi({ status: 200, body: { ...(v.body as object), valid: false, held: "differs from the stored receipt" } });
    }
    return fromApi(v);
  },
};

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sortKeys((x as Record<string, unknown>)[k])]));
  return x;
}

export const capstan_eligibility: ToolDef = {
  name: "capstan_eligibility",
  description: "Whether routing on a venue is open to you from where you are.",
  inputSchema: { venue: venue.optional() },
  annotations: READ,
  async handler(input, { api, auth }) {
    const a = await api.get("/eligibility", { venue: (input as { venue?: string }).venue }, auth);
    if (a.status >= 400) return fromApi(a);
    const b = a.body as { allowed?: boolean; code?: string | null };
    const out = { allowed: b.allowed === true, code: b.code ?? null };
    // a region refusal says only that, never why or how
    const text = out.allowed ? "Available." : out.code === "GEO_REFUSED" || !out.code ? REGION_TEXT : (ERROR_CODES[out.code as keyof typeof ERROR_CODES]?.message ?? REGION_TEXT);
    return { content: [{ type: "text", text }], structuredContent: out };
  },
};

/** capstan_risk: the owner's own view is free with the read signature; third-party addresses are paid ($0.01). */
export const capstan_risk_v2: ToolDef = {
  ...capstan_risk,
  description: `Risk across venues, kept per venue: exposure, liquidation ladder and stress per asset. ${RISK_LINE} Your own: free with your wallet's read signature. Other addresses: paid per call with x402 ($0.01).`,
  inputSchema: {
    owner: addr.optional(),
    ownerRead: ownerReadZ.optional(),
    addresses: z.array(z.object({ venue, owner: addr, accountIndex: z.number().int().min(0).optional(), agentAddress: addr.optional(), apiKeyIndex: z.number().int().min(0).max(255).optional() }).strict()).min(1).max(20).optional(),
  },
  priced: { usd: "0.01" },
  async handler(input, ctx) {
    const i = input as { owner?: string; ownerRead?: { message: string; signature: string }; addresses?: unknown[] };
    if (i.addresses) return fromApi(await ctx.api.post("/risk/snapshot", { addresses: i.addresses }, ctx.auth));
    if (!i.owner || !i.ownerRead) return fromApi({ status: 400, body: { error: { code: "INVALID_INPUT", message: "Give owner with ownerRead, or addresses." } } });
    return capstan_risk.handler({ owner: i.owner, ownerRead: i.ownerRead }, ctx);
  },
};

/** Is this call paid? capstan_risk only for third-party addresses. */
export const isPaidCall = (t: ToolDef, args: unknown): boolean => (t.name === "capstan_risk" ? Array.isArray((args as { addresses?: unknown })?.addresses) : !!t.priced);
