// Order and claim routes (todo 30): build stores an unsigned payload in order_builds and refuses data-only venues,
// non-executable markets and policy breaches with a refusal receipt id; submit runs the relay pipeline on the stored
// build; cancel and close-all builds; direct-mode claim. Needs DATABASE_URL (skips without it).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, schema, type Db, type RouteSpec } from "@capstan/core";
import type { HlUnsignedPayload } from "@capstan/adapter-hyperliquid";
import { handleClaim, inProcessRelayClient, pgRelayStore } from "@capstan/relay";
import { STANDARD_FEE } from "@capstan/plans";
import type { VenueAdapter } from "@capstan/schema";
import { eq } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign as hlSign } from "../../../packages/adapters/hyperliquid/test/orders/util";
import { AGENT, HL_REF, NOW, policyFor, relayStack, USER_A } from "../../relay/test/helpers";
import { trustedOwner } from "./gw-helpers";
import { createApp } from "../src/app";
import type { BuildAdapter } from "../src/adapters";
import { createOrderRoutes, type OrdersRouteDeps } from "../src/routes/orders.routes";
import { createClaimRoutes } from "../src/routes/receipts-claim.routes";

const PG = process.env.DATABASE_URL;
const d = PG ? describe : describe.skip;

d("order routes", () => {
  let tmp: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  let s: ReturnType<typeof relayStack>;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  const dataOnly = { caps: { venue: "variational", execution: false, keyType: null, delegation: "none", canWithdraw: false, builderFee: null, collateral: ["USDC"], directSubmitSupported: false, publicAccountReads: true } } as unknown as BuildAdapter;

  beforeAll(async () => {
    tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_orders" });
    db = createDb(tmp.url, { max: 6 });
    s = relayStack();
    const pg = pgRelayStore(db);
    s.deps.store = pg;
    await db.insert(schema.delegations).values([
      { id: HL_REF, venue: "hyperliquid", owner: USER_A, agentAddress: AGENT, builderMaxBps: 3, state: "active" },
      { id: "hl:policy-route", venue: "hyperliquid", owner: USER_A, agentAddress: "0x00000000000000000000000000000000000000d2", builderMaxBps: 3, state: "active" },
      { id: "variational:route", venue: "variational", owner: USER_A, agentAddress: "0x00000000000000000000000000000000000000d1", state: "active" },
    ]);
    s.policies.set("hl:policy-route", { policyId: "pol-route", policy: policyFor("hl:policy-route", { maxNotionalPerOrderUsd: "5" }) });
    const deps: OrdersRouteDeps = {
      db,
      adapters: new Map([
        ["hyperliquid", s.builder.adapter as unknown as BuildAdapter],
        ["variational", dataOnly],
      ]),
      relay: inProcessRelayClient(s.deps),
      claim: (r) => handleClaim(r, s.deps),
      policy: s.deps.policy,
      usage: pg.agentUsage,
      issue: async (dr) => ({ receiptId: (await s.receipts.issue(dr)).receiptId }),
      alerts: s.deps.alerts,
      feeOf: async () => STANDARD_FEE,
      laneOf: async () => "pro",
      isExecutable: async (m) => m !== "hyperliquid:-:ETH",
      ipOf: () => "203.0.113.90",
      now: () => NOW,
    };
    const routes: RouteSpec[] = [...createOrderRoutes(() => deps), ...createClaimRoutes(() => deps)];
    ({ app } = await createApp({
      routesDir: mkdtempSync(join(tmpdir(), "capstan-routes-")),
      extraRoutes: routes,
      verifiers: { owner_sig: trustedOwner, api_key: trustedOwner },
      edge: () => async (c, next) => {
        (c as unknown as { set(k: string, v: unknown): void }).set("eligibilityDecisionId", "elig-route");
        await next();
      },
    }));
  }, 60_000);
  afterAll(async () => {
    s?.stop();
    if (db) await closeDb(db);
    await tmp?.drop();
  }, 60_000);

  const post = (path: string, body: unknown) => app.request(`/v1${path}`, { method: "POST", headers: { "content-type": "application/json", "x-test-owner": (body as { owner?: string } | null)?.owner ?? USER_A }, body: JSON.stringify(body) });
  const intent = (o: Record<string, unknown> = {}) => ({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50, ...o });

  test("build, submit and claim", async () => {
    const r = await post("/orders/build", { owner: USER_A, agentRef: HL_REF, intent: intent(), mode: "relay" });
    expect(r.status).toBe(200);
    const b = (await r.json()) as HlUnsignedPayload;
    expect(b.signer).toBe("delegated_key");
    expect(b.eligibilityDecisionId).toBe("elig-route");
    expect(b.meta.builder).toMatchObject({ f: 20 });
    const [row] = await db.select().from(schema.orderBuilds).where(eq(schema.orderBuilds.id, b.buildId));
    expect(row!.owner).toBe(USER_A.toLowerCase());
    // submit through the relay on the stored build
    const sub = await post("/orders/submit", { buildId: b.buildId, signedEnvelope: hlSign(b) });
    expect(sub.status).toBe(200);
    const out = (await sub.json()) as { receiptId: string; order: { status: string } };
    expect(out.order.status).toBe("open");
    expect(s.receipts.byId(out.receiptId)!.action).toBe("order.submit");
    // a second submit of the same payload is a duplicate with its own refusal receipt
    const dup = await post("/orders/submit", { buildId: b.buildId, signedEnvelope: hlSign(b) });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string; receiptId?: string } }).error).toMatchObject({ code: "DUPLICATE_PAYLOAD" });

    // direct mode: build, claim twice, one receipt
    const r2 = await post("/orders/build", { owner: USER_A, agentRef: HL_REF, intent: intent({ size: "0.002" }), mode: "direct" });
    const b2 = (await r2.json()) as HlUnsignedPayload;
    const claim = { buildId: b2.buildId, signedEnvelope: hlSign(b2), venueResponse: { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 5 } }] } } } };
    const c1 = (await (await post("/receipts/claim", claim)).json()) as { receiptId: string };
    const c2 = (await (await post("/receipts/claim", claim)).json()) as { receiptId: string };
    expect(c1.receiptId).toBe(c2.receiptId);
    expect(s.receipts.byId(c1.receiptId)!.action).toBe("order.claim");
  });

  test("funnel-emitted: an order build, its signed submit and the relay submit move the order funnel (todo 37)", async () => {
    const { metricsHandler, metricValue } = await import("@capstan/telemetry");
    const scrape = async () => (await metricsHandler()(new Request("http://127.0.0.1/metrics")).text());
    const stage = (v: string) => ({ key: "stage", value: v });
    const t0 = await scrape();
    const before = { build: metricValue(t0, "capstan_order_funnel_total", stage("build")) ?? 0, sign: metricValue(t0, "capstan_order_funnel_total", stage("sign")) ?? 0, submit: metricValue(t0, "capstan_order_funnel_total", stage("submit")) ?? 0 };
    const b = (await (await post("/orders/build", { owner: USER_A, agentRef: HL_REF, intent: intent({ size: "0.003" }), mode: "relay" })).json()) as HlUnsignedPayload;
    expect((await post("/orders/submit", { buildId: b.buildId, signedEnvelope: hlSign(b) })).status).toBe(200);
    const t1 = await scrape();
    expect(metricValue(t1, "capstan_order_funnel_total", stage("build"))).toBe(before.build + 1);
    expect(metricValue(t1, "capstan_order_funnel_total", stage("sign"))).toBe(before.sign + 1);
    expect(metricValue(t1, "capstan_order_funnel_total", stage("submit"))).toBe(before.submit + 1);
  });

  test("build refusals carry a refusal receipt", async () => {
    const check = async (res: Response, code: string) => {
      expect(res.status).toBe(403);
      const e = ((await res.json()) as { error: { code: string; receiptId?: string } }).error;
      expect(e.code).toBe(code);
      expect(s.receipts.byId(e.receiptId!)!.action).toBe("refusal");
    };
    await check(await post("/orders/build", { owner: USER_A, agentRef: "variational:route", intent: intent({ marketId: "variational:-:BTC" }), mode: "relay" }), "VENUE_DATA_ONLY");
    await check(await post("/orders/build", { owner: USER_A, agentRef: HL_REF, intent: intent({ marketId: "hyperliquid:-:ETH" }), mode: "relay" }), "MARKET_NOT_EXECUTABLE");
    await check(await post("/orders/build", { owner: USER_A, agentRef: "hl:policy-route", intent: intent(), mode: "relay" }), "POLICY_BREACH");
    expect(s.breaches.at(-1)).toMatchObject({ agentRef: "hl:policy-route", field: "maxNotionalPerOrderUsd" });
    await check(await post("/orders/build", { owner: USER_A, agentRef: "hl:unknown", intent: intent(), mode: "relay" }), "RETIRED_AGENT");
    // nothing was stored for a refused build
    const rows = await db.select().from(schema.orderBuilds);
    expect(rows.every((r) => r.agentRef === HL_REF)).toBe(true);
    // a bad body is a 400, never a build
    expect((await post("/orders/build", { owner: USER_A })).status).toBe(400);
  });

  test("cancel and close-all builds", async () => {
    const c = await post("/orders/cancel/build", { owner: USER_A, agentRef: HL_REF, marketId: "hyperliquid:-:BTC", venueOrderId: "4242" });
    expect(c.status).toBe(200);
    const cb = (await c.json()) as HlUnsignedPayload;
    const [row] = await db.select().from(schema.orderBuilds).where(eq(schema.orderBuilds.id, cb.buildId));
    expect((row!.intent as { kind: string }).kind).toBe("cancel");
    s.venues.hlReply.value = () => ({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } });
    const sub = (await (await post("/orders/submit", { buildId: cb.buildId, signedEnvelope: hlSign(cb) })).json()) as { receiptId: string };
    expect(s.receipts.byId(sub.receiptId)!.action).toBe("order.cancel");
    s.venues.hlReply.value = () => ({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } } });
    const all = await post("/orders/close-all/build", { owner: USER_A, venues: ["hyperliquid"] });
    expect(all.status).toBe(200);
    const body = (await all.json()) as { builds: HlUnsignedPayload[] };
    expect(body.builds.length).toBeGreaterThan(0);
    expect(body.builds.every((b) => b.preview.reduceOnly)).toBe(true);
    void (null as unknown as VenueAdapter);
  });
});
