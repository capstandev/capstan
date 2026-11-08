// Security review r2, D2-ADP-02 (review-r1:7 F1) and D2-ADP-03 (review-r1:7 F2). A kill that covers a Lighter row
// threw because nothing supplied the replacement public key, and an Aster close-all with no stored account read threw;
// either aborted the whole kill (or close-all) for every venue. Now each venue is tried on its own: the Hyperliquid
// revocation and closes always come back, Lighter gets a bundle when the kill sends replacementPubKey (else an
// unavailable entry), and Aster closes are built from the shared account store with no builder fields.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildRevocation as asterRevocation, buildAsterCloseAll, memoryAccountStore, type AsterAccountSnapshot } from "@capstan/adapter-aster";
import { buildRevocation as hlRevocation, capstanAgentName, DEFAULT_SIGNATURE_CHAIN_ID } from "@capstan/adapter-hyperliquid";
import { createLighterAdapter, LIGHTER_CONFIGS } from "@capstan/adapter-lighter";
import { closeDb, createDb, createTempDatabase, schema, type Db } from "@capstan/core";
import { buildKillResponse, type KillAdapter } from "@capstan/policy";
import type { BuildContext, Hex, UnsignedVenuePayload, VenueId, VenueIdentity } from "@capstan/schema";
import { AsterNonce } from "../../../../packages/signers/aster/src";
import { createMemoryGovernor, fakeVenueServer, venueHttp } from "@capstan/venue-client";
import { AgentKillZ } from "@capstan/schema";
import { createRedis } from "@capstan/core";
import { redisAccountStore } from "@capstan/adapter-aster";
import { composeAdapters } from "../../src/adapters";

const PG = process.env.DATABASE_URL;
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const OWNER = "0x00000000000000000000000000000000000c0de1" as Hex;
const AGENT = "0x00000000000000000000000000000000000a6e71" as Hex;
const OTHER = "0x00000000000000000000000000000000000b0b01" as Hex;
const NEW_KEY = "ab".repeat(40);

const caps = (venue: VenueId) => ({ venue, execution: true, keyType: "secp256k1" as const, delegation: "agent" as const, canWithdraw: false as const, builderFee: null, collateral: ["USDC"], directSubmitSupported: true, publicAccountReads: true });
const closeBuild = (id: VenueIdentity): UnsignedVenuePayload => ({
  buildId: "01JCLOSE00000000000000000",
  venue: id.venue,
  signer: "delegated_key",
  encoding: "hl_l1_action",
  payload: { type: "order", orders: [{ a: 1, b: false, r: true }] },
  digest: "0x00",
  preview: { marketId: "hyperliquid:-:ETH", side: "sell", size: "1", px: "1900", notionalUsd: "1900", venueFeeBps: 4.5, builderFeeBps: 0, builderFee: null, slippageBps: 50, estLiqPx: null, collateralAsset: "USDC", reduceOnly: true, warnings: [] },
  expiresAt: NOW + 30_000,
  eligibilityDecisionId: "not-required:kill",
});

const hl: KillAdapter = {
  caps: caps("hyperliquid"),
  buildRevocation: (id) => hlRevocation({ ...id, agentName: capstanAgentName(id.agentAddress!) }, { network: "Testnet", signatureChainId: DEFAULT_SIGNATURE_CHAIN_ID, nowMs: NOW, throwawayAgent: OTHER, builder: OTHER, builderRevokeConfirmed: false }),
  buildCloseAll: async (id) => [closeBuild(id)],
};

/** The real Aster close-all on an account store, as the adapter runs it (no stored read: needs_signed_read). */
function asterWith(store: ReturnType<typeof memoryAccountStore>): KillAdapter {
  const market = { id: "aster:-:BTCUSDT", venue: "aster", status: "active", tickSize: "0.1", lotSize: "0.001", minNotional: "5", collateralAsset: "USDT" } as never;
  return {
    caps: caps("aster"),
    buildRevocation: async (id) => asterRevocation(id.owner, id.agentAddress!, { builder: OTHER, nonce: new AsterNonce(), network: "Testnet", nowMs: NOW }),
    buildCloseAll: async (id, ctx: BuildContext) =>
      buildAsterCloseAll(id, { ...ctx, snapshot: (await store.get(id.owner))?.snapshot ?? null }, { network: "Testnet", builder: OTHER, market: async () => market, book: async () => ({ marketId: "aster:-:BTCUSDT", bids: [["76000.0", "5"]], asks: [["76010.0", "5"]], ts: NOW }) as never, nonceFor: () => new AsterNonce() }),
  };
}

const pg = PG ? describe : describe.skip;
pg("security r2 kill and close-all per venue", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let lighterSrv: ReturnType<typeof fakeVenueServer>;
  let lighter: KillAdapter;
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_sec_r2_kill" });
    db = createDb(t.url, { max: 2 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
    await db.insert(schema.delegations).values([
      { id: "hl-k", venue: "hyperliquid", owner: OWNER, agentAddress: AGENT, state: "active" },
      { id: "aster-k", venue: "aster", owner: OWNER, agentAddress: AGENT, state: "active" },
      { id: "lt-k", venue: "lighter-mainnet", owner: OWNER, accountIndex: 99, apiKeyIndex: 4, state: "active" },
    ]);
    lighterSrv = fakeVenueServer({ "GET /api/v1/nextNonce": () => Response.json({ code: 200, nonce: 12 }) });
    const cfg = LIGHTER_CONFIGS.mainnet;
    lighter = createLighterAdapter(cfg, { http: venueHttp(cfg.governorKey, lighterSrv.url, createMemoryGovernor("t"), { maxTries: 1 }), cache: null, execution: true, now: () => NOW }) as unknown as KillAdapter;
  }, 60_000);
  afterAll(async () => {
    lighterSrv?.stop();
    await drop?.();
  }, 60_000);

  test("lighter-kill-needs-and-uses-the-replacement-key", async () => {
    const adapters = new Map<VenueId, KillAdapter>([["lighter-mainnet", lighter]]);
    const without = await buildKillResponse("lt-k", { adapters, db, closeAll: false, now: () => NOW });
    expect(without.revocations.length).toBe(0);
    expect(without.unavailable.map((u) => u.venue)).toEqual(["lighter-mainnet"]);
    const withKey = await buildKillResponse("lt-k", { adapters, db, closeAll: false, now: () => NOW, replacementPubKey: NEW_KEY });
    expect(withKey.revocation?.venue).toBe("lighter-mainnet");
    expect(JSON.stringify(withKey.revocation)).toContain(NEW_KEY);
    // the route accepts the key (40 bytes of hex) and nothing else
    expect(AgentKillZ.safeParse({ sig: `0x${"11".repeat(65)}`, message: "m", replacementPubKey: NEW_KEY }).success).toBe(true);
    expect(AgentKillZ.safeParse({ sig: `0x${"11".repeat(65)}`, message: "m", replacementPubKey: "abcd" }).success).toBe(false);
  });

  test("one-failing-venue-never-costs-the-others", async () => {
    const store = memoryAccountStore(() => NOW);
    const adapters = new Map<VenueId, KillAdapter>([
      ["hyperliquid", hl],
      ["aster", asterWith(store)],
    ]);
    // no Aster account read stored: the Aster close cannot be built, HL still comes back whole
    const r = await buildKillResponse("hl-k", { adapters, db, closeAll: true, now: () => NOW });
    expect(r.revocations.map((b) => b.venue).sort()).toEqual(["aster", "hyperliquid"]);
    expect(r.closeAll?.map((p) => p.venue)).toEqual(["hyperliquid"]);
    expect(r.unavailable.map((u) => u.venue)).toEqual(["aster"]);
    expect(r.unavailable[0]!.reason).toContain("needs_signed_read");
    // with a fresh positions read in the shared store, the kill (approvedMaxBps null) builds the Aster close with no
    // builder fields instead of BUILDER_APPROVAL_REQUIRED
    const snap: AsterAccountSnapshot = { venue: "aster", identity: { venue: "aster", owner: OWNER, agentAddress: AGENT }, equityUsd: "100", freeCollateralUsd: "50", asOf: new Date(NOW - 5_000).toISOString(), positionsAsOf: new Date(NOW - 5_000).toISOString(), source: "relay_read", positionsSource: "relay_read", positions: [{ venue: "aster", marketId: "aster:-:BTCUSDT", canonicalAsset: null, side: "long", size: "0.01", entryPx: "70000", markPx: "76000", liqPx: null, liqPxSource: "venue", notionalUsd: "760", unrealizedPnlUsd: "60", collateralAsset: "USDT", marginMode: "cross", leverage: 5 } as never] };
    await store.put(OWNER, { snapshot: snap, openOrders: null }, 60_000);
    const r2 = await buildKillResponse("hl-k", { adapters, db, closeAll: true, now: () => NOW });
    expect(r2.unavailable).toEqual([]);
    const asterClose = r2.closeAll!.find((p) => p.venue === "aster")!;
    expect(asterClose.preview.reduceOnly).toBe(true);
    expect(asterClose.preview.builderFeeBps).toBe(0);
    const params = (asterClose.payload as { params: [string, string][] }).params.map(([k]) => k);
    expect(params).not.toContain("builder");
    expect(params).not.toContain("feeRate");
  });
});

(process.env.REDIS_URL ? test : test.skip)("api-aster-adapter-reads-the-shared-account-store", async () => {
  // risk-ingest writes the Redis store; the api's Aster adapter must read the same one (it used a private memory store)
  const redis = createRedis(process.env.REDIS_URL!);
  const owner = `0x${Date.now().toString(16).padStart(40, "0")}` as Hex;
  try {
    const snap = { venue: "aster", identity: { venue: "aster", owner, agentAddress: AGENT }, equityUsd: "1", freeCollateralUsd: "1", positions: [], asOf: new Date().toISOString(), source: "relay_read" } as AsterAccountSnapshot;
    await redisAccountStore(redis).put(owner, { snapshot: snap, openOrders: [] }, 60_000);
    const { adapters } = await composeAdapters({ CAPSTAN_NETWORK: "testnet" }, { db: null, redis });
    const got = await adapters.get("aster")!.getAccount({ venue: "aster", owner, agentAddress: AGENT });
    expect(got.equityUsd).toBe("1");
  } finally {
    await redis.quit();
  }
}, 30_000);
