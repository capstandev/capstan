// The Aster VenueAdapter (spec 2). Reads are keyless market data; account state comes only from reads the user's own
// signer made (publicAccountReads false). Builds are signed client-side by the delegated key; the server never holds
// one. Execution is behind ASTER_EXECUTION (default off).
import type { MarketDataCache } from "@capstan/core";
import {
  CapstanError,
  Dec,
  type AccountSnapshot,
  type BuildContext,
  type DelegationState,
  type Hex,
  type Market,
  type OnboardingBundle,
  type OnboardingRequest,
  type OnboardingResult,
  type OnboardingStep,
  type Order,
  type SignedEnvelope,
  type SignedOnboarding,
  type SignedRead,
  type SubmitResult,
  type UnsignedVenuePayload,
  type VenueAdapter,
  type VenueIdentity,
  type VenueQuote,
  type VenueQuoteRequest,
} from "@capstan/schema";
import { AsterNonce, parseQuery } from "@capstan/signer-aster";
import type { VenueHttp } from "@capstan/venue-client";
import { asterCaps, type AsterConfig } from "./config";
import { symbolOf, type AsterMarket } from "./normalize";
import { buildOnboarding as buildAsterOnboarding, sendSignedSteps, submitOnboarding as submitAsterOnboarding, type StepResult } from "./onboarding";
import {
  ASTER_BASE_TAKER_BPS,
  buildAsterCancel,
  buildAsterCloseAll,
  buildAsterOrder,
  feeBpsOf,
  slippageBound,
  toReceiptDraft,
  walkBook,
  AsterNeedsSignedRead,
  type AsterBuildDeps,
  type AsterReceiptDraft,
  type BuildOptions,
} from "./orders";
import type { AsterReader } from "./read";
import { buildRevocation as buildAsterRevocation } from "./revocation";
import { ingestSignedRead, memoryAccountStore, type AccountSnapshotStore, type DelegationLookup } from "./signedread";
import { memorySubmitLedger, submitAster, type SubmitLedger } from "./submit";
import { verifyAsterSigned } from "./verify";

const MARKETS_TTL_MS = 600_000;
/** Slippage bound a market quote assumes (an order build uses the intent's own maxSlippageBps). */
export const QUOTE_MARKET_SLIPPAGE_BPS = 50;

export interface AsterAdapterDeps {
  http: VenueHttp;
  cache: MarketDataCache | null;
  reader: AsterReader;
  /** Ingested account snapshots (risk ingest writes, close-all reads). */
  accounts?: AccountSnapshotStore;
  delegations?: DelegationLookup;
  /** Onboarding bundles by id (the API stores them in onboarding_sessions). */
  bundles?: { get(id: string): Promise<OnboardingBundle | null>; put(b: OnboardingBundle): Promise<void> };
  /** CapstanEligibility v1 declaration step for an owner (todo 23). */
  eligibilityStep?: (owner: Hex) => Promise<OnboardingStep> | OnboardingStep;
  /** The agent_policy step for an agent-safe request (null without a policy); placed last in the bundle. */
  policyStep?: (req: OnboardingRequest) => Promise<OnboardingStep | null> | OnboardingStep | null;
  /** Delegation state from the delegations table (Aster agent reads are signed, so the server cannot ask Aster). */
  delegationState?: (id: VenueIdentity) => Promise<DelegationState | null>;
  /** Relay-mode IP for agent whitelists (RELAY_EGRESS_IP). */
  relayEgressIp?: string;
  ledger?: SubmitLedger;
  now?: () => number;
}

export interface AsterAdapter extends VenueAdapter {
  buildCloseAll(id: VenueIdentity, ctx: BuildContext & { snapshot: AccountSnapshot | null }): Promise<UnsignedVenuePayload[]>;
  submitRevocation(signed: SignedOnboarding, bundle?: OnboardingBundle): Promise<OnboardingResult & { steps: StepResult[] }>;
  toReceiptDraft(build: UnsignedVenuePayload, result: SubmitResult): AsterReceiptDraft;
  buildOrderWith(intent: Parameters<VenueAdapter["buildOrder"]>[0], ctx: BuildContext, opts: BuildOptions): Promise<UnsignedVenuePayload>;
}

export function createAdapter(cfg: AsterConfig & { builder: Hex; execution?: boolean }, deps: AsterAdapterDeps): AsterAdapter {
  const now = deps.now ?? Date.now;
  const caps = asterCaps(cfg.builder, { ...(cfg.execution !== undefined ? { execution: cfg.execution } : {}), network: cfg.network });
  const accounts = deps.accounts ?? memoryAccountStore(now);
  const ledger = deps.ledger ?? memorySubmitLedger();
  const nonces = new Map<string, AsterNonce>();
  const nonceFor = (a: Hex) => {
    const k = a.toLowerCase();
    let n = nonces.get(k);
    if (!n) nonces.set(k, (n = new AsterNonce()));
    return n;
  };
  let markets: { at: number; byId: Map<string, AsterMarket> } | null = null;
  async function market(id: string): Promise<Market> {
    if (!markets || now() - markets.at > MARKETS_TTL_MS || !markets.byId.has(id)) {
      const list = await deps.reader.listMarkets();
      markets = { at: now(), byId: new Map(list.map((m) => [m.id, m])) };
    }
    const m = markets.byId.get(id);
    if (!m) throw new CapstanError("NOT_FOUND", `unknown Aster market ${id}`);
    return m;
  }
  async function book(id: string, depth = 100) {
    return (await deps.cache?.getBook(id)) ?? deps.reader.getBook(id, depth);
  }
  const buildDeps: AsterBuildDeps = { network: cfg.network, builder: cfg.builder, market, book: (id) => book(id), nonceFor };
  const requireExecution = () => {
    if (!caps.execution) throw new CapstanError("MARKET_NOT_EXECUTABLE", "Aster execution is off (ASTER_EXECUTION)");
  };
  async function ingestClientRead(id: VenueIdentity, r: SignedRead) {
    if (!deps.delegations) throw new CapstanError("INTERNAL_ERROR", "no delegation lookup");
    return ingestSignedRead(
      { venue: "aster", mode: "relay", signedRead: { path: r.request.path, query: r.request.query, signature: r.signature as Hex, signer: r.signerRef as Hex, owner: id.owner, fetchedAtMs: r.issuedAt } },
      { network: cfg.network, delegations: deps.delegations, store: accounts, http: deps.http, marginAssetOf: (s) => markets?.byId.get(`aster:-:${s}`)?.collateralAsset ?? null, now },
    );
  }

  const adapter: AsterAdapter = {
    caps,
    listMarkets: () => deps.reader.listMarkets(),
    getBook: (id, depth) => deps.reader.getBook(id, depth),
    getFunding: (id) => deps.reader.getFunding(id),
    streamMarket: (ids, on) => deps.reader.streamMarket(ids, on),

    async getAccount(id, clientSignedRead) {
      if (clientSignedRead) return ingestClientRead(id, clientSignedRead);
      const s = await accounts.get(id.owner);
      if (!s) throw new AsterNeedsSignedRead();
      return s.snapshot;
    },

    async getOpenOrders(id, clientSignedRead): Promise<Order[]> {
      if (clientSignedRead) await ingestClientRead(id, clientSignedRead);
      const s = await accounts.get(id.owner);
      if (!s?.openOrders) throw new AsterNeedsSignedRead();
      return s.openOrders;
    },

    async quote(req: VenueQuoteRequest): Promise<VenueQuote> {
      const m = await market(req.marketId);
      const b = await book(req.marketId);
      const asOf = b.asOf;
      const base = { marketId: req.marketId, venue: "aster" as const, venueFeeBps: ASTER_BASE_TAKER_BPS, collateralAsset: m.collateralAsset, asOf, staleMs: Math.max(0, now() - Date.parse(asOf)), estLiqPx: null };
      if (m.status !== "active") return { ...base, status: "refused", refusal: { code: "MARKET_NOT_EXECUTABLE", reason: `market is ${m.status}` }, avgFillPx: "0", slippageBps: 0, builderFeeBps: 0, fundingCostBps: 0, totalCostBps: 0 };
      const ref = (req.side === "buy" ? b.asks : b.bids)[0]?.[0];
      if (!ref) return { ...base, status: "insufficient_depth", avgFillPx: "0", slippageBps: 0, builderFeeBps: 0, fundingCostBps: 0, totalCostBps: 0 };
      const size = req.sizeBase ?? (req.notionalUsd ? Dec.toString(Dec.roundToStep(Dec.div(Dec.parse(req.notionalUsd, 18), Dec.parse(ref, 18), 18), Dec.parse(m.lotSize, 18), "down")) : null);
      if (!size) throw new CapstanError("INVALID_INPUT", "give sizeBase or notionalUsd");
      // the same limit the build would use: the given limit, or the slippage bound for a market order (quote == execution)
      const limit = req.orderType === "limit" && req.limitPx ? req.limitPx : slippageBound(b, req.side, QUOTE_MARKET_SLIPPAGE_BPS, m.tickSize);
      const w = walkBook(b, req.side, size, limit);
      const fee = feeBpsOf("0.0002");
      const f = await deps.reader.getFunding(req.marketId).catch(() => null);
      const perHourBps = f ? Number(Dec.toString(Dec.mul(Dec.parse(f.ratePerHour, 18), Dec.parse("10000", 0), 6))) : 0;
      const fundingCostBps = Math.round((req.side === "buy" ? 1 : -1) * perHourBps * req.holdHours * 100) / 100;
      const slip = w.avgPx ? Math.abs((Number(w.avgPx) - Number(ref)) / Number(ref)) * 10_000 : 0;
      const slippageBps = Math.round(slip * 100) / 100;
      return {
        ...base,
        status: w.complete ? "ok" : "insufficient_depth",
        avgFillPx: w.avgPx ?? "0",
        slippageBps,
        builderFeeBps: fee,
        fundingCostBps,
        totalCostBps: Math.round((slippageBps + ASTER_BASE_TAKER_BPS + fee + fundingCostBps) * 100) / 100,
      };
    },

    async buildOnboarding(req: OnboardingRequest) {
      if (!deps.eligibilityStep) throw new CapstanError("INTERNAL_ERROR", "no eligibility step provider");
      if (!req.agentAddress) throw new CapstanError("INVALID_INPUT", "agentAddress is required", { field: "agentAddress" });
      const policyStep = deps.policyStep ? await deps.policyStep(req) : null;
      const maxFeeRate = req.builderMaxBps !== undefined ? Dec.toString(Dec.div(Dec.parse(String(req.builderMaxBps), 6, "down"), Dec.parse("10000", 0), 18)) : undefined;
      const b = buildAsterOnboarding(
        { owner: req.owner, agentAddress: req.agentAddress, mode: "relay", network: cfg.network, nowMs: now(), ...(maxFeeRate ? { maxFeeRate } : {}) },
        { relayEgressIp: deps.relayEgressIp ?? "", builder: cfg.builder, nonce: nonceFor(req.owner), eligibilityStep: await deps.eligibilityStep(req.owner), ...(policyStep ? { policyStep } : {}) },
      );
      await deps.bundles?.put(b);
      return b;
    },

    async submitOnboarding(signed) {
      const b = await deps.bundles?.get(signed.bundleId);
      if (!b) throw new CapstanError("NOT_FOUND", "unknown onboarding bundle");
      return submitAsterOnboarding(signed, deps.http, b, now());
    },

    async verifyOnboarding(id) {
      return (await deps.delegationState?.(id)) ?? { agentActive: false, builderMaxBps: null, routing: "fee_free_unavailable" };
    },

    async buildOrder(intent, ctx) {
      requireExecution();
      return buildAsterOrder(intent, ctx, buildDeps);
    },
    async buildOrderWith(intent, ctx, opts) {
      requireExecution();
      return buildAsterOrder(intent, ctx, buildDeps, opts);
    },
    async buildCancel(req, ctx) {
      requireExecution();
      return buildAsterCancel(req, ctx, buildDeps);
    },
    verifySigned: (env, build) => verifyAsterSigned(env, build, now()),

    async submit(env: SignedEnvelope) {
      requireExecution();
      // a cancel carries no order type; everything else is a new order
      const keys = typeof env.signedBody === "string" ? parseQuery(env.signedBody).map(([k]) => k) : [];
      return submitAster(env, deps.http, { ledger, method: keys.includes("type") ? "POST" : "DELETE" });
    },

    async buildRevocation(id) {
      if (!id.agentAddress) throw new CapstanError("INVALID_INPUT", "agentAddress is required", { field: "agentAddress" });
      const b = buildAsterRevocation(id.owner, id.agentAddress, { builder: cfg.builder, nonce: nonceFor(id.owner), network: cfg.network, nowMs: now() });
      await deps.bundles?.put(b);
      return b;
    },

    async buildCloseAll(id, ctx) {
      requireExecution();
      const snapshot = ctx.snapshot ?? (await accounts.get(id.owner))?.snapshot ?? null;
      return buildAsterCloseAll(id, { ...ctx, snapshot }, buildDeps);
    },

    async submitRevocation(signed, bundle) {
      const b = bundle ?? (await deps.bundles?.get(signed.bundleId));
      if (!b) throw new CapstanError("NOT_FOUND", "unknown revocation bundle");
      return submitRevocation(signed, deps.http, b, now());
    },

    toReceiptDraft,
  };
  return adapter;
}

/** DELETE /fapi/v3/agent then DELETE /fapi/v3/builder; each result reported on its own. */
export async function submitRevocation(signed: SignedOnboarding, http: VenueHttp, bundle: OnboardingBundle, nowMs = Date.now()): Promise<OnboardingResult & { steps: StepResult[] }> {
  const kinds = bundle.steps.map((s) => s.kind);
  if (kinds.join(",") !== "revoke_agent,revoke_builder") throw new CapstanError("INVALID_INPUT", "not a revocation bundle");
  const steps = await sendSignedSteps(bundle, signed, http, nowMs);
  const agent = steps.find((s) => s.kind === "revoke_agent");
  const builder = steps.find((s) => s.kind === "revoke_builder");
  const agentAddress = String((bundle.steps[0]!.typedData?.message as { AgentAddress?: string }).AgentAddress ?? "");
  return {
    agentRef: `aster:${bundle.owner.toLowerCase()}:${agentAddress.toLowerCase()}`,
    delegation: {
      agentActive: agent?.status !== "accepted",
      builderMaxBps: builder?.status === "accepted" ? null : 3,
      routing: builder?.status === "accepted" ? "fee_free_unavailable" : "ok",
    },
    venueResponses: steps.map((s) => ({ path: s.path, status: s.status, httpStatus: s.httpStatus, body: s.body })),
    steps,
  };
}
