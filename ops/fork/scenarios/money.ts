// The money path on the fork stack, through the REAL SDK against the running api, relay and workers:
// S3 onboarding on the Hyperliquid stand-in, a relay order with a receipt, the hour closed on the fork clock, the
// anchor job posting the root to the fork's CapstanReceiptAnchor, and /v1/receipts/{id}/verify all true.
import { hyperliquidSource } from "../../../apps/workers/src/jobs/catalog-sources/hyperliquid.source";
import { runCatalogSync } from "../../../apps/workers/src/jobs/catalog-sync.job";
import { anchorBacklog, buildAnchorContext } from "../../../apps/workers/src/anchor";
import { setExecutable } from "@capstan/catalog";
import { hourEpochOf } from "@capstan/receipts";
import { accountWallet, capstanMessage, createClient, hlTemplateHash, memoryKeyStore, PINS, type CapstanClient, type KeyStore, type PinsOverride } from "@capstan/sdk";
import { personalDigest } from "../../../packages/sdk/src/keys/secp";
import { createHash } from "node:crypto";
import type { Hex, OnboardingBundle, OrderIntent, Receipt } from "@capstan/schema";
import { eq } from "drizzle-orm";
import { db as schema } from "@capstan/schema";
import type { PrivateKeyAccount } from "viem/accounts";
import { API, freshWallet, honourRetryAfter, PORTS, revert, RHC, rhc, snapshot, stateAddr, warp, type Row } from "../lib";
import type { Ctx } from "../every-tx";

export const BTC = "hyperliquid:-:BTC";
const HL = `http://127.0.0.1:${PORTS.hl}`;

export async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const r = await honourRetryAfter()(`${API}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  let j: unknown = text;
  try {
    j = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: j as T, headers: r.headers };
}

/** Catalog sync from the stand-in venue, then the review step that makes the test markets executable. */
export async function ensureMarkets(ctx: Ctx, ids: string[] = [BTC]): Promise<void> {
  if (ctx.shared.marketsReady) return;
  await runCatalogSync(ctx.jobDeps(), [hyperliquidSource()]);
  for (const id of ids) {
    const [m] = await ctx.db.select({ executable: schema.markets.executable }).from(schema.markets).where(eq(schema.markets.id, id)).limit(1);
    if (!m) throw new Error(`catalog sync did not list ${id}`);
    if (!m.executable) await setExecutable(ctx.db, id, true, "fork-run", "fork stack: test market made executable for the every-transaction run");
  }
  ctx.shared.marketsReady = true;
}

/** The HL onboarding template the server builds today, for the SDK pins (release pins are filled at launch). */
/** The fork's Hyperliquid template pins: the plain bundle and the agent-safe one (with the agent_policy step). */
async function hlTemplatePins(): Promise<Hex[]> {
  const k = await api<{ key: string }>("POST", "/account/keys", { owner: null });
  if (k.status !== 200 && k.status !== 201) throw new Error(`anonymous key: ${k.status} ${JSON.stringify(k.body)}`);
  const out: Hex[] = [];
  for (const withPolicy of [false, true]) {
    const probe = freshWallet();
    const agent = freshWallet().address.toLowerCase();
    const policy = withPolicy ? { owner: probe.address.toLowerCase(), agents: [{ venue: "hyperliquid", agentRef: `hl:${agent}` }], maxNotionalPerOrderUsd: "1", maxGrossNotionalUsd: "1", maxLeverage: 1, allowedMarkets: "*", allowedVenues: ["hyperliquid"], maxOrdersPerDay: 1, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), nonce: "template-probe" } : undefined;
    const b = await api<OnboardingBundle>("POST", "/onboarding/build", { venue: "hyperliquid", owner: probe.address.toLowerCase(), agentAddress: agent, builderMaxBps: 3, mode: "relay", ...(policy ? { policy } : {}) }, { authorization: `Bearer ${k.body.key}` });
    if (b.status !== 200) throw new Error(`template probe build${withPolicy ? " (policy)" : ""}: ${b.status} ${JSON.stringify(b.body)}`);
    out.push(hlTemplateHash(b.body));
  }
  return out;
}

export async function forkPins(ctx: Ctx): Promise<PinsOverride> {
  if (ctx.shared.pins) return ctx.shared.pins as PinsOverride;
  const pins: PinsOverride = {
    networks: {
      mainnet: {
        ...PINS.networks.mainnet,
        builders: { hyperliquid: stateAddr("builder").toLowerCase() as Hex, aster: null },
        templateHashes: { ...PINS.networks.mainnet.templateHashes, hyperliquid: await hlTemplatePins() },
        receiptSigners: [{ address: stateAddr("receipt").toLowerCase() as Hex }],
        anchor: { chainId: 4663, address: ctx.deployed.anchor.toLowerCase() as Hex },
      },
    },
  };
  ctx.shared.pins = pins;
  return pins;
}

export interface User {
  wallet: PrivateKeyAccount;
  keystore: KeyStore;
  client: CapstanClient;
  agentRef: string;
  onboardReceipt?: string;
}

let nextIp = 10;
/**
 * A fetch that sends one simulated user's address (TEST-NET-1, DE on the fork geo file) in X-Forwarded-For: every
 * user of a real deployment comes from their own address, and the api's per-IP limits must see them that way.
 */
export function userFetch(ip = `192.0.2.${nextIp++ % 250 + 2}`): typeof fetch {
  return honourRetryAfter(((u: string | URL | Request, init?: RequestInit) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-forwarded-for": ip } })) as typeof fetch);
}

/** A fresh user onboarded on Hyperliquid through the real SDK (bundle checked against the pins, signed by the wallet). */
export async function onboardUser(ctx: Ctx, o: { forwardedFor?: string } = {}): Promise<User> {
  const wallet = freshWallet();
  const pinned = await forkPins(ctx);
  const f = userFetch(o.forwardedFor);
  const keystore = memoryKeyStore();
  const client = createClient({ apiBase: API, network: "mainnet", keystore, walletSigner: accountWallet(wallet), pinned, presentSteps: false, venueHosts: { hyperliquid: HL }, anchor: { rpcUrl: RHC, address: ctx.deployed.anchor }, fetch: f });
  const r = await client.onboard("hyperliquid");
  return { wallet, keystore, client, agentRef: r.agentRef, ...(r.receiptId ? { onboardReceipt: r.receiptId } : {}) };
}

export const intentOf = (over: Partial<OrderIntent> = {}): OrderIntent => ({ marketId: BTC, side: "buy", size: "0.001", type: "limit", limitPx: "75000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50, ...over });

export async function receiptOf(id: string): Promise<Receipt> {
  const r = await api<Receipt>("GET", `/receipts/${id}`);
  if (r.status !== 200) throw new Error(`GET /receipts/${id}: ${r.status}`);
  return r.body;
}

/** Close the receipts' hour on the fork: move the chain clock past it and run the anchor job with the clock past it. */
export async function closeHourAndAnchor(ctx: Ctx, hourEpoch: number): Promise<{ hourEpoch: number; status: string; txHash?: Hex }[]> {
  const now = await rhc.getBlock();
  const need = (hourEpoch + 1) * 3600 + 5 - Number(now.timestamp);
  if (need > 0) await warp(need);
  const later = () => new Date(Math.max(Date.now(), (hourEpoch + 1) * 3_600_000 + 5_000));
  const deps = ctx.jobDeps(later);
  const actx = await buildAnchorContext(deps);
  return anchorBacklog({ ...actx, now: later, log: deps.log, publish: deps.publish });
}

export async function s3(ctx: Ctx): Promise<Row[]> {
  const rows: Row[] = [];
  await ensureMarkets(ctx);
  const u = await onboardUser(ctx);
  ctx.shared.user = u;
  const ob = u.onboardReceipt ? await receiptOf(u.onboardReceipt) : null;
  rows.push({ id: "S3", scenario: "onboard Hyperliquid (agent + builder fee approval signed by the test wallet)", ref: "POST /v1/onboarding/submit", gas: "-", result: ob ? "pass" : "fail", receipt: u.onboardReceipt ?? "-", check: ob ? `${ob.action}, agent ${u.agentRef.slice(0, 18)}...` : "no onboarding receipt" });
  const cb = await u.client.buildOrder(intentOf(), "hyperliquid", "relay");
  const sent = await u.client.signAndSubmit(cb);
  if (!sent.receiptId) throw new Error("S3: the order went out but its receipt is pending (receipt-sign did not answer)");
  const sub = { ...sent, receiptId: sent.receiptId };
  const rc = await receiptOf(sub.receiptId);
  const fee = rc.builder as { feeBps?: number; rawUnit?: string; address?: string } | undefined;
  const okFee = fee?.feeBps === 2 && fee.address?.toLowerCase() === stateAddr("builder").toLowerCase();
  rows.push({ id: "S3", scenario: "order build (relay mode), SDK check, sign, submit", ref: `build ${cb.build.buildId}`, gas: "-", result: sub.order.status === "open" && rc.action === "order.submit" && okFee ? "pass" : "fail", receipt: sub.receiptId, check: `order ${sub.order.status} oid ${sub.order.venueOrderId}; builder.feeBps ${fee?.feeBps} (${fee?.rawUnit})` });
  ctx.shared.firstReceipt = sub.receiptId;
  const before = await api<{ valid: boolean; checks: Record<string, unknown> }>("GET", `/receipts/${sub.receiptId}/verify`);
  // the hour is closed by moving the fork clock; it goes back afterwards so later x402 authorizations are not expired
  const snap = await snapshot();
  try {
  const posted = await closeHourAndAnchor(ctx, hourEpochOf(rc.ts));
  const mine = posted.find((p) => p.hourEpoch === hourEpochOf(rc.ts));
  let gas = "-";
  if (mine?.txHash) {
    const t = await rhc.getTransactionReceipt({ hash: mine.txHash });
    gas = String(t.gasUsed);
    ctx.gas["anchor postRoot"] = t.gasUsed;
  }
  rows.push({ id: "S3", scenario: "hour closed (fork clock), merkle-anchor posts the root", ref: mine?.txHash ?? "-", gas, result: mine?.status === "posted" ? "pass" : "fail", receipt: "-", check: `hour ${hourEpochOf(rc.ts)}: ${posted.map((p) => `${p.hourEpoch} ${p.status}`).join(", ") || "nothing to post"}; before posting onChainRoot=${String(before.body?.checks?.onChainRoot)}` });
  const v = await api<{ valid: boolean; checks: Record<string, unknown> }>("GET", `/receipts/${sub.receiptId}/verify`);
  const allTrue = v.status === 200 && v.body.valid === true && Object.values(v.body.checks).every((x) => x === true);
  rows.push({ id: "S3", scenario: "GET /v1/receipts/{id}/verify against the fork anchor", ref: `GET /v1/receipts/${sub.receiptId}/verify`, gas: "-", result: allTrue ? "pass" : "fail", receipt: sub.receiptId, check: JSON.stringify(v.body.checks ?? v.body) });
  const sdkV = await u.client.verifyReceipt(sub.receiptId);
  rows.push({ id: "S3", scenario: "SDK verifyReceipt (offline signature + proof, root read from the fork RPC)", ref: "sdk", gas: "-", result: (sdkV as { valid?: boolean }).valid === true ? "pass" : "fail", receipt: sub.receiptId, check: JSON.stringify((sdkV as { checks?: unknown }).checks ?? sdkV) });
  } finally {
    // the chain no longer holds that root, so the poster's record of it goes too (later receipts in this hour are
    // anchored in a later run, as they would be at the real end of the hour)
    await revert(snap);
    await ctx.resetAnchorHistory();
  }
  return rows;
}

// ---------------------------------------------------------------- S4 direct mode claim
export async function s4(ctx: Ctx): Promise<Row[]> {
  await ensureMarkets(ctx);
  const wallet = freshWallet();
  const pinned = await forkPins(ctx);
  const ks = memoryKeyStore();
  const client = createClient({ apiBase: API, network: "mainnet", keystore: ks, walletSigner: accountWallet(wallet), pinned, presentSteps: false, venueHosts: { hyperliquid: HL }, anchor: { rpcUrl: RHC, address: ctx.deployed.anchor }, fetch: userFetch() });
  await client.onboard("hyperliquid", { mode: "direct" });
  const cb = await client.buildOrder(intentOf({ limitPx: "74000" }), "hyperliquid", "direct");
  const sent = await client.signAndSubmit(cb);
  if (!sent.receiptId) throw new Error("S4: the claim gave no receipt");
  const sub = { ...sent, receiptId: sent.receiptId };
  const rc = await receiptOf(sub.receiptId);
  const rows: Row[] = [{ id: "S4", scenario: "direct mode: SDK posts to the venue itself, then claims", ref: "POST /v1/receipts/claim", gas: "-", result: rc.action === "order.claim" && sub.order.status === "open" ? "pass" : "fail", receipt: sub.receiptId, check: `${rc.action}, order ${sub.order.status} ${sub.order.venueOrderId}` }];
  // a tampered claim: another order's venue answer presented for this build -> refused with a refusal receipt
  const intent2 = intentOf({ limitPx: "73000" });
  const cb2 = await client.buildOrder(intent2, "hyperliquid", "direct");
  // the user's own intent: without it the SDK signs reduce-only orders only (a5bd83c, review-r1:1 F1)
  const env = await client.signer.sign(cb2.build, intent2);
  const forged = { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } } };
  const tamperedEnv = { ...env, signedBody: { ...(env.signedBody as Record<string, unknown>), nonce: Number((env.signedBody as { nonce: number }).nonce) + 1 } };
  const claimBody = { buildId: cb2.build.buildId, signedEnvelope: tamperedEnv, venueResponse: forged };
  const r = await api<{ error?: { code: string; receiptId?: string }; receiptId?: string }>("POST", "/receipts/claim", claimBody, await agentSigHeaders(ks, client, cb2.agentRef, "POST", "/v1/receipts/claim", claimBody));
  const refusal = r.body.error?.receiptId ? await receiptOf(r.body.error.receiptId).catch(() => null) : null;
  rows.push({ id: "S4", scenario: "tampered claim (signed body changed after signing) refused", ref: "POST /v1/receipts/claim", gas: "-", result: r.status >= 400 && r.status < 500 && refusal?.action === "refusal" ? "pass" : "fail", receipt: r.body.error?.receiptId ?? "-", check: `${r.status} ${r.body.error?.code ?? JSON.stringify(r.body).slice(0, 120)}; receipt ${refusal?.action ?? "none"}` });
  return rows;
}

/** owner_sig headers for a raw API call as an agent: the same capstanMessage the SDK signs with the agent key. */
export async function agentSigHeaders(ks: KeyStore, client: CapstanClient, agentRef: string, method: string, path: string, body: unknown): Promise<Record<string, string>> {
  const a = client.agents().find((x) => x.agentRef === agentRef);
  if (!a) throw new Error(`no local agent ${agentRef}`);
  const raw = body === undefined ? "" : JSON.stringify(body);
  const issuedAt = Date.now();
  const text = capstanMessage({ purpose: "api_request", owner: a.owner, host: `127.0.0.1:${PORTS.api}`, chainId: 4663, nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex"), issuedAt, expiresAt: issuedAt + 4 * 60_000, body: `${method} ${path} ${createHash("sha256").update(raw).digest("hex")}` });
  const sig = (await ks.sign(a.keyRef, personalDigest(text))) as Hex;
  return { "x-capstan-message": Buffer.from(text, "utf8").toString("base64"), "x-capstan-signature": sig };
}

// ---------------------------------------------------------------- S8 kill switch
export async function s8(ctx: Ctx): Promise<Row[]> {
  await ensureMarkets(ctx);
  const u = await onboardUser(ctx);
  // a signed order prepared before the kill, as an agent would have in flight
  const intent = intentOf({ limitPx: "72000" });
  const cb = await u.client.buildOrder(intent, "hyperliquid", "relay");
  const env = await u.client.signer.sign(cb.build, intent); // with the user's intent, as an agent holding one would
  const t0 = Date.now();
  const k = await u.client.kill(u.agentRef);
  const killMs = Date.now() - t0;
  const rows: Row[] = [{ id: "S8", scenario: "kill an agent (owner-signed), revocation bundle returned", ref: `POST /v1/agents/${u.agentRef.slice(0, 14)}.../kill`, gas: "-", result: k.relayBlocked && k.serverReached && !!k.revocation && k.keyWiped ? "pass" : "fail", receipt: "-", check: `relayBlocked ${k.relayBlocked}, revocation steps ${k.revocation?.steps.map((s) => s.kind).join("+") ?? "none"}, key wiped, ${killMs} ms${k.error ? `, error ${k.error}` : ""}` }];
  // the in-flight envelope straight onto the relay queue: refused, within 1 s of the kill
  const { relayQueueClient } = await import("@capstan/relay");
  const { createRedis } = await import("@capstan/core");
  const bull = createRedis(process.env.REDIS_URL!, { forBullmq: true });
  const rq = relayQueueClient(bull);
  const t1 = Date.now();
  const res = await rq.submit({ buildId: cb.build.buildId, signedEnvelope: env, ip: "192.0.2.10" }, "free", `fork-kill-${Date.now()}`);
  const ms = Date.now() - t1 + killMs;
  await rq.close();
  await bull.quit().catch(() => undefined);
  const code = "ok" in res && !res.ok ? res.body.error.code : "ok" in res ? "accepted" : "queued";
  rows.push({ id: "S8", scenario: "relay refuses the killed agent's signed order within 1 s", ref: `relay-submit ${cb.build.buildId}`, gas: "-", result: code === "AGENT_KILLED" && ms < 1_000 + killMs ? "pass" : "fail", receipt: "-", check: `${code} after ${Date.now() - t1} ms (kill took ${killMs} ms)` });
  return rows;
}

// ---------------------------------------------------------------- S10 geo refusal
export async function s10(ctx: Ctx): Promise<Row[]> {
  await ensureMarkets(ctx);
  const owner = freshWallet().address.toLowerCase();
  const k = await api<{ key: string }>("POST", "/account/keys", { owner: null });
  const r = await api<{ error: { code: string; message: string; receiptId?: string } }>("POST", "/onboarding/build", { venue: "hyperliquid", owner, agentAddress: freshWallet().address.toLowerCase(), builderMaxBps: 3, mode: "relay" }, { authorization: `Bearer ${k.body.key}`, "x-forwarded-for": "203.0.113.7" });
  const rc = r.body.error?.receiptId ? await receiptOf(r.body.error.receiptId) : null;
  const ok = r.status === 403 && r.body.error.code === "GEO_REFUSED" && r.body.error.message === "Not available in your region." && rc?.action === "refusal";
  const allowed = await api<{ error?: { code: string } }>("POST", "/onboarding/build", { venue: "hyperliquid", owner, agentAddress: freshWallet().address.toLowerCase(), builderMaxBps: 3, mode: "relay" }, { authorization: `Bearer ${k.body.key}`, "x-forwarded-for": "192.0.2.7" });
  return [
    { id: "S10", scenario: "write from a refused country (X-Forwarded-For 203.0.113.7 = US on the fork geo file)", ref: "POST /v1/onboarding/build", gas: "-", result: ok ? "pass" : "fail", receipt: r.body.error?.receiptId ?? "-", check: `${r.status} ${r.body.error?.code}: ${r.body.error?.message}; receipt ${rc?.action ?? "none"}` },
    { id: "S10", scenario: "the same write from an allowed country", ref: "POST /v1/onboarding/build", gas: "-", result: allowed.status === 200 ? "pass" : "fail", receipt: "-", check: `${allowed.status}${allowed.body.error ? ` ${allowed.body.error.code}` : ""}` },
  ];
}

// ---------------------------------------------------------------- S12 quote == build
export async function s12(ctx: Ctx): Promise<Row[]> {
  await ensureMarkets(ctx);
  const u = (ctx.shared.user as User | undefined) ?? (await onboardUser(ctx));
  const rows: Row[] = [];
  let same = 0;
  const diffs: string[] = [];
  for (let i = 0; i < 20; i++) {
    const side = i % 2 === 0 ? "buy" : "sell";
    const size = (0.001 * (1 + (i % 5))).toFixed(3);
    const q = await api<{ requestId: string; legs: { marketId: string; status: string; avgFillPx: string; limitPx: string | null; sizeBase: string; builderFeeBps: number }[] }>("POST", "/quote", { marketIds: [BTC], side, sizeBase: size, leverage: 1, holdHours: 1, orderType: "market", owner: u.wallet.address.toLowerCase() });
    const leg = q.body.legs?.find((l) => l.marketId === BTC);
    if (q.status !== 200 || !leg || leg.status !== "ok" || !leg.limitPx) {
      diffs.push(`#${i} quote ${q.status} ${leg?.status ?? JSON.stringify(q.body).slice(0, 80)}`);
      continue;
    }
    // the order is built from the quote exactly as an agent does: the quote's venue-valid limit and size
    const cb = await u.client.buildOrder(intentOf({ side, size: leg.sizeBase, type: "limit", limitPx: leg.limitPx, tif: "ioc" }), "hyperliquid", "relay");
    const p = cb.build.preview as unknown as { size: string; limitPx: string | null; builderFeeBps: number };
    const order = ((cb.build.payload as { action: { orders: { p: string; s: string }[] } }).action.orders ?? [])[0];
    const eqNum = (a: string | null | undefined, b: string | null | undefined) => a !== null && a !== undefined && b !== null && b !== undefined && Number(a) === Number(b);
    // and the quoted average fill is reachable inside that limit (a buy never above it, a sell never below)
    const reachable = side === "buy" ? Number(leg.avgFillPx) <= Number(leg.limitPx) : Number(leg.avgFillPx) >= Number(leg.limitPx);
    if (eqNum(p.size, leg.sizeBase) && eqNum(p.limitPx, leg.limitPx) && eqNum(order?.s, leg.sizeBase) && eqNum(order?.p, leg.limitPx) && p.builderFeeBps === leg.builderFeeBps && reachable) same++;
    else diffs.push(`#${i} quote ${leg.sizeBase}@${leg.limitPx} (avg ${leg.avgFillPx}) fee ${leg.builderFeeBps} vs build ${p.size}@${p.limitPx} payload ${order?.s}@${order?.p} fee ${p.builderFeeBps}`);
  }
  rows.push({ id: "S12", scenario: "20 quotes: the order built from each quote has its limit, size and builder fee (preview and signed payload); the quoted fill is inside the limit", ref: "POST /v1/quote + /v1/orders/build", gas: "-", result: same === 20 ? "pass" : "fail", receipt: "-", check: `${same}/20 equal${diffs.length ? `; ${diffs.slice(0, 3).join("; ")}` : ""}` });
  const g = (k: string) => (ctx.gas[k] !== undefined ? String(ctx.gas[k]) : "not measured");
  rows.push({ id: "S12", scenario: "gas for the runbooks: anchor postRoot, x402 settles (BACKLOG E4, E5)", ref: "fork receipts", gas: g("anchor postRoot"), result: ctx.gas["anchor postRoot"] !== undefined ? "pass" : "fail", receipt: "-", check: `postRoot ${g("anchor postRoot")}; settle permit2 ${g("x402 rhc permit2")}; settle eip3009 ${g("x402 rhc eip3009")}; settle base ${g("x402 base eip3009")}` });
  return rows;
}
