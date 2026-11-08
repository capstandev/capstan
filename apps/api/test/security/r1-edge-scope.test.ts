// Security review r1 review-r1:5 ELIG-1: the eligibility edge decided on a venue and market the caller picked, not
// the ones the handler builds. A ?venue= query overrode the body (the handler never reads it), and a text/plain body
// hid the market from the edge while the handler (c.req.json(), any content type) still built on it. After the fix
// the edge parses the body the way the handler does, never reads venue or market from a write route's query, and
// refuses a venue that disagrees with the market. Real write hooks of the order and onboarding routes, the real edge,
// the real rules on a DB-IP sample. Needs DATABASE_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RouteSpec } from "@capstan/core";
import { edgeFor } from "@capstan/eligibility";
import { STANDARD_FEE } from "@capstan/plans";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbFixture, geo, IP, NOW, PG, wallet, type DbFixture } from "../../../../packages/eligibility/test/helpers";
import { createApp } from "../../src/app";
import { createOnboardingRoutes } from "../../src/routes/onboarding.routes";
import { createOrderRoutes, type OrdersRouteDeps } from "../../src/routes/orders.routes";
import { trustedOwner } from "../gw-helpers";

const owner = wallet("r1-edge-scope-owner");

(PG ? describe : describe.skip)("r1 ELIG-1: the edge decides on what the handler builds", () => {
  let f: DbFixture;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  const ran: string[] = [];
  beforeAll(async () => {
    f = await dbFixture("r1-edge-scope");
    // a declaration for Hyperliquid only, so a decision made on Hyperliquid crypto allows
    await f.declare(owner, ["hyperliquid"]);
    const stub = {} as OrdersRouteDeps;
    const orders = createOrderRoutes(() => ({ ...stub, feeOf: async () => STANDARD_FEE }));
    const onboarding = createOnboardingRoutes(() => ({ db: f.db, adapters: new Map(), issue: async () => ({ receiptId: "r" }), now: () => NOW }));
    // the routes' real write declarations (venue and market hooks); the handler only records that it ran
    const pick = (rs: RouteSpec[], path: string): RouteSpec => ({ ...rs.find((r) => r.path === path)!, handler: (c) => (ran.push(path), c.json({ ran: path })) });
    ({ app } = await createApp({
      routesDir: mkdtempSync(join(tmpdir(), "capstan-r1-scope-")),
      extraRoutes: [pick(orders, "/orders/build"), pick(onboarding, "/onboarding/build")],
      verifiers: { owner_sig: trustedOwner, api_key: trustedOwner },
      edge: edgeFor({ geo, db: f.db, now: () => new Date(NOW), issue: (d) => f.receipts.issue(d), ipOf: () => IP.AE! }),
    }));
  }, 60_000);
  afterAll(() => f?.drop());

  const send = (path: string, body: unknown, type = "application/json") => app.request(`/v1${path}`, { method: "POST", headers: { "content-type": type, "x-test-owner": owner.address }, body: JSON.stringify(body) });

  test("a ?venue= query cannot move an AE onboarding from lighter-rh to hyperliquid", async () => {
    ran.length = 0;
    const plain = await send("/onboarding/build", { venue: "lighter-rh", owner: owner.address });
    expect(plain.status).toBe(403);
    expect((await plain.json()).error.code).toBe("GEO_REFUSED");
    const spoofed = await send("/onboarding/build?venue=hyperliquid", { venue: "lighter-rh", owner: owner.address });
    expect(spoofed.status).toBe(403);
    expect((await spoofed.json()).error.code).toBe("GEO_REFUSED");
    expect(ran).toEqual([]);
  });

  test("a text/plain body and ?venue= cannot hide an AE HIP-3 equity order from the edge", async () => {
    ran.length = 0;
    const order = { owner: owner.address, agentRef: "hl:x", intent: { marketId: "hyperliquid:xyz:TSLA", side: "buy", size: "1", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 }, mode: "direct" };
    for (const [path, type] of [["/orders/build", "application/json"], ["/orders/build?venue=hyperliquid", "text/plain"], ["/orders/build?venue=hyperliquid&marketId=hyperliquid:-:BTC", "text/plain"]] as const) {
      const r = await send(path, order, type);
      expect(r.status, `${path} as ${type}`).toBe(403);
      expect((await r.json()).error.code).toBe("GEO_REFUSED");
    }
    expect(ran).toEqual([]);
  });

  test("a body venue that disagrees with the market is refused", async () => {
    ran.length = 0;
    const r = await send("/onboarding/build", { venue: "hyperliquid", marketId: "lighter-rh:-:ETH", owner: owner.address });
    expect(r.status).toBe(400);
    expect(ran).toEqual([]);
  });
});
