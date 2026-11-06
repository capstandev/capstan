// createAdapter: the Hyperliquid VenueAdapter (spec 2). Composition (apps/api/src/adapters.ts, surfaces lane) passes
// the governed VenueHttp, the shared market-data cache, the reader, the eligibility declaration step (todo 23), the
// onboarding-session lookup and, for HIP-3, the hook from ./hip3 (todo 08).
import type { MarketDataCache } from "@capstan/core";
import { CapstanError, type CancelIntent, type Hex, type OnboardingBundle, type OnboardingRequest, type OrderIntent, type SignedEnvelope, type SignedOnboarding, type VenueAdapter, type VenueIdentity, type VenueQuote, type VenueQuoteRequest, type BuildContext } from "@capstan/schema";
import { toHex } from "@capstan/signer-hl";
import type { VenueHttp } from "@capstan/venue-client";
import { hlCaps } from "./caps";
import { buildOnboarding, capstanAgentName, DEFAULT_SIGNATURE_CHAIN_ID, HL_BUILDER_MAX_BPS, submitOnboarding, verifyOnboarding, type HlOnboardingContext } from "./onboarding";
import { buildCancel, buildCloseAll, buildOrder, NonceSource, ownerFees, type AgentState, type HlBuildContext, type HlBuildDeps, type HlUnsignedPayload, type Hip3Hook } from "./orders";
import { HL_BASE_FEES, quote as quoteBook, type HlFeeTier } from "./quote";
import type { HlConfig, HlReader } from "./read";
import { buildRevocation } from "./revocation";
import { submit as submitEnvelope, toReceiptDraft } from "./submit";
import { verifySigned as verifyEnvelope } from "./verify";

export interface HlAdapterDeps {
  http: VenueHttp;
  cache: MarketDataCache;
  reader: HlReader;
  nonces?: NonceSource;
  now?: () => number;
  enabled?: () => boolean;
  isExecutable?: (marketId: string) => boolean | Promise<boolean>;
  hip3?: Hip3Hook & { quoteFees?(marketId: string): Promise<{ builderOn: boolean; feeTier: HlFeeTier }> };
  onboarding?: Pick<HlOnboardingContext, "declarationStep" | "policyStep" | "agentSeenBefore"> & { signatureChainId?: Hex };
  /** onboarding_sessions lookup for submitOnboarding. */
  bundles?: { get(bundleId: string): Promise<OnboardingBundle | null> | OnboardingBundle | null };
  /** Current delegation state by agent address, read synchronously by verifySigned (the relay keeps it in memory). */
  agentState?: (agentAddress: Hex) => AgentState;
}

export type HlAdapter = VenueAdapter & {
  buildCloseAll(id: VenueIdentity, ctx: BuildContext): Promise<HlUnsignedPayload[]>;
  toReceiptDraft: typeof toReceiptDraft;
  reader: HlReader;
};

export function createAdapter(cfg: HlConfig & { builderAddress: Hex }, deps: HlAdapterDeps): HlAdapter {
  const now = deps.now ?? Date.now;
  const builder = cfg.builderAddress.toLowerCase() as Hex;
  const nonces = deps.nonces ?? new NonceSource();
  const bd: HlBuildDeps = { cfg: { ...cfg, builderAddress: builder }, reader: deps.reader, cache: deps.cache, nonces, now, enabled: deps.enabled, isExecutable: deps.isExecutable, hip3: deps.hip3 };
  const r = deps.reader;

  async function quote(req: VenueQuoteRequest): Promise<VenueQuote> {
    const m = await r.instrument(req.marketId);
    const book = (await deps.cache.getBook(m.id)) ?? (await r.getBook(m.id));
    let fees: HlFeeTier = HL_BASE_FEES;
    let builderOn = true;
    if (m.dex !== null) {
      if (!deps.hip3?.quoteFees) return { ...quoteBook({ ...req, collateralAsset: m.collateralAsset, maxLeverage: m.maxLeverage, nowMs: now() }, book, fees, null), status: "refused", refusal: { code: "MARKET_NOT_EXECUTABLE", reason: "HIP-3 quotes need the HIP-3 fee model" } };
      ({ feeTier: fees, builderOn } = await deps.hip3.quoteFees(m.id));
    } else if (req.owner) fees = await ownerFees(r, req.owner, now());
    const funding = (await deps.cache.getFunding(m.id)) ?? (await r.getFunding(m.id).catch(() => null));
    const { limitPx: _l, filledSize: _f, ...q } = quoteBook({ ...req, builderTenthsBp: builderOn ? 20 : 0, collateralAsset: m.collateralAsset, maxLeverage: m.maxLeverage, nowMs: now() }, book, fees, funding);
    return q;
  }

  const adapter: HlAdapter = {
    caps: hlCaps(builder),
    reader: r,
    listMarkets: () => r.listMarkets(),
    async getBook(id, depth) {
      const c = await deps.cache.getBook(id);
      return c ? { ...c, bids: depth ? c.bids.slice(0, depth) : c.bids, asks: depth ? c.asks.slice(0, depth) : c.asks } : r.getBook(id, depth);
    },
    async getFunding(id) {
      return (await deps.cache.getFunding(id)) ?? r.getFunding(id);
    },
    getAccount: (id) => r.getAccount(id),
    getOpenOrders: (id) => r.getOpenOrders(id),
    streamMarket: (ids, on) => r.streamMarket(ids, on),
    quote,
    async buildOnboarding(req: OnboardingRequest) {
      if (!deps.onboarding?.declarationStep) throw new CapstanError("INTERNAL_ERROR", "the eligibility declaration step is not wired");
      if (!req.agentAddress) throw new CapstanError("INVALID_INPUT", "agentAddress is required");
      return buildOnboarding(
        { ...req, agentAddress: req.agentAddress, builderMaxBps: req.builderMaxBps ?? HL_BUILDER_MAX_BPS, network: cfg.network, signatureChainId: deps.onboarding.signatureChainId ?? DEFAULT_SIGNATURE_CHAIN_ID },
        { reader: r, builder, nowMs: now(), declarationStep: deps.onboarding.declarationStep, policyStep: deps.onboarding.policyStep, agentSeenBefore: deps.onboarding.agentSeenBefore },
      );
    },
    async submitOnboarding(signed: SignedOnboarding) {
      const bundle = await deps.bundles?.get(signed.bundleId);
      if (!bundle) throw new CapstanError("NOT_FOUND", "unknown onboarding bundle");
      return submitOnboarding(signed, deps.http, { bundle, nowMs: now() });
    },
    verifyOnboarding: (id) => verifyOnboarding(r, id, builder, now()),
    buildOrder: (intent: OrderIntent, ctx: BuildContext) => buildOrder(intent, ctx as HlBuildContext, bd),
    buildCancel: (req: CancelIntent, ctx: BuildContext) => buildCancel(req, ctx as HlBuildContext, bd),
    buildCloseAll: (id, ctx) => buildCloseAll(id, ctx as HlBuildContext, bd),
    verifySigned(env: SignedEnvelope, build) {
      const b = build as HlUnsignedPayload;
      const state = b.meta?.agentAddress && deps.agentState ? deps.agentState(b.meta.agentAddress) : undefined;
      return verifyEnvelope(env, b, { nowMs: now(), agentState: state });
    },
    submit: (env) => submitEnvelope(env, deps.http),
    async buildRevocation(id: VenueIdentity) {
      if (!id.agentAddress) throw new CapstanError("INVALID_INPUT", "the agent address is required");
      // the replacement only needs to be an address nobody signs with; no key is made for it
      const throwaway = toHex(crypto.getRandomValues(new Uint8Array(20)));
      return buildRevocation({ ...id, agentName: capstanAgentName(id.agentAddress) }, { network: cfg.network, signatureChainId: deps.onboarding?.signatureChainId ?? DEFAULT_SIGNATURE_CHAIN_ID, nowMs: now(), throwawayAgent: throwaway, builder });
    },
    toReceiptDraft,
  };
  return adapter;
}
