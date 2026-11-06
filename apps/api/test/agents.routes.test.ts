// R11 (todo 22): every kill writes kill_events and an agent.kill receipt. Also: kill auth at the route (owner,
// self-halt, stranger, stale, replay), and the policy route (store, nonce reuse, bad signature).
// Needs DATABASE_URL and REDIS_URL (skips without them).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { capstanMessage, closeDb, createDb, createRedis, createTempDatabase, memoryNonceStore, schema, type Db, type Redis } from "@capstan/core";
import { policyTypedData, redisKillSwitch, type KillAdapter } from "@capstan/policy";
import { createReceiptService } from "@capstan/receipts";
import type { AgentPolicy, OnboardingBundle, UnsignedVenuePayload, VenueId } from "@capstan/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { testReceiptSigner, testWallet } from "../../../packages/policy/test/accounts";
import { createAgentRoutes, KILL_ELIGIBILITY_ID, type AgentRouteDeps } from "../src/routes/agents.routes";

const PG = process.env.DATABASE_URL;
const REDIS = process.env.REDIS_URL;
const HOST = "api.capstan.test";
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const owner = testWallet("route owner");
const agent = testWallet("route agent");
const stranger = testWallet("route stranger");

const caps = (venue: VenueId) => ({ venue, execution: true, keyType: "secp256k1" as const, delegation: "agent" as const, canWithdraw: false as const, builderFee: null, collateral: ["USDC"], directSubmitSupported: true, publicAccountReads: true });
const revocation = (venue: VenueId): OnboardingBundle => ({ bundleId: `rev-${venue}`, venue, owner: owner.address, steps: [{ kind: "revoke_agent", signer: "main_wallet", typedData: { domain: { name: "HyperliquidSignTransaction" }, types: {}, primaryType: "HyperliquidTransaction:ApproveAgent", message: {} } }], humanReadable: ["Stop the agent."], templateHash: "0x00", expiresAt: NOW + 60_000 });
const close: UnsignedVenuePayload = { buildId: "01JCLOSE00000000000000000", venue: "hyperliquid", signer: "delegated_key", encoding: "hl_l1_action", payload: {}, digest: "0x00", preview: { marketId: "hyperliquid:-:ETH", side: "sell", size: "1", px: "1900", notionalUsd: "1900", venueFeeBps: 4.5, builderFeeBps: 0, builderFee: null, slippageBps: 50, estLiqPx: null, collateralAsset: "USDC", reduceOnly: true, warnings: [] }, expiresAt: NOW + 30_000, eligibilityDecisionId: KILL_ELIGIBILITY_ID };
const hl: KillAdapter = { caps: caps("hyperliquid"), buildRevocation: async () => revocation("hyperliquid"), buildCloseAll: async () => [close] };

const d = PG && REDIS ? describe : describe.skip;
d("agents routes", () => {
  let tmp: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  let redis: Redis;
  let h: Hono;
  let deps: AgentRouteDeps;
  const run = Date.now().toString(36);
  const ref = `hl:${run}:${agent.address.toLowerCase()}`;
  const ref2 = `hl:${run}:second`;

  beforeAll(async () => {
    tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_agents" });
    db = createDb(tmp.url, { max: 4 });
    redis = createRedis(REDIS!);
    await db.insert(schema.delegations).values([
      { id: ref, venue: "hyperliquid", owner: owner.address, agentAddress: agent.address, state: "active" },
      { id: ref2, venue: "hyperliquid", owner: owner.address, agentAddress: stranger.address, state: "active" },
    ]);
    const svc = createReceiptService({ db, signer: await testReceiptSigner(), now: () => new Date(NOW) });
    deps = { db, killSwitch: redisKillSwitch(redis, db, { now: () => new Date(NOW) }), nonces: memoryNonceStore(), receipts: { issue: async (dr) => ({ receiptId: (await svc.issue(dr)).receiptId }) }, adapters: new Map([["hyperliquid", hl]]), host: HOST, now: () => NOW };
    h = new Hono();
    for (const r of createAgentRoutes(() => deps)) h.on(r.method, `/v1${r.path}`, (c) => r.handler(c));
  }, 60_000);
  afterAll(async () => {
    await redis?.quit();
    if (db) await closeDb(db);
    await tmp?.drop();
  }, 60_000);

  const post = (path: string, body: unknown) => h.request(`/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let nonceN = 0;
  async function kill(agentRef: string, signer = owner, o: { issuedAt?: number; closeAll?: boolean; nonce?: string } = {}) {
    const issuedAt = o.issuedAt ?? NOW - 2000;
    const message = capstanMessage({ purpose: "kill", owner: owner.address, host: HOST, chainId: 4663, nonce: o.nonce ?? `route-kill-${run}-${nonceN++}`, issuedAt, expiresAt: issuedAt + 300_000, body: agentRef });
    return { message, sig: await signer.signMessage({ message }), ts: issuedAt, closeAll: o.closeAll };
  }

  test("receipt", async () => {
    const body = await kill(ref, owner, { closeAll: true });
    const res = await post(`/agents/${encodeURIComponent(ref)}/kill`, body);
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown> & { revocation: OnboardingBundle; closeAll: UnsignedVenuePayload[]; receiptId: string };
    expect(j.relayBlocked).toBe(true);
    expect(j.by).toBe("owner");
    expect(j.revocation.venue).toBe("hyperliquid");
    expect(j.closeAll.length).toBe(1);
    expect(String(j.note)).toContain("only your wallet");
    expect(await deps.killSwitch.isKilled(ref)).toBe(true);
    // kill_events row and the agent.kill receipt
    const evs = await db.select().from(schema.killEvents).where(eq(schema.killEvents.agentRef, ref));
    expect(evs.map((e) => [e.owner, e.by])).toEqual([[owner.address.toLowerCase(), "owner"]]);
    const rc = await db.select().from(schema.receipts).where(eq(schema.receipts.id, j.receiptId));
    expect(rc.length).toBe(1);
    expect(rc[0]!.action).toBe("agent.kill");
    const rb = rc[0]!.body as Record<string, unknown>;
    expect(rb.agentRef).toBe(ref);
    expect(rb.owner).toBe(owner.address.toLowerCase());
    expect(rb.eligibilityDecisionId).toBe(KILL_ELIGIBILITY_ID);
    const [dg] = await db.select().from(schema.delegations).where(eq(schema.delegations.id, ref));
    expect(dg!.state).toBe("killed");

    // the same message again: harmless, no new event or receipt
    const again = await post(`/agents/${encodeURIComponent(ref)}/kill`, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ relayBlocked: true, replayed: true });
    expect((await db.select().from(schema.killEvents).where(eq(schema.killEvents.agentRef, ref))).length).toBe(1);
    expect((await db.select().from(schema.receipts).where(eq(schema.receipts.action, "agent.kill"))).length).toBe(1);

    // a fresh kill of a killed agent: another event and receipt, still killed
    const fresh = await post(`/agents/${encodeURIComponent(ref)}/kill`, await kill(ref));
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as { alreadyKilled: boolean }).alreadyKilled).toBe(true);
    expect((await db.select().from(schema.killEvents).where(eq(schema.killEvents.agentRef, ref))).length).toBe(2);
    expect((await db.select().from(schema.receipts).where(eq(schema.receipts.action, "agent.kill"))).length).toBe(2);
  });

  test("kill auth at the route", async () => {
    // a stranger cannot kill; a stale message cannot kill; an unknown agent is 404
    expect((await post(`/agents/${encodeURIComponent(ref2)}/kill`, await kill(ref2, testWallet("nobody")))).status).toBe(401);
    expect((await post(`/agents/${encodeURIComponent(ref2)}/kill`, await kill(ref2, owner, { issuedAt: NOW - 301_000 }))).status).toBe(401);
    expect((await post(`/agents/nope/kill`, await kill("nope"))).status).toBe(404);
    // a message signed for another agent ref does not kill this one
    expect((await post(`/agents/${encodeURIComponent(ref2)}/kill`, await kill(ref))).status).toBe(401);
    expect(await deps.killSwitch.isKilled(ref2)).toBe(false);
    // self-halt: the agent's own key (ref2's agent address is the stranger wallet)
    const res = await post(`/agents/${encodeURIComponent(ref2)}/kill`, await kill(ref2, stranger));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { by: string }).by).toBe("agent");
    expect(await deps.killSwitch.isKilled(ref2)).toBe(true);
    // ts must equal the signed issue time
    const b = await kill(ref2);
    expect((await post(`/agents/${encodeURIComponent(ref2)}/kill`, { ...b, ts: b.ts + 1 })).status).toBe(400);
  });

  test("policy route: store, nonce reuse, bad signature", async () => {
    const p: AgentPolicy = { owner: owner.address, agents: [{ venue: "hyperliquid", agentRef: ref2 }], maxNotionalPerOrderUsd: "100", maxGrossNotionalUsd: "1000", maxLeverage: 3, allowedMarkets: "*", allowedVenues: ["hyperliquid"], maxOrdersPerDay: 20, expiresAt: new Date(NOW + 86_400_000).toISOString(), nonce: `route-policy-${run}` };
    const ownerSig = await owner.signTypedData(policyTypedData(p) as never);
    const ok = await post("/agents/policy", { policy: p, ownerSig });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { policyId: string }).policyId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const reuse = await post("/agents/policy", { policy: p, ownerSig });
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: { message: string } }).error.message).toContain("nonce");
    const p2 = { ...p, nonce: `route-policy-${run}-2` };
    const bad = await post("/agents/policy", { policy: p2, ownerSig: await stranger.signTypedData(policyTypedData(p2) as never) });
    expect(bad.status).toBe(401);
    expect((await post("/agents/policy", { policy: { ...p, maxLeverage: 0 }, ownerSig })).status).toBe(400);
  });
});
