// The Capstan MCP tools (spec 13.3). Descriptions are plain and short; the risk line is on quote and risk. No tool
// accepts a key: builds return unsigned payloads that the host signs locally with the Capstan SDK.
import { z } from "zod";
import { fromApi, type ToolDef } from "./types";

export const RISK_LINE = "Each venue liquidates independently. Legging risk is yours.";

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Wallet address (0x...)");
const venue = z.enum(["hyperliquid", "lighter-mainnet", "lighter-rh", "aster", "variational", "arcus"]);
const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const asset = z.string().regex(/^(CR|EQ|ETF|IX|FX|CM|RT|VX|PI):[A-Za-z0-9._-]{1,32}$/).describe("Canonical asset, e.g. CR:BTC or EQ:TSLA");
export const ownerReadZ = z
  .object({ message: z.string().min(16).max(4000).describe("Base64 of the Capstan read message for the exact path"), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).describe("The owner's wallet signature of that message") })
  .strict()
  .describe("The owner's read signature (purpose read) for this request; made by the owner's wallet, never a key");

const intent = z
  .object({
    marketId: z.string().min(3).max(120),
    side: z.enum(["buy", "sell"]),
    size: decimal,
    type: z.enum(["market", "limit"]),
    limitPx: decimal.optional(),
    tif: z.enum(["ioc", "gtc", "alo"]),
    reduceOnly: z.boolean(),
    leverage: z.number().min(1).max(100).optional(),
    clientOrderId: z.string().min(1).max(64).optional(),
    maxSlippageBps: z.number().int().min(0).max(5000),
  })
  .strict();

const signedEnvelope = z
  .object({
    buildId: z.string().min(1).max(64),
    venue,
    encoding: z.enum(["hl_l1_action", "lighter_tx", "aster_v3_params"]),
    signedBody: z.unknown().describe("The venue body exactly as signed on your host"),
    signature: z.string().min(2).max(2048),
    signerRef: z.string().min(1).max(128),
    payloadHash: z.string().regex(/^0x[0-9a-fA-F]*$/),
  })
  .strict();

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export const capstan_markets: ToolDef = {
  name: "capstan_markets",
  description: "List markets across venues, each with its own contract details and whether it can be traded through Capstan.",
  inputSchema: { venue: venue.optional(), asset: asset.optional(), executableOnly: z.boolean().optional() },
  annotations: READ,
  async handler(input, { api, auth }) {
    const i = input as { venue?: string; asset?: string; executableOnly?: boolean };
    return fromApi(await api.get("/markets", { venue: i.venue, asset: i.asset, executable: i.executableOnly === undefined ? undefined : String(i.executableOnly) }, auth));
  },
};

export const capstan_quote: ToolDef = {
  name: "capstan_quote",
  description: `Compare the all-in cost of one trade on every venue that lists the asset: fill price, fees, funding for the hold time. ${RISK_LINE}`,
  inputSchema: {
    canonicalAsset: asset.optional(),
    marketIds: z.array(z.string().min(3).max(120)).min(1).max(10).optional(),
    side: z.enum(["buy", "sell"]),
    sizeBase: decimal.optional(),
    notionalUsd: decimal.optional(),
    leverage: z.number().min(1).max(100),
    holdHours: z.number().min(0).max(8760),
    orderType: z.enum(["market", "limit"]),
    limitPx: decimal.optional(),
    owner: addr.optional(),
  },
  annotations: READ,
  async handler(input, { api, auth }) {
    return fromApi(await api.post("/quote", input, auth));
  },
};

export const capstan_build_order: ToolDef = {
  name: "capstan_build_order",
  description: "Build an order for one venue. Returns an unsigned payload; sign it locally with the Capstan SDK. Never send a key.",
  inputSchema: { owner: addr, agentRef: z.string().min(1).max(64), intent, mode: z.enum(["relay", "direct"]) },
  // builds sign nothing and change nothing at a venue
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(input, { api, auth }) {
    return fromApi(await api.post("/orders/build", input, auth));
  },
};

export const capstan_submit: ToolDef = {
  name: "capstan_submit",
  description: "Send an order you signed locally through the Capstan relay. Takes only the build id and the signed envelope; returns the order and its receipt id.",
  inputSchema: { buildId: z.string().min(1).max(64), signedEnvelope },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(input, { api, auth }) {
    return fromApi(await api.post("/orders/submit", input, auth));
  },
};

export const capstan_positions: ToolDef = {
  name: "capstan_positions",
  description: "Your open positions on each venue, each with that venue's own liquidation price. Needs your wallet's read signature.",
  inputSchema: { owner: addr, venues: z.array(venue).min(1).max(6).optional(), ownerRead: ownerReadZ },
  annotations: READ,
  async handler(input, { api, auth }) {
    const i = input as { owner: string; venues?: string[]; ownerRead: { message: string; signature: string } };
    return fromApi(await api.get("/positions", { owner: i.owner, venues: i.venues?.join(",") }, { ...auth, ownerRead: i.ownerRead }));
  },
};

export const capstan_risk: ToolDef = {
  name: "capstan_risk",
  description: `Your risk across venues, kept per venue: exposure, liquidation ladder and stress per asset. ${RISK_LINE} Needs your wallet's read signature.`,
  inputSchema: { owner: addr, ownerRead: ownerReadZ },
  annotations: READ,
  async handler(input, { api, auth }) {
    const i = input as { owner: string; ownerRead: { message: string; signature: string } };
    return fromApi(await api.get("/risk", { owner: i.owner }, { ...auth, ownerRead: i.ownerRead }));
  },
};

export const TOOLS_V1: ToolDef[] = [capstan_markets, capstan_quote, capstan_build_order, capstan_submit, capstan_positions, capstan_risk];
export type { ToolDef } from "./types";
