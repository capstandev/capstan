// The Lighter VenueAdapter for one config. Reads are keyless; builds return unsigned txs plus the pre-signature hash
// from a hash-only WASM instance; the delegated key signs in the SDK. Builds stay off unless LIGHTER_EXECUTION=1
// (fail closed until the testnet run in BACKLOG A3 proves the full path).
import type { MarketDataCache } from "@capstan/core";
import {
  CapstanError,
  Dec,
  type BuildContext,
  type CancelIntent,
  type DelegationState,
  type OnboardingBundle,
  type OnboardingRequest,
  type OnboardingResult,
  type OrderIntent,
  type SignedEnvelope,
  type SignedOnboarding,
  type SubmitResult,
  type UnsignedVenuePayload,
  type VenueAdapter,
  type VenueIdentity,
  type VenueQuote,
  type VenueQuoteRequest,
  type VerifyResult,
} from "@capstan/schema";
import type { Governor, VenueHttp } from "@capstan/venue-client";
import { lighterCaps, type LighterConfig } from "./config";
import { feeFor, tierFromName, type FeeSchedule } from "./fees";
import { NonceTracker } from "./nonce";
import { buildOnboarding, submitOnboarding, type SubmitOnboardingInput } from "./onboarding";
import { buildCancel, buildCloseAll, buildOrder, walkBook, type HashOnly, type LighterBuild } from "./orders";
import { createLighterReader, type LighterReader, type StreamFactory } from "./read";
import { buildRevocation } from "./revocation";
import { submit } from "./submit";
import { verifyOnboarding, verifySignedSync } from "./verify";

export interface LighterAdapterDeps {
  http: VenueHttp;
  cache: MarketDataCache | null;
  gov?: Governor;
  /** Hash-only signer instance; made lazily with createLighterHasher on first build. */
  hasher?: HashOnly;
  /** Capstan's integrator account index on this exchange (null until it exists, BACKLOG). */
  integratorAccountIndex?: number | null;
  execution?: boolean;
  now?: () => number;
  stream?: StreamFactory;
  /** Where bundles wait between build and submit (the API persists them in onboarding_sessions). */
  bundles?: Map<string, OnboardingBundle>;
}

export interface LighterAdapter extends VenueAdapter {
  readonly reader: LighterReader;
  readonly nonces: NonceTracker;
  buildCloseAll(id: VenueIdentity, ctx: BuildContext): Promise<LighterBuild[]>;
  close(): void;
}

export function createLighterAdapter(cfg: Readonly<LighterConfig>, deps: LighterAdapterDeps): LighterAdapter {
  const now = deps.now ?? (() => Date.now());
  const reader = createLighterReader(cfg, deps.http, deps.cache, { now, ...(deps.stream ? { stream: deps.stream } : {}) });
  const caps = lighterCaps(cfg, deps.execution === undefined ? {} : { execution: deps.execution });
  const nonces = new NonceTracker(reader, now);
  const bundles = deps.bundles ?? new Map<string, OnboardingBundle>();
  const integrator = deps.integratorAccountIndex ?? null;
  let hasher: HashOnly | null = deps.hasher ?? null;
  let closeHasher: (() => void) | null = null;
  let schedule: { at: number; s: FeeSchedule } | null = null;

  async function getHasher(): Promise<HashOnly> {
    if (hasher) return hasher;
    const { createLighterHasher } = await import("@capstan/signer-lighter-wasm");
    const h = await createLighterHasher(cfg.signingChainId);
    hasher = h;
    closeHasher = () => h.close();
    return h;
  }
  async function fees(): Promise<FeeSchedule> {
    if (schedule && now() - schedule.at < 3600_000) return schedule.s;
    const s = await reader.feeSchedule();
    schedule = { at: now(), s };
    return s;
  }
  const requireExecution = () => {
    if (!caps.execution) throw new CapstanError("MARKET_NOT_EXECUTABLE", `${cfg.venue} builds are off (LIGHTER_EXECUTION=1 turns them on)`);
  };
  const ensureSeeded = async (id: VenueIdentity) => {
    if (id.accountIndex === undefined || id.apiKeyIndex === undefined) throw new CapstanError("INVALID_INPUT", "a Lighter identity needs accountIndex and apiKeyIndex");
    if (!nonces.seeded(id.accountIndex, id.apiKeyIndex)) await nonces.seed(id.accountIndex, id.apiKeyIndex);
    return { a: id.accountIndex, k: id.apiKeyIndex };
  };

  const adapter: LighterAdapter = {
    caps,
    reader,
    nonces,
    listMarkets: () => reader.listMarkets(),
    getBook: (id, depth) => reader.getBook(id, depth),
    getFunding: async (id) => (await deps.cache?.getFunding(id)) ?? reader.getFunding(id),
    getAccount: (id) => reader.getAccount(id),
    getOpenOrders: (id) => reader.getOpenOrders(id),
    streamMarket: (ids, onEvent) => reader.streamMarket(ids, onEvent),

    async quote(req: VenueQuoteRequest): Promise<VenueQuote> {
      const m = await reader.marketMeta(req.marketId);
      const book = await reader.getBook(req.marketId, 50);
      const fee = feeFor(await fees(), tierFromName(req.feeTier));
      const size = req.sizeBase ?? (req.notionalUsd && m.markPx ? Dec.toString(Dec.div(Dec.parse(req.notionalUsd, 12, "half_even"), Dec.parse(m.markPx, 12, "half_even"), m.sizeDecimals, "down")) : null);
      if (!size) throw new CapstanError("INVALID_INPUT", "quote needs sizeBase or notionalUsd");
      const w = walkBook(book, req.side, size, req.orderType === "limit" && req.limitPx ? req.limitPx : null);
      const best = req.side === "buy" ? book.asks[0]?.[0] : book.bids[0]?.[0];
      const filledAll = Dec.cmp(w.filled, Dec.parse(size, 12, "down")) >= 0;
      const slippageBps = w.avg && best ? Math.abs(Number(Dec.toString(Dec.div(Dec.mul(Dec.sub(w.avg, Dec.parse(best, 12, "half_even")), Dec.parse("10000", 0), 12), Dec.parse(best, 12, "half_even"), 4, "half_even")))) : 0;
      let fundingCostBps = 0;
      try {
        const f = await adapter.getFunding(req.marketId);
        fundingCostBps = Number(f.ratePerHour) * req.holdHours * 10_000 * (req.side === "buy" ? 1 : -1);
      } catch {
        fundingCostBps = 0;
      }
      const venueFeeBps = req.orderType === "limit" ? fee.makerBps : fee.takerBps;
      return {
        marketId: req.marketId,
        venue: cfg.venue,
        status: !m.market.executable && m.market.marketType !== "perp" ? "data_only" : filledAll ? "ok" : "insufficient_depth",
        avgFillPx: w.avg ? Dec.toString(w.avg) : "0",
        slippageBps,
        venueFeeBps,
        builderFeeBps: 0,
        fundingCostBps,
        totalCostBps: venueFeeBps + slippageBps + fundingCostBps,
        estLiqPx: null,
        collateralAsset: cfg.collateral,
        asOf: book.asOf,
        staleMs: Math.max(0, now() - new Date(book.asOf).getTime()),
      };
    },

    async buildOnboarding(req: OnboardingRequest): Promise<OnboardingBundle> {
      if (req.venue !== cfg.venue) throw new CapstanError("INVALID_INPUT", `onboarding for ${req.venue} cannot be built on ${cfg.venue}`);
      if (!req.lighterPubKey) throw new CapstanError("INVALID_INPUT", "lighterPubKey (made by the SDK) is required");
      const b = await buildOnboarding({ owner: req.owner, lighterPubKey: req.lighterPubKey, config: cfg }, { reader, integratorAccountIndex: integrator, nowMs: now() });
      bundles.set(b.bundleId, b);
      return b;
    },
    async submitOnboarding(signed: SignedOnboarding): Promise<OnboardingResult> {
      const bundle = bundles.get(signed.bundleId);
      if (!bundle) throw new CapstanError("NOT_FOUND", "unknown or expired onboarding bundle");
      const r = await submitOnboarding(signed as SubmitOnboardingInput, deps.http, { bundle, cfg, nowMs: now(), ...(deps.gov ? { gov: deps.gov } : {}) });
      bundles.delete(signed.bundleId);
      return r;
    },
    async verifyOnboarding(id: VenueIdentity): Promise<DelegationState> {
      const pubKey = (id as VenueIdentity & { pubKey?: string }).pubKey;
      if (!pubKey) throw new CapstanError("INVALID_INPUT", "verifyOnboarding needs the registered public key");
      return verifyOnboarding(reader, { ...id, pubKey });
    },

    async buildOrder(intent: OrderIntent, ctx: BuildContext): Promise<UnsignedVenuePayload> {
      requireExecution();
      const { a, k } = await ensureSeeded(ctx.identity);
      const market = await reader.marketMeta(intent.marketId);
      const book = await reader.getBook(intent.marketId, 50).catch(() => null);
      const fee = feeFor(await fees(), null);
      return buildOrder(intent, { ...ctx, cfg, market, book, fee, hasher: await getHasher(), integratorAccountIndex: integrator ?? 0, nonce: nonces.next(a, k), clientOrderIndex: nonces.nextClientOrderIndex(a, k) });
    },
    async buildCancel(req: CancelIntent, ctx: BuildContext): Promise<UnsignedVenuePayload> {
      requireExecution();
      const { a, k } = await ensureSeeded(ctx.identity);
      return buildCancel(req, { ...ctx, cfg, market: await reader.marketMeta(req.marketId), hasher: await getHasher(), nonce: nonces.next(a, k) });
    },
    async buildCloseAll(id: VenueIdentity, ctx: BuildContext): Promise<LighterBuild[]> {
      requireExecution();
      return buildCloseAll(id, { ...ctx, cfg, reader, nonces, hasher: await getHasher(), fee: feeFor(await fees(), null), integratorAccountIndex: integrator ?? 0 });
    },
    verifySigned(env: SignedEnvelope, build: UnsignedVenuePayload): VerifyResult {
      return verifySignedSync(env, build as LighterBuild, now());
    },
    submit(env: SignedEnvelope): Promise<SubmitResult> {
      requireExecution();
      return submit(env, { http: deps.http, cfg, ...(deps.gov ? { gov: deps.gov } : {}) });
    },
    async buildRevocation(id: VenueIdentity): Promise<OnboardingBundle> {
      const replacementPubKey = (id as VenueIdentity & { replacementPubKey?: string }).replacementPubKey;
      if (!replacementPubKey) throw new CapstanError("INVALID_INPUT", "revocation needs the replacement public key the owner's SDK made");
      const b = await buildRevocation(id, { cfg, reader, replacementPubKey, nowMs: now(), integratorAccountIndex: integrator });
      bundles.set(b.bundleId, b);
      return b;
    },
    close() {
      closeHasher?.();
    },
  };
  return adapter;
}

