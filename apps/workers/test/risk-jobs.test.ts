// Todo 19 jobs: risk-refresh publishes each snapshot read from the venue on the account channel (cached reads are
// not re-published); risk-compute writes risk_snapshots for owners with routed orders and open positions, publishes
// the change and a liquidation-distance event for positions within 10% of their own venue's liquidation price.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, PUBSUB, schema, type Db } from "@capstan/core";
import { memoryCatalog } from "@capstan/quote";
import { BANNER, buildRiskView, memoryKv, type AccountAdapter } from "@capstan/risk";
import type { AccountSnapshot, Hex, VenueId } from "@capstan/schema";
import { eq } from "drizzle-orm";
import { job as computeJob, riskDelta, runRiskCompute } from "../src/jobs/risk-compute.job";
import { job as refreshJob, runRiskRefresh } from "../src/jobs/risk-refresh.job";

const PG = process.env.DATABASE_URL;
const NOW = new Date("2026-11-01T12:00:00.000Z");
const A = "0x00000000000000000000000000000000000000a1" as Hex;
const B = "0x00000000000000000000000000000000000000b2" as Hex;
const caps = (venue: VenueId) => ({ venue, execution: true, keyType: "secp256k1" as const, delegation: "agent" as const, canWithdraw: false as const, builderFee: null, collateral: ["USDC"], directSubmitSupported: true, publicAccountReads: true });
const snapOf = (owner: Hex, liqPx: string | null): AccountSnapshot => ({ venue: "hyperliquid", identity: { venue: "hyperliquid", owner }, equityUsd: "100", freeCollateralUsd: "50", positions: liqPx === "none" ? [] : [{ venue: "hyperliquid", marketId: "hyperliquid:-:ETH", canonicalAsset: null, side: "long", size: "1", entryPx: "2000", markPx: "2000", notionalUsd: "2000", leverage: 10, marginMode: "isolated", liqPx, liqPxSource: "venue", marginRatio: null, unrealisedPnlUsd: "0", collateralAsset: "USDC", asOf: NOW.toISOString() }], asOf: NOW.toISOString() });

describe("risk jobs", () => {
  test("definitions", () => {
    expect(refreshJob).toMatchObject({ name: "risk-refresh", queue: "riskRefresh" });
    expect(refreshJob.schedule).toBeUndefined(); // on demand
    expect(computeJob).toMatchObject({ name: "risk-compute", queue: "riskCompute", schedule: { every: 300_000 }, concurrency: 1 });
  });

  test("risk-refresh publishes refreshed snapshots on the account channel", async () => {
    const published: [string, unknown][] = [];
    let reads = 0;
    const hl: AccountAdapter = { caps: caps("hyperliquid"), getAccount: async (id) => (reads++, snapOf(id.owner, "1800")) };
    const accounts = { adapters: new Map<VenueId, AccountAdapter>([["hyperliquid", hl]]), cache: memoryKv(() => NOW.getTime()), asterIngested: async () => null };
    const d = { identities: async (o: Hex) => [{ venue: "hyperliquid" as const, owner: o }, { venue: "aster" as const, owner: o }], accounts, publish: async (c: string, p: unknown) => void published.push([c, p]) };
    expect(await runRiskRefresh(A, d)).toEqual({ refreshed: 1, cached: 0, pending: 1 });
    expect(published.map(([c]) => c)).toEqual([PUBSUB.account(A)]);
    expect((published[0]![1] as { venue: string }).venue).toBe("hyperliquid");
    // within 5 s: served from cache, nothing new published, no venue read
    expect(await runRiskRefresh(A, d)).toEqual({ refreshed: 0, cached: 1, pending: 1 });
    expect(published.length).toBe(1);
    expect(reads).toBe(1);
  });

  test("delta lists new, moved and closed positions", async () => {
    const v1 = await buildRiskView(A, [], [snapOf(A, "1800")], new Map(), memoryCatalog([]), NOW);
    const v2 = await buildRiskView(A, [], [snapOf(A, "1810")], new Map(), memoryCatalog([]), NOW);
    expect(riskDelta(null, v1).changed.length).toBe(1);
    expect(riskDelta(v1, v1).changed).toEqual([]);
    expect(riskDelta(v1, v2).changed.map((r) => r.distancePct)).toEqual([9.5]);
    const v3 = await buildRiskView(A, [], [snapOf(A, "none")], new Map(), memoryCatalog([]), NOW);
    expect(riskDelta(v1, v3).closed).toEqual(["hyperliquid:-:ETH"]);
  });
});

(PG ? describe : describe.skip)("risk-compute with a database", () => {
  let t: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  beforeAll(async () => {
    t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_riskc" });
    db = createDb(t.url, { max: 2 });
    for (const [i, owner] of [A, B].entries()) {
      await db.insert(schema.orderBuilds).values({ id: `b${i}`, owner, venue: "hyperliquid", marketId: "hyperliquid:-:ETH", intent: {}, payload: {}, preview: {}, eligibilityDecisionId: "e", expiresAt: NOW });
      await db.insert(schema.orders).values({ id: `o${i}`, buildId: `b${i}`, venue: "hyperliquid", marketId: "hyperliquid:-:ETH", owner, signedPayloadHash: `0x${String(i).repeat(4)}`, mode: "relay", status: "filled", builderFeeBps: 2, submittedAt: new Date(NOW.getTime() - 86_400_000) });
    }
  }, 60_000);
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  }, 60_000);

  test("writes snapshots, publishes deltas and liquidation-distance events", async () => {
    const published: [string, Record<string, unknown>][] = [];
    const views = new Map<string, AccountSnapshot>([[A, snapOf(A, "1820")], [B, snapOf(B, "none")]]);
    const view = (o: Hex) => buildRiskView(o, [], [views.get(o.toLowerCase())!], new Map(), memoryCatalog([]), NOW);
    const seen: string[] = [];
    const d = { db, view, publish: async (c: string, p: unknown) => void published.push([c, p as Record<string, unknown>]), onView: async (o: Hex) => void seen.push(o), now: () => NOW };
    expect(await runRiskCompute(d)).toEqual({ owners: 2, written: 1, events: 1 });
    const rows = await db.select().from(schema.riskSnapshots).where(eq(schema.riskSnapshots.owner, A));
    expect(rows.length).toBe(1);
    expect((rows[0]!.view as { banner: string }).banner).toBe(BANNER);
    expect(await db.select().from(schema.riskSnapshots).where(eq(schema.riskSnapshots.owner, B))).toEqual([]); // no open position
    expect(published.map(([c, p]) => [c, p.kind])).toEqual([
      [PUBSUB.risk(A), "delta"],
      [PUBSUB.risk(A), "liq_distance"],
    ]);
    expect(published[1]![1]).toMatchObject({ marketId: "hyperliquid:-:ETH", venue: "hyperliquid", distancePct: 9 });
    expect(seen).toEqual([A]);
  });
});
