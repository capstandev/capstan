// Relay test stack: real adapters (Hyperliquid built through its own buildOrder on recorded fixtures; Lighter and
// Aster builds in their exact encodings), real verifySigned and submit against fake venue servers that record every
// request body, the real receipts library (signing, chaining) and in-memory stores. Test keys come from public labels.
import { ulid } from "@capstan/core";
import { createAdapter as createAsterAdapter, asterConfig, createAsterReader } from "@capstan/adapter-aster";
import { createAdapter as createHlAdapter, createHlReader, type HlUnsignedPayload } from "@capstan/adapter-hyperliquid";
import { createLighterAdapter, lighterConfig } from "@capstan/adapter-lighter";
import type { EligibilityDecision, EligibilityInput } from "@capstan/eligibility";
import { idemKeyOf, issue, memoryLock, memoryStore, nobleSigner, type ReceiptDraft } from "@capstan/receipts";
import type { AgentPolicy, Hex, OrderIntent, Receipt, SignedEnvelope, UnsignedVenuePayload, VenueId } from "@capstan/schema";
import { digestTrade, payloadHashOf, queryString } from "@capstan/signer-aster";
import { addressOf } from "@capstan/signer-hl";
import { createMemoryGovernor, fakeVenueServer, venueHttp, type Governor } from "@capstan/venue-client";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { CFG } from "../../../packages/adapters/hyperliquid/test/helpers";
import { AGENT, book, ctx, setup, sign as hlSign, T0, USER_A } from "../../../packages/adapters/hyperliquid/test/orders/util";
import { addressOfSecret, signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import { asterBuild, lighterBuild } from "../../../packages/sdk/test/helpers";
import { priorityDispatcher } from "../src/dispatch";
import { relayFlags } from "../src/flags";
import { memoryKillView } from "../src/kill";
import { memoryLaneLimiter } from "../src/lanes";
import { memoryRelayStore, memoryVenueSignals } from "../src/stores";
import type { DelegationView, RelayDeps, StoredBuild } from "../src/types";
import { asterRelayVenue, hlRelayVenue, lighterRelayVenue, sha256Jcs } from "../src/venues";
import { passThroughGovernor } from "../src/wire";

export { AGENT, T0, USER_A };
export const NOW = T0 + 1000;
export const testKey = (l: string) => keccak_256(utf8ToBytes(`capstan-relay-test:${l}`)); // test-key
export const RECEIPT_KEY = testKey("receipt-signer");
export const ASTER_AGENT_KEY = testKey("aster-agent");
export const ASTER_AGENT = addressOfSecret(ASTER_AGENT_KEY);
export const LIGHTER_OWNER = "0x00000000000000000000000000000000000a11ce" as Hex;
export const HL_REF = `hl:${AGENT}`;
export const ASTER_REF = `aster:${USER_A.toLowerCase()}:${ASTER_AGENT.toLowerCase()}`;
export const LIGHTER_REF = "lighter-mainnet:712:5";

export interface Recorded {
  path: string;
  body: string;
  at: number;
}

/** Fake venues: every request body is recorded as raw text with the governor clock time. */
export function fakeVenues(clock: () => number = () => NOW) {
  const hl: Recorded[] = [];
  const lighter: Recorded[] = [];
  const aster: Recorded[] = [];
  const hlReply = { value: (_body: string): unknown => ({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 4242 } }] } } }) };
  let oid = 1000;
  const hlSrv = fakeVenueServer({
    "POST /exchange": async (r) => {
      const text = await r.text();
      hl.push({ path: "/exchange", body: text, at: clock() });
      const out = hlReply.value(text);
      if (out && typeof out === "object" && (out as { response?: { data?: { statuses?: { resting?: { oid: number } }[] } } }).response?.data?.statuses?.[0]?.resting) {
        return Response.json({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: oid++ } }] } } });
      }
      return Response.json(out);
    },
  });
  const lighterSrv = fakeVenueServer({
    "POST /api/v1/sendTx": async (r) => {
      const text = await r.text();
      lighter.push({ path: "/api/v1/sendTx", body: text, at: clock() });
      return Response.json({ code: 200, tx_hash: `0x${"ab".repeat(32)}` });
    },
  });
  const asterSrv = fakeVenueServer({
    "/fapi/v3/order": async (r) => {
      const u = new URL(r.url);
      aster.push({ path: `${u.pathname}${u.search}`, body: await r.text(), at: clock() });
      // raw text: the order id is above 2^53 - 1, as Aster sends it
      return new Response('{"orderId":9007199254740993,"status":"NEW"}', { headers: { "content-type": "application/json" } });
    },
  });
  return {
    hl,
    lighter,
    aster,
    hlReply,
    urls: { hl: hlSrv.url, lighter: lighterSrv.url, aster: asterSrv.url },
    total: () => hl.length + lighter.length + aster.length,
    clear() {
      hl.length = 0;
      lighter.length = 0;
      aster.length = 0;
    },
    stop() {
      hlSrv.stop();
      lighterSrv.stop();
      asterSrv.stop();
    },
  };
}

/** A receipt service in memory with the pg service's idempotency (requestHash + buildId). */
export function memoryReceipts(now: () => number = () => NOW) {
  const store = memoryStore();
  const lock = memoryLock();
  const signer = nobleSigner(RECEIPT_KEY);
  const byIdem = new Map<string, Receipt>();
  const all: Receipt[] = [];
  return {
    signer: signer.address,
    all,
    async issue(d: ReceiptDraft): Promise<Receipt> {
      const k = idemKeyOf(d);
      const hit = byIdem.get(k);
      if (hit) return hit;
      const r = await issue(d, { store, signer, now: () => new Date(now()), id: () => ulid(now()), lock });
      byIdem.set(k, r);
      all.push(r);
      return r;
    },
    byId: (id: string) => all.find((r) => r.receiptId === id) ?? null,
  };
}

export interface StackOptions {
  governor?: Governor;
  clock?: () => number;
  freeBudgetWaitMs?: number;
  proBudgetWaitMs?: number;
  concurrency?: number;
}

/** The whole relay on memory stores, the three executable venues wired to fake servers. */
export function relayStack(o: StackOptions = {}) {
  const now = () => NOW;
  const venues = fakeVenues(o.clock);
  const governor = o.governor ?? createMemoryGovernor("test-egress");
  const pass = passThroughGovernor(governor);
  const builder = setup(undefined);
  void builder.cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
  const hlHttp = venueHttp("hyperliquid", venues.urls.hl, pass, { maxTries: 1 });
  const hlSubmit = createHlAdapter(CFG as typeof CFG & { builderAddress: Hex }, { http: hlHttp, cache: builder.cache, reader: createHlReader(CFG, hlHttp, builder.cache), now, agentState: () => "active" });
  const lighterCfg = lighterConfig("mainnet");
  const lighterSubmit = createLighterAdapter(lighterCfg, { http: venueHttp(lighterCfg.governorKey, venues.urls.lighter, pass, { maxTries: 1 }), cache: null, execution: true, now });
  const asterCfg = asterConfig("Mainnet");
  const asterHttp = venueHttp("aster", venues.urls.aster, pass, { maxTries: 1 });
  const asterSubmit = createAsterAdapter({ ...asterCfg, builder: "0x00000000000000000000000000000000c0ffee02", execution: true }, { http: asterHttp, cache: null, reader: createAsterReader(asterCfg, asterHttp, null), now });
  const store = memoryRelayStore();
  const kill = memoryKillView();
  const receipts = memoryReceipts(now);
  const policies = new Map<string, { policyId: string; policy: AgentPolicy }>();
  const refusedIps = new Map<string, "GEO_REFUSED" | "DECLARATION_MISSING">();
  const decisions: EligibilityInput[] = [];
  const breaches: { owner: Hex; agentRef: string; field: string; buildId: string }[] = [];
  const lanes = memoryLaneLimiter();
  const laneOf = { value: async (_o: Hex, _k?: string) => ({ lane: "pro" as "pro" | "free", perMin: 20 }) };
  const flags = relayFlags({ RELAY_SUBMIT_ARMED: "1" });
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  let n = 0;
  const deps: RelayDeps = {
    store,
    kill,
    policy: { active: async (ref) => policies.get(ref) ?? null },
    eligibility: async (i): Promise<EligibilityDecision> => {
      decisions.push(i);
      const code = refusedIps.get(i.ip);
      return { id: `elig-${++n}`, allowed: !code, ...(code ? { code } : {}), rulesVersion: 1, ipCountry: code === "GEO_REFUSED" ? "US" : "DE", declarationId: code === "DECLARATION_MISSING" ? null : "decl-1" };
    },
    venueSignals: memoryVenueSignals(),
    lanes,
    laneOf: (owner, k) => laneOf.value(owner, k),
    governor,
    venues: new Map([
      ["hyperliquid", hlRelayVenue(hlSubmit)],
      ["lighter-mainnet", lighterRelayVenue("lighter-mainnet", lighterSubmit, { l1Of: (b) => b.owner })],
      ["aster", asterRelayVenue(asterSubmit)],
    ]) as RelayDeps["venues"],
    receipts,
    flags,
    alerts: { policyBreach: async (e) => void breaches.push(e) },
    dispatch: priorityDispatcher(o.concurrency ?? 4),
    now,
    id: () => ulid(),
    log: (msg, fields) => void logs.push({ msg, fields }),
    ...(o.freeBudgetWaitMs !== undefined ? { freeBudgetWaitMs: o.freeBudgetWaitMs } : {}),
    ...(o.proBudgetWaitMs !== undefined ? { proBudgetWaitMs: o.proBudgetWaitMs } : {}),
  };
  const delegation = (id: string, venue: VenueId, over: Partial<DelegationView> = {}): DelegationView => ({ id, venue, owner: USER_A, agentAddress: AGENT, accountIndex: null, apiKeyIndex: null, state: "active", expiresAt: null, ...over });
  store.delegations.set(HL_REF, delegation(HL_REF, "hyperliquid"));
  store.delegations.set(ASTER_REF, delegation(ASTER_REF, "aster", { agentAddress: ASTER_AGENT }));
  store.delegations.set(LIGHTER_REF, delegation(LIGHTER_REF, "lighter-mainnet", { owner: LIGHTER_OWNER, agentAddress: null, accountIndex: 712, apiKeyIndex: 5 }));

  function put(build: UnsignedVenuePayload, f: { owner: Hex; agentRef: string | null; kind?: StoredBuild["kind"]; policyId?: string | null; leverage?: number }): StoredBuild {
    const s: StoredBuild = { build, owner: f.owner, agentRef: f.agentRef, venue: build.venue, marketId: build.preview.marketId, kind: f.kind ?? "order", mode: "relay", requestHash: sha256Jcs({ build: build.buildId }), policyId: f.policyId ?? null, leverage: f.leverage ?? 1, eligibilityDecisionId: build.eligibilityDecisionId, expiresAt: build.expiresAt };
    store.builds.set(build.buildId, s);
    return s;
  }

  const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50, ...over });

  /** A real HL build (the adapter's buildOrder or buildCancel), stored, plus its signed envelope. */
  async function hl(over: Partial<OrderIntent> = {}, c: { agentRef?: string; kind?: "order" | "cancel"; policyId?: string | null; builderF?: number | null; agentKey?: Uint8Array } = {}) {
    const agentRef = c.agentRef ?? HL_REF;
    const agentAddress = c.agentKey ? (addressOf(c.agentKey).toLowerCase() as Hex) : AGENT;
    const bctx = ctx({ agentRef, policyId: c.policyId ?? null, identity: { venue: "hyperliquid", owner: USER_A, agentAddress }, ...(c.builderF === null ? { builderFee: null } : c.builderF ? { builderFee: { tenthsBp: c.builderF } } : {}) });
    const b = (c.kind === "cancel" ? await builder.adapter.buildCancel({ marketId: "hyperliquid:-:BTC", venueOrderId: "4242" }, bctx) : await builder.adapter.buildOrder(intent(over), bctx)) as HlUnsignedPayload;
    const s = put(b, { owner: USER_A, agentRef, kind: c.kind ?? "order", policyId: c.policyId ?? null });
    return { b, s, env: c.agentKey ? hlSign(b, c.agentKey) : hlSign(b) };
  }

  let asterNonce = 0;
  /** An Aster build in the adapter's encoding (SDK helper), signed by the agent key. */
  function aster(over: Partial<OrderIntent> = {}) {
    const i = intent({ marketId: "aster:-:BTCUSDT", type: "limit", limitPx: "76000.0", tif: "gtc", size: "0.010", ...over });
    const b0 = asterBuild(i, { owner: USER_A, signer: ASTER_AGENT, nowMs: T0 + ++asterNonce });
    const b = { ...b0, buildId: ulid(), expiresAt: NOW + 30_000 };
    put(b, { owner: USER_A, agentRef: ASTER_REF });
    const params = (b.payload as { params: [string, unknown][] }).params;
    const query = queryString(params as never);
    const digest = digestTrade(query, 1666);
    const env: SignedEnvelope = { buildId: b.buildId, venue: "aster", encoding: "aster_v3_params", signedBody: query, signature: signDigestRsv(digest, ASTER_AGENT_KEY), signerRef: ASTER_AGENT, payloadHash: payloadHashOf(query) };
    return { b, env };
  }

  let lighterNonce = 0;
  /** A Lighter build in the adapter's encoding with a txInfo carrying every field and a Sig of the right shape. */
  function lighter(over: Partial<OrderIntent> = {}, kind: "order" | "cancel" = "order") {
    const i = intent({ marketId: "lighter-mainnet:-:ETH", size: "0.1", ...over });
    const b0 = lighterBuild(i, { nowMs: T0, mutate: (a) => void (a.nonce = 100 + ++lighterNonce) });
    const b = { ...b0, buildId: ulid(), expiresAt: NOW + 30_000 };
    put(b, { owner: LIGHTER_OWNER, agentRef: LIGHTER_REF, kind });
    const a = (b.payload as { args: Record<string, number | boolean> }).args;
    const bit = (x: unknown) => (x ? 1 : 0);
    const sig = Buffer.from(keccak_256(utf8ToBytes(`sig:${b.buildId}`))).toString("base64").replace(/=/g, "").repeat(4).slice(0, 106) + "==";
    const txInfo = JSON.stringify({ AccountIndex: a.accountIndex, ApiKeyIndex: a.apiKeyIndex, MarketIndex: a.marketIndex, ClientOrderIndex: a.clientOrderIndex, BaseAmount: a.baseAmount, Price: a.price, IsAsk: bit(a.isAsk), Type: a.orderType, TimeInForce: a.timeInForce, ReduceOnly: bit(a.reduceOnly), TriggerPrice: a.triggerPrice, OrderExpiry: a.orderExpiry, ExpiredAt: a.expiredAt, Nonce: a.nonce, Sig: sig });
    const env: SignedEnvelope = { buildId: b.buildId, venue: "lighter-mainnet", encoding: "lighter_tx", signedBody: { txType: 14, txInfo }, signature: sig, signerRef: "712:5", payloadHash: b.digest };
    return { b, env };
  }

  return { deps, venues, store, kill, receipts, policies, refusedIps, decisions, breaches, lanes, laneOf, flags, logs, governor, builder, hl, aster, lighter, put, stop: venues.stop };
}

export const policyFor = (agentRef: string, over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  owner: USER_A,
  agents: [{ venue: "hyperliquid", agentRef }],
  maxNotionalPerOrderUsd: "1000",
  maxGrossNotionalUsd: "5000",
  maxLeverage: 5,
  allowedMarkets: "*",
  allowedVenues: ["hyperliquid"],
  maxOrdersPerDay: 100,
  expiresAt: new Date(NOW + 86_400_000).toISOString(),
  nonce: "policy-nonce-1",
  ...over,
});

/** Run a submit and return the refusal code, or null when it went through. */
export async function codeOf(p: Promise<unknown>): Promise<{ code: string | null; receiptId?: string; field?: string; message?: string }> {
  try {
    await p;
    return { code: null };
  } catch (e) {
    const x = e as { code?: string; receiptId?: string; field?: string; message?: string };
    return { code: x.code ?? "THROWN", ...(x.receiptId ? { receiptId: x.receiptId } : {}), ...(x.field ? { field: x.field } : {}), ...(x.message ? { message: x.message } : {}) };
  }
}
