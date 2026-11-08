// createClient: the SDK surface (spec 7, 13.1). Keys are made and used only here, on the user's side. Every server
// build is checked against the intent and the pins before the local key signs; every onboarding bundle is checked
// before the first wallet prompt. Agent-safe policy forces relay mode.
import type { AgentPolicy, CancelIntent, CanonicalAsset, DelegationState, FundingSnapshot, Hex, Market, OnboardingBundle, Order, OrderIntent, QuoteRequest, Receipt, RouteQuote, SignedEnvelope, UnsignedVenuePayload, VenueCapabilities, VenueId } from "@capstan/schema";
import { digestTrade, queryString, type Param } from "@capstan/signer-aster";
import type { LighterChainId } from "@capstan/signer-lighter-wasm";
import { createApi, type Api, type RequestAuth } from "./api";
import { eqAddr, toHex } from "./bytes";
import { checkBuild, checkCancelBuild, type CheckContext } from "./check";
import { postDirect, type DirectResult } from "./direct";
import { SdkError } from "./errors";
import { intentFromPayload } from "./intent";
import type { KeyStore } from "./keys/types";
import { personalDigest } from "./keys/secp";
import { defaultVenueHosts, publicVenueMarkets, type MarketSource, type VenueMarketSpec } from "./markets";
import { checkOnboardingBundle } from "./onboard";
import { resolvePresenter, type StepPresenter } from "./present";
import { assertServerMatchesPins, mergePins, PINS, type Network, type NetworkPins, type Pins, type PinsOverride } from "./pins";
import { sumDec, type PolicyChecker } from "./policy";
import { rpcAnchorReader, verifyReceiptOffline, type AnchorReader, type ReceiptProof, type VerifyChecks } from "./receipts";
import { capstanMessage } from "./signed-message";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { signEnvelope } from "./sign";
import type { WalletSigner } from "./wallet";
import { payingFetch, sdkSpendControls, type SpendControls, type X402Payer } from "./x402";
import { CHAINS } from "@capstan/schema";

export type Mode = "relay" | "direct";

export interface CapstanClientOptions {
  apiBase: string;
  network: Network;
  keystore: KeyStore;
  walletSigner?: WalletSigner;
  x402?: { payer: X402Payer; maxUsdPerCall: string; controls?: SpendControls };
  pinned?: PinsOverride;
  /** HTTP for the Capstan API (tests point it at a local stack). Default global fetch. */
  fetch?: typeof fetch;
  /** HTTP for direct venue posts and venue reads. Default global fetch. */
  venueFetch?: typeof fetch;
  venueHosts?: Partial<Record<VenueId, string>>;
  markets?: MarketSource;
  anchor?: AnchorReader | { rpcUrl: string; address?: Hex };
  policyChecker?: PolicyChecker;
  /**
   * A Capstan API key (Authorization: Bearer). Sent on every API call when set. Without one, onboarding calls use an
   * anonymous key the client makes once (see anonymousApiKey), because no wallet prompt may come before the bundle
   * check; every agent-scoped call is owner-signed by the agent key (owner_sig, no wallet prompt).
   */
  apiKey?: string;
  /** Make an anonymous API key (POST /v1/account/keys, owner null, no signature) when one is needed (default true). */
  anonymousApiKey?: boolean;
  /** Compare /v1/venues with the pins once before the first build or onboarding (default true). */
  checkServerPins?: boolean;
  /** Slippage allowed on close-all and amend builds read from the payload (default 300 bps). */
  closeAllSlippageBps?: number;
  /**
   * Shows the SDK's plain-English steps before the first wallet prompt of an onboarding (default on). Order: this
   * option, then walletSigner.confirm, then the default (the page's confirm dialog in a browser, stderr elsewhere).
   * Pass false to turn it off; that is the only way to skip it.
   */
  presentSteps?: StepPresenter | false;
  now?: () => number;
}

export interface AgentRecord {
  agentRef: string;
  venue: VenueId;
  owner: Hex;
  keyRef: string;
  publicPart: string;
  mode: Mode;
  accountIndex?: number;
  apiKeyIndex?: number;
  approvedMaxBps: number | null;
  policy?: AgentPolicy;
  policyId?: string;
  ordersToday: { day: string; count: number };
  grossNotionalUsd: string;
}

export interface CheckedBuild {
  readonly build: UnsignedVenuePayload;
  readonly intent: OrderIntent | null;
  readonly cancel?: CancelIntent;
  readonly venue: VenueId;
  readonly mode: Mode;
  readonly agentRef: string;
  readonly digest: Hex;
  readonly checkedAt: number;
}

export interface SubmitOutcome {
  order: Order;
  receiptId: string;
  venueResponse?: unknown;
}

export interface KillResult {
  agentRef: string;
  relayBlocked: boolean;
  serverReached: boolean;
  revocation?: OnboardingBundle;
  closeAll?: UnsignedVenuePayload[];
  keyWiped: true;
  closeAllResults?: { marketId: string; status: string; receiptId: string | null; error?: string }[];
  error?: string;
}

export interface OnboardResult extends DelegationState {
  agentRef: string;
  receiptId?: string;
}

export interface CapstanClient {
  markets(q?: { venue?: VenueId; dex?: string; asset?: CanonicalAsset; executable?: boolean }): Promise<Market[]>;
  quote(r: QuoteRequest): Promise<RouteQuote>;
  funding(asset: CanonicalAsset): Promise<FundingSnapshot[]>;
  onboard(venue: VenueId, opts?: { policy?: AgentPolicy; policySig?: Hex; collateralMoves?: { toDex: string; token: string; amount: string }[]; mode?: Mode; directIp?: string }): Promise<OnboardResult>;
  buildOrder(intent: OrderIntent, venue: VenueId, mode: Mode): Promise<CheckedBuild>;
  signAndSubmit(b: CheckedBuild): Promise<{ order: Order; receiptId: string }>;
  cancel(c: CancelIntent, venue: VenueId, mode?: Mode): Promise<{ receiptId: string; status: string }>;
  closeAll(venues?: VenueId[]): Promise<{ venue: VenueId; marketId: string; receiptId: string | null; error?: string }[]>;
  amend(venueOrderId: string, intent: OrderIntent, venue: VenueId): Promise<{ cancelReceiptId: string; order: Order; receiptId: string }>;
  verifyReceipt(id: string | { receipt: Receipt; proof: ReceiptProof }): Promise<{ valid: boolean; checks: VerifyChecks }>;
  kill(agentRef: string, closeAll?: boolean): Promise<KillResult>;
  /** Aster account read, routed by the agent's onboarding mode (relay: via /v1/risk/ingest; direct: from this host). */
  asterRead(kind?: "positionRisk" | "balance" | "openOrders", agentRef?: string): Promise<{ ok: boolean; mode: Mode; venueResponse?: unknown }>;
  agents(): AgentRecord[];
  signer: { sign(payload: UnsignedVenuePayload): Promise<SignedEnvelope> };
  readonly pins: Pins;
}

const LIGHTER = new Set<VenueId>(["lighter-mainnet", "lighter-rh"]);
const SECP = new Set<VenueId>(["hyperliquid", "aster"]);
const ASTER_READ_PATHS = { positionRisk: "/fapi/v3/positionRisk", balance: "/fapi/v3/balance", openOrders: "/fapi/v3/openOrders" } as const;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function agentRefFor(venue: VenueId, owner: Hex, publicPart: string, acct?: { accountIndex?: number; apiKeyIndex?: number }): string {
  if (venue === "hyperliquid") return `hl:${publicPart.toLowerCase()}`;
  if (venue === "aster") return `aster:${owner.toLowerCase()}:${publicPart.toLowerCase()}`;
  return `${venue}:${acct?.accountIndex}:${acct?.apiKeyIndex}`;
}

/** Option and wallet field names that would carry a main-wallet secret. Refused outright (invariant 1). */
export const KEY_LIKE = /private|secret|mnemonic|seed|passphrase|keystore(Json|File)/i;

function refuseKeyMaterial(o: CapstanClientOptions): void {
  for (const k of Object.keys(o)) if (k !== "keystore" && KEY_LIKE.test(k)) throw new SdkError("INVALID_INPUT", `option ${k} is refused: the SDK never takes a main-wallet key`, { field: k });
  const w = o.walletSigner as unknown as Record<string, unknown> | undefined;
  if (w) for (const k of Object.keys(w)) if (KEY_LIKE.test(k)) throw new SdkError("INVALID_INPUT", `walletSigner.${k} is refused: pass a wallet interface, never a key`, { field: k });
  if (typeof o.walletSigner === "string") throw new SdkError("INVALID_INPUT", "walletSigner must be a wallet interface, never a key");
}

export function createClient(o: CapstanClientOptions): CapstanClient {
  refuseKeyMaterial(o);
  const now = o.now ?? Date.now;
  const pins = mergePins(PINS, o.pinned);
  const np: NetworkPins = pins.networks[o.network];
  const ks = o.keystore;
  const baseFetch = o.fetch ?? fetch;
  const apiFetch = o.x402 ? payingFetch(baseFetch, o.x402.payer, o.x402.controls ?? sdkSpendControls(o.network, o.x402.maxUsdPerCall), o.x402.maxUsdPerCall) : baseFetch;
  const api: Api = createApi(o.apiBase, apiFetch, o.apiKey ? { headers: () => ({ authorization: `Bearer ${o.apiKey}` }) } : {});
  const venueFetch = o.venueFetch ?? fetch;
  const hosts: Record<string, string> = { ...defaultVenueHosts(o.network), ...(o.venueHosts ?? {}) } as Record<string, string>;
  const markets: MarketSource = o.markets ?? publicVenueMarkets({ network: o.network, fetch: venueFetch, hosts });
  const anchor: AnchorReader | undefined = (() => {
    if (!o.anchor) {
      const addr = np.anchor.address;
      if (!addr) return undefined;
      const chain = o.network === "mainnet" ? CHAINS.rhc : CHAINS.rhcTestnet;
      return rpcAnchorReader({ rpcUrl: chain.publicRpc, address: addr, chainId: np.anchor.chainId, fetch: venueFetch });
    }
    if ("rootOf" in o.anchor) return o.anchor;
    const addr = o.anchor.address ?? np.anchor.address;
    if (!addr) return undefined;
    return rpcAnchorReader({ rpcUrl: o.anchor.rpcUrl, address: addr, chainId: np.anchor.chainId, fetch: venueFetch });
  })();
  const agents = new Map<string, AgentRecord>();
  const checked = new WeakSet<object>();
  let pinsChecked: Promise<void> | null = null;

  const assertPins = () => {
    if (o.checkServerPins === false) return Promise.resolve();
    if (!pinsChecked) {
      pinsChecked = api.get<VenueCapabilities[]>("/venues").then((v) => assertServerMatchesPins(v, np));
      pinsChecked.catch(() => (pinsChecked = null));
    }
    return pinsChecked;
  };

  const lighterChain = (venue: VenueId): LighterChainId => np.lighterSigningIds[venue as "lighter-mainnet" | "lighter-rh"];

  // ---- request auth (DECISIONS #125, #126). owner_sig: the Capstan api_request message over method, path and the
  // body's sha256, signed by the agent key of the owner the request names (the server accepts an active agent).
  const REQUEST_TTL_MS = 4 * 60_000;
  const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
  const agentAuth = (a: AgentRecord): RequestAuth | undefined => {
    if (!SECP.has(a.venue)) return undefined;
    return async ({ method, signedPath, rawBody }) => {
      const issuedAt = now();
      const text = capstanMessage({ purpose: "api_request", owner: a.owner, host: api.host, chainId: np.anchor.chainId, nonce: toHex(crypto.getRandomValues(new Uint8Array(12))).slice(2), issuedAt, expiresAt: issuedAt + REQUEST_TTL_MS, body: `${method} ${signedPath} ${bytesToHex(sha256(new TextEncoder().encode(rawBody)))}` });
      const sig = (await ks.sign(a.keyRef, personalDigest(text))) as Hex;
      return { "x-capstan-message": b64(text), "x-capstan-signature": sig };
    };
  };
  let anonKey: Promise<string | null> | null = null;
  /** The key for calls no agent can sign (onboarding, Lighter agents): the configured key, else an anonymous one. */
  const keyAuth: RequestAuth = async (): Promise<Record<string, string>> => {
    if (o.apiKey) return {}; // already on every call
    if (o.anonymousApiKey === false) return {};
    anonKey ??= api.post<{ key?: unknown }>("/account/keys", { owner: null }).then((r) => (typeof r?.key === "string" && /^cpst_[A-Za-z0-9_-]{20,200}$/.test(r.key) ? r.key : null));
    let k: string | null;
    try {
      k = await anonKey;
    } catch (e) {
      // the server refused the key (a rate limit, an outage): say so, rather than send the call without a key and
      // report the server's "owner signature missing" (found on the fork run, todo 40)
      anonKey = null;
      throw e;
    }
    if (!k) {
      anonKey = null; // try again next time; this call goes without a key and the server answers 401
      return {};
    }
    return { authorization: `Bearer ${k}` };
  };
  /**
   * Agent-scoped calls: the agent's owner signature, or the key when the agent is not a secp key (Lighter). The
   * gateway lets an API key act only for the wallet it was made for (security review r1 R1-04), so Lighter calls
   * need a configured `apiKey` made with that wallet's api_key_create signature; the anonymous key covers onboarding.
   */
  const authAs = (a: AgentRecord | undefined): RequestAuth => {
    const viaAgent = a ? agentAuth(a) : undefined;
    return viaAgent ?? keyAuth;
  };

  function agentFor(venue: VenueId, agentRef?: string): AgentRecord {
    if (agentRef) {
      const a = agents.get(agentRef);
      if (!a || a.venue !== venue) throw new SdkError("KEY_NOT_FOUND", `no local agent ${agentRef} for ${venue}`);
      return a;
    }
    const list = [...agents.values()].filter((a) => a.venue === venue);
    const a = list[list.length - 1];
    if (!a) throw new SdkError("KEY_NOT_FOUND", `no onboarded agent for ${venue}; call onboard first`);
    return a;
  }

  const specFor = (venue: VenueId, marketId: string): Promise<VenueMarketSpec> => markets.spec(venue, marketId);

  function ctxFor(a: AgentRecord, mode: Mode, spec: VenueMarketSpec | undefined, refPx: string | null | undefined): CheckContext {
    const day = utcDay(now());
    const ordersToday = a.ordersToday.day === day ? a.ordersToday.count : 0;
    return {
      venue: a.venue,
      approvedMax: a.approvedMaxBps,
      pins,
      network: o.network,
      nowMs: now(),
      ...(spec ? { market: spec } : {}),
      ...(refPx !== undefined ? { refPx } : {}),
      identity: { owner: a.owner, ...(SECP.has(a.venue) ? { agentAddress: a.publicPart as Hex } : {}), ...(a.accountIndex !== undefined ? { accountIndex: a.accountIndex, apiKeyIndex: a.apiKeyIndex } : {}) },
      ...(a.policy ? { policy: a.policy, policyInput: { agentRef: a.agentRef, grossNotionalUsd: a.grossNotionalUsd, ordersToday, mode } } : {}),
      ...(o.policyChecker ? { policyChecker: o.policyChecker } : {}),
    };
  }

  function seal(cb: CheckedBuild): CheckedBuild {
    const f = Object.freeze(cb);
    checked.add(f);
    return f;
  }

  async function checkOrderBuild(a: AgentRecord, intent: OrderIntent, b: UnsignedVenuePayload, mode: Mode): Promise<CheckedBuild> {
    const spec = await specFor(a.venue, intent.marketId);
    const refPx = intent.type === "market" ? await markets.refPx(a.venue, intent.marketId) : undefined;
    const r = checkBuild(intent, b, ctxFor(a, mode, spec, refPx));
    if (!r.ok) throw new SdkError(r.code, `${r.code}: ${r.field}`, { field: r.field });
    return seal({ build: b, intent, venue: a.venue, mode, agentRef: a.agentRef, digest: r.digest, checkedAt: now() });
  }

  async function checkCancel(a: AgentRecord, c: CancelIntent, b: UnsignedVenuePayload, mode: Mode): Promise<CheckedBuild> {
    const spec = await specFor(a.venue, c.marketId);
    const r = checkCancelBuild(c, b, ctxFor(a, mode, spec, undefined));
    if (!r.ok) throw new SdkError(r.code, `${r.code}: ${r.field}`, { field: r.field });
    return seal({ build: b, intent: null, cancel: c, venue: a.venue, mode, agentRef: a.agentRef, digest: r.digest, checkedAt: now() });
  }

  async function envelopeFor(cb: CheckedBuild): Promise<SignedEnvelope> {
    if (!checked.has(cb)) throw new SdkError("PAYLOAD_MISMATCH", "only builds checked by this client are signed", { field: "build" });
    if (now() > cb.build.expiresAt) throw new SdkError("BUILD_EXPIRED", "the build has expired; build again", { field: "expiresAt" });
    const a = agents.get(cb.agentRef);
    if (!a) throw new SdkError("KEY_NOT_FOUND", "the agent of this build is gone (killed or wiped)");
    return signEnvelope(cb.build, { keystore: ks, keyRef: a.keyRef, signerRef: LIGHTER.has(a.venue) ? `${a.accountIndex}:${a.apiKeyIndex}` : a.publicPart, digest: cb.digest, ...(LIGHTER.has(a.venue) ? { lighterChainId: lighterChain(a.venue) } : {}) });
  }

  function orderOf(cb: CheckedBuild, venueOrderId: string | null, status: Order["status"]): Order {
    const p = cb.build.preview;
    return {
      venue: cb.venue,
      marketId: p.marketId,
      venueOrderId: venueOrderId ?? "",
      side: p.side,
      size: p.size,
      filled: "0",
      px: p.px,
      status,
      builderFeeBps: p.builderFeeBps,
      createdAt: new Date(now()).toISOString(),
      ...(cb.intent?.clientOrderId ? { clientOrderId: cb.intent.clientOrderId } : {}),
    };
  }

  function account(cb: CheckedBuild): void {
    const a = agents.get(cb.agentRef);
    if (!a || !cb.intent) return;
    const day = utcDay(now());
    if (a.ordersToday.day !== day) a.ordersToday = { day, count: 0 };
    a.ordersToday.count++;
    if (!cb.intent.reduceOnly) a.grossNotionalUsd = sumDec(a.grossNotionalUsd, cb.build.preview.notionalUsd && /^\d+(\.\d+)?$/.test(cb.build.preview.notionalUsd) ? cb.build.preview.notionalUsd : "0");
  }

  async function submitChecked(cb: CheckedBuild): Promise<SubmitOutcome> {
    const r = await submitEnvelope(cb, await envelopeFor(cb));
    if (r.order.status === "rejected") throw new SdkError("VENUE_ERROR", "the venue refused the order", { receiptId: r.receiptId });
    return r;
  }

  async function newKey(venue: VenueId, serverKnown: Set<string>): Promise<{ ref: string; publicPart: string }> {
    const kind = LIGHTER.has(venue) ? "lighter" : "secp256k1";
    for (let i = 0; i < 3; i++) {
      let k: { ref: string; publicPart: string };
      try {
        k = await ks.create(venue, kind);
      } catch (e) {
        if (e instanceof SdkError && e.code === "KEY_REUSED") continue;
        throw e;
      }
      const used = (await ks.usedPublicParts?.()) ?? (await ks.list()).map((x) => x.publicPart.toLowerCase());
      const dupes = used.filter((u) => u === k.publicPart.toLowerCase()).length;
      if (dupes <= 1 && !serverKnown.has(k.publicPart.toLowerCase())) return k;
      await ks.wipe(k.ref);
    }
    throw new SdkError("KEY_REUSED", "could not make a key that was never used before");
  }

  const client: CapstanClient = {
    pins,
    agents: () => [...agents.values()].map((a) => ({ ...a })),

    markets: (q) => api.get<Market[]>("/markets", { venue: q?.venue, dex: q?.dex, asset: q?.asset, executable: q?.executable }),
    quote: (r) => api.post<RouteQuote>("/quote", r),
    funding: (asset) => api.get<FundingSnapshot[]>("/funding", { asset }),

    async onboard(venue, opts = {}) {
      if (!o.walletSigner) throw new SdkError("INVALID_INPUT", "onboarding needs the user's wallet (walletSigner)");
      if (!SECP.has(venue) && !LIGHTER.has(venue)) throw new SdkError("UNSUPPORTED", `${venue} is data only`);
      await assertPins();
      const wallet = o.walletSigner;
      const owner = (await wallet.address()).toLowerCase() as Hex;
      const mode: Mode = opts.policy ? "relay" : (opts.mode ?? "relay");
      if (opts.policy && opts.mode === "direct") throw new SdkError("POLICY_BREACH", "agent-safe mode is relay only", { field: "mode" });
      const pre = await api.get<{ agents?: string[]; namedAgents?: { address: string }[]; builderApprovedBps?: number; accountIndex?: number; freeKeyIndex?: number }>("/onboarding/preflight", { venue, owner });
      const serverKnown = new Set<string>([...(pre?.agents ?? []), ...(pre?.namedAgents ?? []).map((a) => a.address)].map((x) => String(x).toLowerCase()));
      const lighter = LIGHTER.has(venue);
      if (opts.policy && lighter && (pre?.accountIndex === undefined || pre?.freeKeyIndex === undefined)) throw new SdkError("INVALID_INPUT", "a Lighter policy needs the account and key index from preflight", { field: "policy" });
      const key = await newKey(venue, serverKnown);
      let done = false;
      try {
        // the policy the owner signs names this new agent (its ref is known before the bundle is built)
        const expectedRef = agentRefFor(venue, owner, key.publicPart, lighter ? { accountIndex: pre.accountIndex, apiKeyIndex: pre.freeKeyIndex } : undefined);
        const policy: AgentPolicy | undefined = opts.policy
          ? { ...opts.policy, owner, agents: opts.policy.agents.some((a) => a.agentRef === expectedRef) ? opts.policy.agents : [...opts.policy.agents, { venue, agentRef: expectedRef }] }
          : undefined;
        if (policy && !eqAddr(opts.policy!.owner, owner)) throw new SdkError("INVALID_INPUT", "the policy names another owner", { field: "policy.owner" });
        const bundle = await api.post<OnboardingBundle>(
          "/onboarding/build",
          {
          venue,
          owner,
          ...(lighter ? { lighterPubKey: key.publicPart } : { agentAddress: key.publicPart, builderMaxBps: 3 }),
          mode,
          ...(opts.directIp ? { directIp: opts.directIp } : {}),
          ...(policy ? { policy } : {}),
          ...(opts.collateralMoves ? { collateralMoves: opts.collateralMoves } : {}),
          },
          { auth: keyAuth },
        );
        const chk = checkOnboardingBundle(bundle, { venue, network: o.network, pins, owner, nowMs: now(), ...(lighter ? { lighterPubKey: key.publicPart } : { agentAddress: key.publicPart as Hex }), ...(policy ? { policy } : {}), ...(opts.collateralMoves ? { collateralMoves: opts.collateralMoves } : {}) });
        if (!chk.ok) throw new SdkError(chk.code, `${chk.code}: ${chk.field}`, { field: chk.field });
        const present = resolvePresenter(o.presentSteps, wallet.confirm ? (lines) => wallet.confirm!(lines) : undefined);
        if (present && !(await present(chk.lines))) throw new SdkError("WALLET_DECLINED", "the user declined the onboarding");
        const signatures: { step: number; sig: Hex }[] = [];
        let lighterSignedTx: { txType: number; txInfo: string } | undefined;
        let lighterSignedApproveIntegrator: { txType: number; txInfo: string } | undefined;
        for (let i = 0; i < bundle.steps.length; i++) {
          const s = bundle.steps[i]!;
          if (s.kind === "lighter_change_pubkey") {
            const args = (s.venueTx as { args: { pubKeyHex: string; nonce: number; apiKeyIndex: number; accountIndex: number; expiredAt: number } }).args;
            const r = (await ks.sign(key.ref, { op: "changePubKey", chainId: lighterChain(venue), args })) as { txType: number; txInfo: string; messageToSign?: string };
            if (r.messageToSign !== s.personalSignText) throw new SdkError("PAYLOAD_MISMATCH", "the registration text differs from what the local signer made", { field: "lighter_change_pubkey.text" });
            lighterSignedTx = { txType: r.txType, txInfo: r.txInfo };
            signatures.push({ step: i, sig: await wallet.signMessage(s.personalSignText!) });
          } else if (s.kind === "lighter_approve_integrator") {
            const args = (s.venueTx as { args: Record<string, number> }).args;
            const r = (await ks.sign(key.ref, { op: "approveIntegrator", chainId: lighterChain(venue), args })) as { txType: number; txInfo: string };
            lighterSignedApproveIntegrator = { txType: r.txType, txInfo: r.txInfo };
          } else if (s.signer === "main_wallet" && s.typedData) {
            signatures.push({ step: i, sig: await wallet.signTypedData(s.typedData) });
          } else if (s.signer === "main_wallet" && s.personalSignText) {
            signatures.push({ step: i, sig: await wallet.signMessage(s.personalSignText) });
          } else throw new SdkError("UNSUPPORTED", `step ${s.kind} is not signed by this SDK`, { field: s.kind });
        }
        const res = await api.post<{ delegation: DelegationState; receiptId?: string; agentRef?: string }>("/onboarding/submit", {
          bundleId: bundle.bundleId,
          signatures,
          ...(lighterSignedTx ? { lighterSignedTx } : {}),
          ...(lighterSignedApproveIntegrator ? { lighterSignedApproveIntegrator } : {}),
          ...(opts.policySig ? { policySig: opts.policySig } : {}),
        }, { auth: keyAuth });
        let acct: { accountIndex?: number; apiKeyIndex?: number } = {};
        if (lighter) {
          const a = (bundle.steps.find((s) => s.kind === "lighter_change_pubkey")!.venueTx as { args: { accountIndex: number; apiKeyIndex: number } }).args;
          acct = { accountIndex: a.accountIndex, apiKeyIndex: a.apiKeyIndex };
        }
        const agentRef = agentRefFor(venue, owner, key.publicPart, acct);
        if (policy && agentRef !== expectedRef) throw new SdkError("PAYLOAD_MISMATCH", "the bundle registers another key index than preflight named", { field: "apiKeyIndex" });
        if (res.agentRef && res.agentRef !== agentRef) throw new SdkError("PAYLOAD_MISMATCH", "the server names another agent", { field: "agentRef" });
        const approvedMaxBps = venue === "hyperliquid" || venue === "aster" ? Math.min(3, res.delegation?.builderMaxBps ?? 0) : 0;
        agents.set(agentRef, {
          agentRef,
          venue,
          owner,
          keyRef: key.ref,
          publicPart: key.publicPart,
          mode,
          ...acct,
          approvedMaxBps: approvedMaxBps > 0 ? approvedMaxBps : venue === "hyperliquid" || venue === "aster" ? null : 0,
          ...(policy ? { policy } : {}),
          ...(res.delegation?.policyId ? { policyId: res.delegation.policyId } : {}),
          ordersToday: { day: utcDay(now()), count: 0 },
          grossNotionalUsd: "0",
        });
        await ks.tag?.(key.ref, { agentRef, owner, mode, ...(acct.accountIndex !== undefined ? { accountIndex: String(acct.accountIndex), apiKeyIndex: String(acct.apiKeyIndex) } : {}) });
        done = true;
        return { ...res.delegation, agentRef, ...(res.receiptId ? { receiptId: res.receiptId } : {}) };
      } finally {
        // a key that did not finish onboarding is never kept (and never reused)
        if (!done) await ks.wipe(key.ref).catch(() => undefined);
      }
    },

    async buildOrder(intent, venue, mode) {
      await assertPins();
      const a = agentFor(venue);
      const m: Mode = a.policy ? "relay" : mode; // agent-safe mode forces relay
      if (m === "direct" && a.venue === "aster" && a.mode === "relay") throw new SdkError("INVALID_INPUT", "this Aster agent only works from the relay (IP whitelist); onboard a direct-mode agent", { field: "mode" });
      const b = await api.post<UnsignedVenuePayload>("/orders/build", { owner: a.owner, agentRef: a.agentRef, intent, mode: m }, { auth: authAs(a) });
      return checkOrderBuild(a, intent, b, m);
    },

    async signAndSubmit(cb) {
      const r = await submitChecked(cb);
      return { order: r.order, receiptId: r.receiptId };
    },

    async cancel(c, venue, mode) {
      const a = agentFor(venue);
      const m: Mode = a.policy ? "relay" : (mode ?? a.mode);
      const b = await api.post<UnsignedVenuePayload>("/orders/cancel/build", { owner: a.owner, agentRef: a.agentRef, marketId: c.marketId, ...(c.venueOrderId ? { venueOrderId: c.venueOrderId } : {}), ...(c.clientOrderId ? { clientOrderId: c.clientOrderId } : {}), mode: m }, { auth: authAs(a) });
      const cb = await checkCancel(a, c, b, m);
      const r = await submitChecked(cb);
      return { receiptId: r.receiptId, status: r.order.status };
    },

    async closeAll(venues) {
      await assertPins();
      const owners = new Set([...agents.values()].filter((a) => !venues || venues.includes(a.venue)).map((a) => a.owner));
      const out: { venue: VenueId; marketId: string; receiptId: string | null; error?: string }[] = [];
      for (const owner of owners) {
        const signerAgent = [...agents.values()].filter((x) => x.owner === owner && SECP.has(x.venue)).at(-1);
        const builds = await api.post<UnsignedVenuePayload[]>("/orders/close-all/build", { owner, ...(venues ? { venues } : {}) }, { auth: authAs(signerAgent) });
        for (const b of builds) {
          try {
            const a = agentFor(b.venue);
            if (!eqAddr(a.owner, owner)) throw new SdkError("PAYLOAD_MISMATCH", "close-all for another owner", { field: "owner" });
            const spec = await specFor(b.venue, b.preview.marketId);
            const intent = intentFromPayload(b, spec, { maxSlippageBps: o.closeAllSlippageBps ?? 300 });
            if (!intent.reduceOnly) throw new SdkError("PAYLOAD_MISMATCH", "a close-all order must be reduce-only", { field: "reduceOnly" });
            const cb = await checkOrderBuild(a, intent, b, "relay");
            const r = await submitChecked(cb);
            out.push({ venue: b.venue, marketId: b.preview.marketId, receiptId: r.receiptId });
          } catch (e) {
            out.push({ venue: b.venue, marketId: b.preview?.marketId ?? "", receiptId: null, error: (e as Error).message });
          }
        }
      }
      return out;
    },

    async amend(venueOrderId, intent, venue) {
      const a = agentFor(venue);
      const m: Mode = a.policy ? "relay" : a.mode;
      // build and check BOTH before signing anything (DECISIONS #54)
      const cancelIntent: CancelIntent = { marketId: intent.marketId, venueOrderId };
      const cancelBuild = await api.post<UnsignedVenuePayload>("/orders/cancel/build", { owner: a.owner, agentRef: a.agentRef, marketId: intent.marketId, venueOrderId, mode: m }, { auth: authAs(a) });
      const cancelChecked = await checkCancel(a, cancelIntent, cancelBuild, m);
      const orderBuild = await api.post<UnsignedVenuePayload>("/orders/build", { owner: a.owner, agentRef: a.agentRef, intent, mode: m }, { auth: authAs(a) });
      const orderChecked = await checkOrderBuild(a, intent, orderBuild, m);
      const cancelEnv = await envelopeFor(cancelChecked);
      const orderEnv = await envelopeFor(orderChecked);
      // cancel first; the new order is sent only when the cancel succeeded
      let cancelReceipt: string;
      try {
        const r = await submitEnvelope(cancelChecked, cancelEnv);
        if (r.order.status === "rejected") throw new SdkError("VENUE_ERROR", "the cancel was refused; the new order was not sent");
        cancelReceipt = r.receiptId;
      } catch (e) {
        if (e instanceof SdkError && e.code === "VENUE_ERROR") throw e;
        throw new SdkError("VENUE_ERROR", `the cancel failed (${(e as Error).message}); the new order was not sent`);
      }
      const r2 = await submitEnvelope(orderChecked, orderEnv);
      return { cancelReceiptId: cancelReceipt, order: r2.order, receiptId: r2.receiptId };
    },

    async verifyReceipt(id) {
      let receipt: Receipt;
      let proof: ReceiptProof;
      if (typeof id === "string") {
        receipt = await api.get<Receipt>(`/receipts/${encodeURIComponent(id)}`);
        proof = await api.get<ReceiptProof>(`/receipts/${encodeURIComponent(id)}/proof`);
        if (receipt.receiptId !== id) throw new SdkError("PAYLOAD_MISMATCH", "the server returned another receipt", { field: "receiptId" });
      } else ({ receipt, proof } = id);
      return verifyReceiptOffline(receipt, proof, { signers: np.receiptSigners, ...(anchor ? { anchor } : {}) });
    },

    async kill(agentRef, closeAll = false) {
      const a = agents.get(agentRef);
      const recs = await ks.list();
      const keyRef = a?.keyRef ?? recs.find((r) => (r as { tags?: Record<string, string> }).tags?.agentRef === agentRef)?.ref;
      const result: KillResult = { agentRef, relayBlocked: false, serverReached: false, keyWiped: true };
      try {
        const owner = a?.owner ?? ((await o.walletSigner?.address()) as Hex | undefined);
        if (!owner) throw new SdkError("INVALID_INPUT", "no owner known for this agent");
        const issuedAt = now();
        const message = capstanMessage({ purpose: "kill", owner, host: api.host, chainId: np.anchor.chainId, nonce: toHex(crypto.getRandomValues(new Uint8Array(12))).slice(2), issuedAt, expiresAt: issuedAt + 5 * 60_000, body: agentRef });
        let sig: Hex;
        if (a && keyRef && SECP.has(a.venue)) sig = (await ks.sign(keyRef, personalDigest(message))) as Hex; // self-halt with the agent key
        else if (o.walletSigner) sig = await o.walletSigner.signMessage(message);
        else throw new SdkError("INVALID_INPUT", "a Lighter agent is stopped with the owner's wallet signature");
        const r = await api.post<{ relayBlocked: boolean; revocation?: OnboardingBundle; closeAll?: UnsignedVenuePayload[] }>(`/agents/${encodeURIComponent(agentRef)}/kill`, { sig, message, ts: issuedAt, closeAll });
        result.serverReached = true;
        result.relayBlocked = r.relayBlocked === true;
        if (r.revocation) result.revocation = r.revocation;
        if (r.closeAll) {
          result.closeAll = r.closeAll;
          // the relay now refuses this agent, so the reduce-only closes go straight to the venue, signed before the wipe
          if (a) result.closeAllResults = await closeDirect(a, r.closeAll);
        }
      } catch (e) {
        result.error = (e as Error).message;
      } finally {
        // the local key is wiped whatever the server did (spec 7.6 step 4)
        if (keyRef) await ks.wipe(keyRef);
        agents.delete(agentRef);
      }
      return result;
    },

    async asterRead(kind = "positionRisk", agentRef) {
      const a = agentFor("aster", agentRef);
      const path = ASTER_READ_PATHS[kind];
      const net = np.asterNetwork;
      const chainId = net === "Testnet" ? 714 : 1666;
      const nonce = BigInt(now()) * 1000n;
      const params: Param[] = [["asterChain", net], ["user", a.owner], ["signer", a.publicPart as Hex], ["nonce", nonce]];
      const query = queryString(params);
      const signature = (await ks.sign(a.keyRef, digestTrade(query, chainId))) as Hex;
      const signedRead = { path, query, signature, signer: a.publicPart as Hex, owner: a.owner, fetchedAtMs: now() };
      if (a.mode === "relay") {
        // the agent is whitelisted to the relay egress IP: the API host sends the signed read for us
        const r = await api.post<{ ok: boolean }>("/risk/ingest", { venue: "aster", mode: "relay", signedRead }, { auth: authAs(a) });
        return { ok: r.ok === true, mode: "relay" };
      }
      const res = await venueFetch(`${hosts.aster!.replace(/\/$/, "")}${path}?${query}&signature=${signature}`, { method: "GET" });
      const snapshot = await res.json().catch(() => null);
      if (!res.ok) throw new SdkError("VENUE_ERROR", `Aster read failed (${res.status})`);
      const r = await api.post<{ ok: boolean }>("/risk/ingest", { venue: "aster", mode: "direct", snapshot, signedRead: { ...signedRead, fetchedAtMs: now() } }, { auth: authAs(a) });
      return { ok: r.ok === true, mode: "direct", venueResponse: snapshot };
    },

    signer: {
      async sign(payload) {
        await assertPins();
        const a = agentFor(payload.venue);
        const spec = await specFor(payload.venue, payload.preview?.marketId ?? "");
        const isCancel = (payload.payload as { action?: { type?: string }; txType?: number; kind?: string })?.action?.type?.startsWith("cancel") || (payload.payload as { txType?: number }).txType === 15 || (payload.payload as { kind?: string }).kind === "cancel";
        if (isCancel) throw new SdkError("UNSUPPORTED", "sign cancels through client.cancel, which knows the order id", { field: "type" });
        const intent = intentFromPayload(payload, spec, { maxSlippageBps: o.closeAllSlippageBps ?? 300 });
        const cb = await checkOrderBuild(a, intent, payload, "relay");
        return envelopeFor(cb);
      },
    },
  };

  async function submitEnvelope(cb: CheckedBuild, env: SignedEnvelope): Promise<SubmitOutcome> {
    if (cb.mode === "relay") {
      const r = await api.post<{ order: Order; receiptId: string }>("/orders/submit", { buildId: cb.build.buildId, signedEnvelope: env }, { auth: authAs(agents.get(cb.agentRef)) });
      account(cb);
      return r;
    }
    const d = await postDirect(cb.venue, env, { hosts, fetch: venueFetch, ...(cb.cancel && cb.venue === "aster" ? { method: "DELETE" as const } : {}) });
    const claim = await api.post<{ receiptId: string; order?: Order }>("/receipts/claim", { buildId: cb.build.buildId, signedEnvelope: env, venueResponse: d.venueResponse }, { auth: authAs(agents.get(cb.agentRef)) });
    if (d.status !== "accepted") return { order: claim.order ?? orderOf(cb, null, "rejected"), receiptId: claim.receiptId, venueResponse: d.venueResponse };
    account(cb);
    return { order: claim.order ?? orderOf(cb, d.venueOrderId ?? d.txHash, "open"), receiptId: claim.receiptId, venueResponse: d.venueResponse };
  }

  async function closeDirect(a: AgentRecord, builds: UnsignedVenuePayload[]): Promise<NonNullable<KillResult["closeAllResults"]>> {
    const out: NonNullable<KillResult["closeAllResults"]> = [];
    for (const b of builds) {
      const marketId = b?.preview?.marketId ?? "";
      try {
        if (b.venue !== a.venue) throw new SdkError("PAYLOAD_MISMATCH", "close-all for another venue", { field: "venue" });
        if (a.venue === "aster" && a.mode === "relay") throw new SdkError("INVALID_INPUT", "a relay-only Aster agent cannot close from this host");
        const intent = intentFromPayload(b, await specFor(b.venue, marketId), { maxSlippageBps: o.closeAllSlippageBps ?? 300 });
        if (!intent.reduceOnly) throw new SdkError("PAYLOAD_MISMATCH", "a close-all order must be reduce-only", { field: "reduceOnly" });
        // checked as relay traffic (the owner asked for these reduce-only closes); posted straight to the venue
        const cb = await checkOrderBuild(a, intent, b, "relay");
        const env = await envelopeFor(cb);
        const d = await postDirect(a.venue, env, { hosts, fetch: venueFetch });
        let receiptId: string | null = null;
        try {
          receiptId = (await api.post<{ receiptId: string }>("/receipts/claim", { buildId: b.buildId, signedEnvelope: env, venueResponse: d.venueResponse }, { auth: authAs(a) })).receiptId;
        } catch {
          receiptId = null;
        }
        out.push({ marketId, status: d.status, receiptId });
      } catch (e) {
        out.push({ marketId, status: "not_sent", receiptId: null, error: (e as Error).message });
      }
    }
    return out;
  }

  return client;
}
