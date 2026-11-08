// A local Capstan stack for the SDK tests: a fake Hyperliquid venue (fakeVenueServer from the venue client, stateful
// for agents and builder approvals, recorded fixtures for market data) and a stand-in API that runs the REAL
// Hyperliquid adapter for onboarding bundles, order builds, verifySigned and submit, and the REAL receipts library
// for signing, chaining and proofs. The surfaces lane's apps/api replaces this stand-in once it lands; the routes
// and bodies here follow spec 13.1. Every response can be tampered with to play a compromised server.
import { memoryMarketDataCache } from "@capstan/core";
import { createAdapter, createHlReader, HL_MAINNET, type HlAdapter, type HlUnsignedPayload } from "@capstan/adapter-hyperliquid";
import { buildTree, issue, memoryLock, memoryStore, nobleSigner, proofFor, receiptLeaf, drafts } from "@capstan/receipts";
import type { Hex, OnboardingBundle, OnboardingStep, Receipt, SignedEnvelope, UnsignedVenuePayload, VenueCapabilities } from "@capstan/schema";
import { fakeVenueServer, type RawResponse, type VenueHttp } from "@capstan/venue-client";
import { buildOnboarding as asterOnboarding } from "@capstan/adapter-aster";
import { AsterNonce } from "@capstan/signer-aster";
import { route } from "../../adapters/hyperliquid/test/helpers";
import { sha256Jcs } from "../src/bytes";
import { hlTemplateHash } from "../src/onboard";
import { BUILDER_ASTER, BUILDER_HL, labelAddr, T0, testKey } from "./helpers";
import { memoryNonceStore, type RouteAuth, type RouteSpec } from "@capstan/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../../apps/api/src/app";
import { apiKeyCheck, apiKeyVerifier, ownerSigVerifier } from "../../../apps/api/src/auth";
import ROUTE_TABLE from "../../../apps/api/test/route-table.snap.json";

export const RECEIPT_KEY = testKey("receipt-signer");

function fetchHttp(base: string): VenueHttp {
  const req = async (method: string, path: string, init: { query?: Record<string, string | number>; json?: unknown; form?: Record<string, string> } = {}): Promise<RawResponse> => {
    const u = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) u.searchParams.set(k, String(v));
    const r = await fetch(u, { method, headers: init.json !== undefined ? { "content-type": "application/json" } : init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}, body: init.json !== undefined ? JSON.stringify(init.json) : init.form ? new URLSearchParams(init.form).toString() : undefined });
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* text */
    }
    return { httpStatus: r.status, headers: r.headers, text, body };
  };
  return {
    async getJson<T>(path: string, q?: Record<string, string | number>) {
      return (await req("GET", path, { query: q })).body as T;
    },
    async postJson<T>(path: string, body: unknown) {
      return (await req("POST", path, { json: body })).body as T;
    },
    async postForm<T>(path: string, form: Record<string, string>) {
      return (await req("POST", path, { form })).body as T;
    },
    request: (method, path, init) => req(method, path, init ?? {}),
  };
}

export interface HlVenueState {
  agents: Map<string, { address: string; name: string; validUntil: number }[]>; // owner -> agents
  builderFee: Map<string, number>; // owner:builder -> tenths of a bp
  exchangePosts: unknown[];
  nextOid: number;
}

export function startHlVenue() {
  const st: HlVenueState = { agents: new Map(), builderFee: new Map(), exchangePosts: [], nextOid: 1000 };
  const srv = fakeVenueServer({
    "POST /info": async (r) => {
      const body = (await r.json()) as Record<string, any>;
      const user = String(body.user ?? "").toLowerCase();
      let out: unknown;
      if (body.type === "extraAgents") out = st.agents.get(user) ?? [];
      else if (body.type === "maxBuilderFee") out = st.builderFee.get(`${user}:${String(body.builder).toLowerCase()}`) ?? 0;
      else if (body.type === "approvedBuilders") out = [...st.builderFee.keys()].filter((k) => k.startsWith(user)).map((k) => k.split(":")[1]);
      else if (body.type === "allMids") out = { BTC: "76154.5", ETH: "2500.0" };
      else if (body.type === "userFees") out = { userCrossRate: "0.00045", userAddRate: "0.00015" };
      else out = route(body);
      return Response.json(out);
    },
    "POST /exchange": async (r) => {
      const body = (await r.json()) as { action: Record<string, any>; nonce: number };
      st.exchangePosts.push(body);
      const a = body.action;
      // the fake trusts the signature check the adapter already did and records who approved what
      if (a.type === "approveAgent") {
        const owner = String(a.__owner ?? stack.lastOwner).toLowerCase();
        const [name, until] = String(a.agentName).split(" valid_until ");
        const list = st.agents.get(owner) ?? [];
        list.push({ address: String(a.agentAddress).toLowerCase(), name: name!, validUntil: Number(until ?? T0 + 86_400_000) });
        st.agents.set(owner, list);
      } else if (a.type === "approveBuilderFee") {
        const owner = String(stack.lastOwner).toLowerCase();
        st.builderFee.set(`${owner}:${String(a.builder).toLowerCase()}`, Math.round(Number(String(a.maxFeeRate).replace("%", "")) * 1000));
      } else if (a.type === "order") {
        return Response.json({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: st.nextOid++ } }] } } });
      } else if (a.type === "cancel" || a.type === "cancelByCloid") {
        if (stack.failCancels) return Response.json({ status: "ok", response: { type: "cancel", data: { statuses: [{ error: "Order was never placed, already canceled, or filled." }] } } });
        return Response.json({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } });
      }
      return Response.json({ status: "ok", response: { type: "default" } });
    },
  });
  const stack = { ...srv, st, lastOwner: "" as string, failCancels: false };
  return stack;
}

export type Tamper = {
  venues?: (v: VenueCapabilities[]) => VenueCapabilities[];
  bundle?: (b: OnboardingBundle) => OnboardingBundle;
  build?: (b: UnsignedVenuePayload) => UnsignedVenuePayload;
};

export interface StackOptions {
  port?: number;
  tamper?: Tamper;
  /** The delegation list the server reports in preflight (R4). */
  knownAgents?: string[];
  /** Close-all builds that are NOT reduce-only (a compromised server). */
  closeAllNotReduceOnly?: boolean;
  /** Answer every API call with this status (server unreachable or broken). */
  down?: boolean;
  /**
   * Put the real API's auth gate in front of every route: the committed route table (apps/api route-table.snap.json)
   * gives each path its auth kind, and the real owner_sig and API key verifiers check each request.
   */
  gate?: boolean;
}

export async function startStack(o: StackOptions = {}) {
  const venue = startHlVenue();
  const cfg = { ...HL_MAINNET, infoUrl: `${venue.url}/info`, exchangeUrl: `${venue.url}/exchange`, builderAddress: BUILDER_HL };
  const http = fetchHttp(venue.url);
  const cache = memoryMarketDataCache();
  const reader = createHlReader(cfg, http, cache, { now: () => T0 });
  const bundles = new Map<string, OnboardingBundle>();
  const builds = new Map<string, UnsignedVenuePayload>();
  const killed = new Set<string>();
  const declaration = async (req: { owner: Hex }): Promise<OnboardingStep> => ({
    kind: "eligibility_declaration",
    signer: "main_wallet",
    typedData: {
      domain: { name: "CapstanEligibility", version: "1", chainId: 4663 },
      types: { Declaration: [{ name: "owner", type: "address" }, { name: "statement", type: "string" }, { name: "issuedAt", type: "uint64" }] },
      primaryType: "Declaration",
      message: { owner: req.owner, statement: "I am not a resident or person of the listed countries and regions.", issuedAt: T0 },
    },
  });
  const policyStep = async (req: { owner: Hex; policy?: unknown }): Promise<OnboardingStep | null> => {
    const p = req.policy as Record<string, unknown> | undefined;
    if (!p) return null;
    return {
      kind: "agent_policy",
      signer: "main_wallet",
      typedData: {
        domain: { name: "CapstanAgentPolicy", version: "1", chainId: 4663 },
        types: { AgentPolicy: [{ name: "owner", type: "address" }, { name: "maxNotionalPerOrderUsd", type: "string" }, { name: "maxGrossNotionalUsd", type: "string" }, { name: "maxLeverage", type: "uint32" }, { name: "maxOrdersPerDay", type: "uint32" }, { name: "nonce", type: "string" }] },
        primaryType: "AgentPolicy",
        message: { owner: req.owner, maxNotionalPerOrderUsd: p.maxNotionalPerOrderUsd, maxGrossNotionalUsd: p.maxGrossNotionalUsd, maxLeverage: p.maxLeverage, maxOrdersPerDay: p.maxOrdersPerDay, nonce: p.nonce },
      },
    };
  };
  const asterNonce = new AsterNonce();
  const aster = fakeVenueServer({
    "GET /fapi/v3/positionRisk": () => Response.json([{ symbol: "BTCUSDT", positionAmt: "0.000", entryPrice: "0.0", markPrice: "76147.4", unRealizedProfit: "0.0", leverage: "5", marginType: "cross" }]),
  });
  const adapter: HlAdapter = createAdapter(cfg, {
    http,
    cache,
    reader,
    now: () => T0,
    enabled: () => true,
    onboarding: { declarationStep: declaration as never, policyStep: policyStep as never },
    bundles: { get: (id) => bundles.get(id) ?? null },
    // the kill flag is checked on relay submits below; direct-mode claims of reduce-only closes stay receiptable
    agentState: () => "active",
  });
  const rSigner = nobleSigner(RECEIPT_KEY);
  const rStore = memoryStore();
  const lock = memoryLock();
  let rid = 0;
  const issueR = (d: Parameters<typeof issue>[0]) => issue(d, { store: rStore, signer: rSigner, now: () => new Date(T0), id: () => `r${String(++rid).padStart(6, "0")}`, lock });
  const hits: { method: string; path: string; body: unknown; headers: Record<string, string>; search: string }[] = [];
  const ingests: unknown[] = [];
  const kills: { ref: string; body: unknown }[] = [];
  const t = o.tamper ?? {};
  const apiKeys = new Map<string, string>(); // key -> account id (anonymous keys made by POST /account/keys)
  const issueKey = (): string => {
    const id = `ACCT${apiKeys.size + 1}`.padEnd(26, "0");
    const key = `cpst_${id}_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url").slice(0, 43)}`;
    apiKeys.set(key, id);
    return key;
  };
  let gateApp: Promise<{ fetch(r: Request): Response | Promise<Response> }> | null = null;
  const gateFor = (host: string) =>
    (gateApp ??= (async () => {
      const verifiers = {
        owner_sig: ownerSigVerifier({
          nonces: memoryNonceStore(),
          host,
          now: () => T0,
          agentsOf: async (owner: Hex) => (venue.st.agents.get(owner.toLowerCase()) ?? []).map((a) => ({ address: a.address as Hex, agentRef: `hl:${a.address}` })),
        }),
        api_key: apiKeyVerifier(apiKeyCheck({ verify: async (k) => (apiKeys.has(k) ? { id: apiKeys.get(k)!, ownerWallet: null, tier: "free" } : null), now: () => T0 })),
      };
      // every route of the real table, its auth kind and alternates, in front of a handler that only says "passed"
      const specs = (ROUTE_TABLE as { method: RouteSpec["method"]; path: string; auth: RouteAuth; authAlt?: RouteAuth[]; priced?: string }[]).map(
        (r) => ({ method: r.method, path: r.path.replace(/^\/v1/, ""), auth: r.auth, ...(r.authAlt ? { authAlt: r.authAlt } : {}), ...(r.priced ? { priced: { usd: r.priced } } : {}), handler: () => new Response("passed", { status: 299 }) }) as RouteSpec,
      );
      const { app } = await createApp({ routesDir: mkdtempSync(join(tmpdir(), "capstan-sdk-gate-")), extraRoutes: specs, verifiers });
      return app;
    })());
  const err = (code: string, message: string, status = 400) => Response.json({ error: { code, message } }, { status });

  const server = Bun.serve({
    port: o.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const raw = req.method === "POST" ? await req.text() : "";
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      hits.push({ method: req.method, path: u.pathname, body, headers, search: u.search });
      if (o.down) return new Response("unavailable", { status: 503 });
      if (o.gate) {
        const g = await (await gateFor(u.host.toLowerCase())).fetch(new Request(req.url, { method: req.method, headers: req.headers, ...(raw ? { body: raw } : {}) }));
        if (g.status !== 299) return g;
      }
      const p = u.pathname.replace(/^\/v1/, "");
      try {
        if (p === "/venues") {
          const caps: VenueCapabilities[] = [adapter.caps, { venue: "aster", execution: true, keyType: "secp256k1", delegation: "agent", canWithdraw: false, builderFee: { kind: "aster_code", unit: "decimal_rate", capBps: 10, chargeBps: 2, approvalSignedBy: "main_wallet", builderAddress: BUILDER_ASTER }, collateral: ["USDT"], directSubmitSupported: true, publicAccountReads: false }];
          return Response.json(t.venues ? t.venues(caps) : caps);
        }
        if (p === "/account/keys") {
          if (body?.owner !== null) return err("INVALID_INPUT", "the stand-in API makes anonymous keys only");
          const key = issueKey();
          return Response.json({ id: apiKeys.get(key), key }, { status: 201 });
        }
        if (p === "/onboarding/preflight") return Response.json({ slotsFree: 3, builderApprovedBps: 0, depositRequired: false, eligibility: { allowed: true }, agents: o.knownAgents ?? [] });
        if (p === "/onboarding/build") {
          venue.lastOwner = body.owner;
          let b: OnboardingBundle =
            body.venue === "aster"
              ? asterOnboarding({ owner: body.owner, agentAddress: body.agentAddress, mode: body.mode, ...(body.directIp ? { directIp: body.directIp } : {}), network: "Mainnet", nowMs: T0 }, { relayEgressIp: "203.0.113.7", builder: BUILDER_ASTER, nonce: asterNonce, serverTimeMs: T0, eligibilityStep: await declaration(body), ...(body.policy ? { policyStep: (await policyStep(body))! } : {}) })
              : await adapter.buildOnboarding({ venue: "hyperliquid", owner: body.owner, agentAddress: body.agentAddress, builderMaxBps: body.builderMaxBps, ...(body.policy ? { policy: body.policy } : {}) });
          if (t.bundle) b = t.bundle(structuredClone(b));
          bundles.set(b.bundleId, b);
          return Response.json(b);
        }
        if (p === "/onboarding/submit") {
          const b = bundles.get(body.bundleId)!;
          if (b.venue === "aster") {
            const agent = String((b.steps[1]!.venueTx as { params: [string, unknown][] }).params.find(([k]) => k === "agentAddress")![1]).toLowerCase();
            const agentRef = `aster:${b.owner.toLowerCase()}:${agent}`;
            const r = await issueR(drafts.onboardingComplete({ owner: b.owner, venue: "aster", agentRef, requestHash: sha256Jcs(body), eligibilityDecisionId: "elig-stack" }));
            return Response.json({ delegation: { agentActive: true, builderMaxBps: 3, routing: "ok" }, receiptId: r.receiptId, agentRef });
          }
          const res = await adapter.submitOnboarding(body);
          const r = await issueR(drafts.onboardingComplete({ owner: b.owner, venue: "hyperliquid", agentRef: res.agentRef, requestHash: sha256Jcs(body), eligibilityDecisionId: "elig-stack" }));
          return Response.json({ delegation: res.delegation, receiptId: r.receiptId, agentRef: res.agentRef });
        }
        if (p === "/orders/build" || p === "/orders/cancel/build") {
          const agent = String(body.agentRef).replace(/^hl:/, "") as Hex;
          const ctx = { owner: body.owner, agentRef: body.agentRef, identity: { venue: "hyperliquid" as const, owner: body.owner, agentAddress: agent }, builderFee: { tenthsBp: 20 }, approvedMaxBps: 3, nowMs: T0, eligibilityDecisionId: "elig-stack", policyId: null, mode: body.mode, feeTier: { takerRate: "0.00045", makerRate: "0.00015", source: "base" as const } };
          let b: UnsignedVenuePayload = p === "/orders/build" ? await adapter.buildOrder(body.intent, ctx as never) : await adapter.buildCancel({ marketId: body.marketId, venueOrderId: body.venueOrderId, clientOrderId: body.clientOrderId }, ctx as never);
          if (t.build) b = t.build(structuredClone(b));
          builds.set(b.buildId, b);
          return Response.json(b);
        }
        if (p === "/orders/close-all/build") {
          const out: UnsignedVenuePayload[] = [];
          for (const ref of [...builds.values()].map((b) => (b as HlUnsignedPayload).meta?.agentRef).filter((x, i, a) => x && a.indexOf(x) === i)) {
            const agent = String(ref).replace(/^hl:/, "") as Hex;
            const ctx = { owner: body.owner, agentRef: ref, identity: { venue: "hyperliquid" as const, owner: body.owner, agentAddress: agent }, builderFee: { tenthsBp: 20 }, approvedMaxBps: 3, nowMs: T0, eligibilityDecisionId: "elig-stack", policyId: null, mode: "relay", feeTier: { takerRate: "0.00045", makerRate: "0.00015", source: "base" as const } };
            let c: UnsignedVenuePayload = await adapter.buildOrder({ marketId: "hyperliquid:-:BTC", side: "sell", size: "0.001", type: "market", tif: "ioc", reduceOnly: !o.closeAllNotReduceOnly, maxSlippageBps: 100 }, ctx as never);
            if (t.build) c = t.build(structuredClone(c));
            builds.set(c.buildId, c);
            out.push(c);
          }
          return Response.json(out);
        }
        if (p === "/orders/submit") {
          const b = builds.get(body.buildId) as HlUnsignedPayload | undefined;
          if (!b) return err("NOT_FOUND", "unknown build", 404);
          const env = body.signedEnvelope as SignedEnvelope;
          if (killed.has(b.meta.agentRef)) return err("AGENT_KILLED", "this agent was stopped", 403);
          const v = adapter.verifySigned(env, b);
          if (!v.ok) return err(v.code === "BAD_SIGNATURE" ? "UNAUTHORIZED" : v.code, `${v.code} ${v.field ?? ""}`, 422);
          const res = await adapter.submit(env);
          const rr = await issueR(adapter.toReceiptDraft(b, env, res.venueResponse) as never);
          const kind = b.meta.kind;
          const status = res.status !== "accepted" ? "rejected" : kind === "cancel" ? "cancelled" : "open";
          return Response.json({ order: { venue: "hyperliquid", marketId: b.meta.marketId, venueOrderId: res.venueOrderId ?? "", side: b.preview.side, size: b.preview.size, filled: "0", px: b.preview.px, status, builderFeeBps: b.preview.builderFeeBps, createdAt: new Date(T0).toISOString() }, receiptId: rr.receiptId });
        }
        if (p === "/receipts/claim") {
          const b = builds.get(body.buildId) as HlUnsignedPayload | undefined;
          if (!b) return err("NOT_FOUND", "unknown build", 404);
          const v = adapter.verifySigned(body.signedEnvelope, b);
          if (!v.ok) return err(v.code, String(v.field), 422);
          const d = adapter.toReceiptDraft(b, body.signedEnvelope, body.venueResponse);
          const rr = await issueR({ ...(d as object), action: "order.claim" } as never);
          return Response.json({ receiptId: rr.receiptId });
        }
        let m = /^\/receipts\/([^/]+)$/.exec(p);
        if (m) {
          const r = await rStore.get(m[1]!);
          return r ? Response.json(r) : err("NOT_FOUND", "no receipt", 404);
        }
        m = /^\/receipts\/([^/]+)\/proof$/.exec(p);
        if (m) {
          const r = (await rStore.get(m[1]!)) as Receipt | null;
          if (!r) return err("NOT_FOUND", "no receipt", 404);
          const hour = Math.floor(Date.parse(r.ts) / 3_600_000);
          const rows = await rStore.byHour(hour);
          const tree = buildTree(rows.map((x) => x.leaf));
          const idx = rows.findIndex((x) => x.id === r.receiptId);
          return Response.json({ hourEpoch: hour, proof: proofFor(tree, idx), root: tree.root, leaf: receiptLeaf(r) });
        }
        m = /^\/agents\/([^/]+)\/kill$/.exec(p);
        if (m) {
          const ref = decodeURIComponent(m[1]!);
          killed.add(ref);
          const agent = ref.replace(/^hl:/, "") as Hex;
          kills.push({ ref, body });
          const revocation = await adapter.buildRevocation({ venue: "hyperliquid", owner: venue.lastOwner as Hex, agentAddress: agent });
          let closeAll: UnsignedVenuePayload[] | undefined;
          if (body?.closeAll) {
            const ctx = { owner: venue.lastOwner as Hex, agentRef: ref, identity: { venue: "hyperliquid" as const, owner: venue.lastOwner as Hex, agentAddress: agent }, builderFee: { tenthsBp: 20 }, approvedMaxBps: 3, nowMs: T0, eligibilityDecisionId: "elig-stack", policyId: null, mode: "direct", feeTier: { takerRate: "0.00045", makerRate: "0.00015", source: "base" as const } };
            const c = await adapter.buildOrder({ marketId: "hyperliquid:-:BTC", side: "sell", size: "0.001", type: "market", tif: "ioc", reduceOnly: true, maxSlippageBps: 100 }, ctx as never);
            const tc = t.build ? t.build(c) : c; // a compromised server tampers close-all builds too
            builds.set(tc.buildId, tc);
            closeAll = [tc];
          }
          return Response.json({ relayBlocked: true, revocation, ...(closeAll ? { closeAll } : {}) });
        }
        if (p === "/risk/ingest") {
          ingests.push(body);
          return Response.json({ ok: true });
        }
        return err("NOT_FOUND", `no route ${p}`, 404);
      } catch (e) {
        const code = (e as { code?: string }).code ?? "INTERNAL_ERROR";
        return err(code, (e as Error).message, (e as { status?: number }).status ?? 500);
      }
    },
  });
  return {
    apiBase: `http://127.0.0.1:${server.port}/v1`,
    venue,
    aster,
    ingests,
    kills,
    hits,
    apiKeys,
    /** A key made here, not over HTTP (test setup on a gated stack). */
    issueKey,
    receiptSigner: rSigner.address as Hex,
    receipts: rStore,
    /** The anchor as the chain would answer once each hour is posted: rootOf(hour) is that hour's tree root. */
    anchor: {
      async rootOf(hourEpoch: number) {
        const rows = await rStore.byHour(hourEpoch);
        return rows.length ? (buildTree(rows.map((x) => x.leaf)).root as Hex) : null;
      },
    },
    builds,
    killed,
    stop() {
      server.stop(true);
      venue.stop();
      aster.stop();
    },
  };
}

/** The HL template hash the stack's bundles carry, recomputed by the SDK (and required equal to the adapter's). */
export async function hlTemplatePin(apiBase: string, policy?: unknown, apiKey?: string): Promise<Hex> {
  const r = await fetch(`${apiBase}/onboarding/build`, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ venue: "hyperliquid", owner: labelAddr("sample-owner"), agentAddress: labelAddr("sample-agent"), builderMaxBps: 3, ...(policy ? { policy } : {}) }) });
  const b = await r.json();
  const h = hlTemplateHash(b);
  if (h !== b.templateHash) throw new Error("SDK and adapter template hashes differ");
  return h;
}


/** An SDK client wired to a stack, with test pins (builders, template hashes, the stack's receipt signer). */
export async function sdkClient(stack: Awaited<ReturnType<typeof startStack>>, o: { policy?: unknown; keystore?: import("../src/keys/types").KeyStore; wallet?: import("../src/wallet").WalletSigner; extra?: Partial<import("../src/client").CapstanClientOptions> } = {}) {
  const { createClient } = await import("../src/client");
  const { memoryKeyStore } = await import("../src/keys/memory");
  const { PINS } = await import("../src/pins");
  const { asterTemplateHash } = await import("../src/onboard");
  const { testWallet } = await import("./wallet-fixture");
  const setupKey = stack.issueKey();
  const pins = [await hlTemplatePin(stack.apiBase, undefined, setupKey)];
  if (o.policy) pins.push(await hlTemplatePin(stack.apiBase, o.policy, setupKey));
  const ks = o.keystore ?? memoryKeyStore();
  const wallet = o.wallet ?? testWallet();
  const client = createClient({
    apiBase: stack.apiBase,
    network: "mainnet",
    keystore: ks,
    walletSigner: wallet,
    pinned: { networks: { mainnet: { ...PINS.networks.mainnet, builders: { hyperliquid: BUILDER_HL, aster: BUILDER_ASTER }, templateHashes: { ...PINS.networks.mainnet.templateHashes, hyperliquid: pins, aster: [asterTemplateHash(BUILDER_ASTER, "Mainnet", "0.0003")] }, receiptSigners: [{ address: stack.receiptSigner }] } } },
    venueHosts: { hyperliquid: stack.venue.url, aster: stack.aster.url },
    now: () => T0,
    ...(o.extra ?? {}),
  });
  return { client, ks, wallet };
}
