// Security review r1, one root cause: review-r1:3 F3, review-r1:2 R1-04, review-r1:5 ELIG-2, review-r1:6 F2.
// An API key (even an anonymous one, free from POST /account/keys) could act for ANY owner: build orders, cancels and
// close-alls, claim another owner's build, and make Capstan sign refusal receipts and write eligibility decisions in a
// victim's name. After the fix a key acts only for the wallet it was made for, an anonymous key may use only the
// onboarding routes (whose refusals carry no owner), and the public eligibility probe writes nothing and never says
// whether a wallet holds a declaration. Real verifiers, real eligibility edge, real receipt chain. Needs DATABASE_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema, ulid, type RouteSpec } from "@capstan/core";
import { edgeFor } from "@capstan/eligibility";
import type { Hex } from "@capstan/schema";
import { STANDARD_FEE } from "@capstan/plans";
import { and, eq, isNull } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbFixture, geo, IP, NOW, PG, wallet, type DbFixture } from "../../../../packages/eligibility/test/helpers";
import { createApp } from "../../src/app";
import type { BuildAdapter } from "../../src/adapters";
import { apiKeyCheck, apiKeyVerifier, ownerSigVerifier } from "../../src/auth";
import { createEligibilityRoutes } from "../../src/routes/eligibility.routes";
import { createOnboardingRoutes } from "../../src/routes/onboarding.routes";
import { createOrderRoutes, type OrdersRouteDeps } from "../../src/routes/orders.routes";
import { createClaimRoutes } from "../../src/routes/receipts-claim.routes";
import { HOST, memoryNonceStore, signed } from "../gw-helpers";
import { hexToBytes, keccak256, toBytes } from "viem";

const victim = wallet("r1-victim");
const owner = wallet("r1-owner-a");
const V = victim.address.toLowerCase() as Hex;
const A = owner.address.toLowerCase() as Hex;
const victimSk = hexToBytes(keccak256(toBytes("capstan-eligibility-test:r1-victim"))); // test-key (public label)

const ANON = `cpst_${"0".repeat(26)}_${"a".repeat(43)}`;
const KEY_A = `cpst_${"1".repeat(26)}_${"b".repeat(43)}`;
const KEY_V = `cpst_${"2".repeat(26)}_${"c".repeat(43)}`;
const keys: Record<string, { id: string; ownerWallet: string | null; tier: string }> = {
  [ANON]: { id: "0".repeat(26), ownerWallet: null, tier: "free" },
  [KEY_A]: { id: "1".repeat(26), ownerWallet: A, tier: "free" },
  [KEY_V]: { id: "2".repeat(26), ownerWallet: V, tier: "free" },
};

(PG ? describe : describe.skip)("r1 owner binding: an API key acts only for its own wallet", () => {
  let f: DbFixture;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let ip = "";
  const claims: string[] = [];
  const dataOnly = { caps: { venue: "variational", execution: false } } as unknown as BuildAdapter;

  beforeAll(async () => {
    f = await dbFixture("r1-owner-binding");
    await f.declare(victim, ["hyperliquid", "variational"]);
    await f.agent("hl:victim", V, "hyperliquid");
    const issue = async (d: Parameters<OrdersRouteDeps["issue"]>[0]) => ({ receiptId: (await f.receipts.issue(d)).receiptId });
    const deps: OrdersRouteDeps = {
      db: f.db,
      adapters: new Map(),
      relay: { submit: async () => ({ ok: false, status: 409, body: { error: { code: "INVALID_INPUT", message: "stub" } } }) } as never,
      claim: async (r) => (claims.push(r.buildId), { receiptId: "rcpt_stub" }),
      policy: { active: async () => null } as never,
      usage: async () => ({ grossNotionalUsd: "0", ordersToday: 0 }) as never,
      issue,
      alerts: { policyBreach: async () => undefined } as never,
      feeOf: async () => STANDARD_FEE,
      laneOf: async () => "free",
      now: () => NOW,
    };
    const routes: RouteSpec[] = [
      ...createOrderRoutes(() => deps),
      ...createClaimRoutes(() => deps),
      ...createOnboardingRoutes(() => ({ db: f.db, adapters: new Map([["variational", dataOnly]]), issue, now: () => NOW })),
      ...createEligibilityRoutes(() => ({ geo, db: f.db, now: () => new Date(NOW), ipOf: () => ip })),
    ];
    ({ app } = await createApp({
      routesDir: mkdtempSync(join(tmpdir(), "capstan-r1-owner-")),
      extraRoutes: routes,
      verifiers: {
        owner_sig: ownerSigVerifier({ nonces: memoryNonceStore(), host: HOST, now: () => NOW, agentsOf: async () => [] }),
        api_key: apiKeyVerifier(apiKeyCheck({ verify: async (k) => keys[k] ?? null })),
      },
      edge: edgeFor({ geo, db: f.db, now: () => new Date(NOW), issue: (d) => f.receipts.issue(d), ipOf: () => ip }),
    }));
  }, 60_000);
  afterAll(() => f?.drop());

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.request(`/v1${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
  const intent = { marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 };
  const victimReceipts = async () => (await f.db.select({ id: schema.receipts.id }).from(schema.receipts).where(eq(schema.receipts.owner, V))).length;
  const victimDecisions = async () => (await f.db.select({ id: schema.eligibilityDecisions.id }).from(schema.eligibilityDecisions).where(eq(schema.eligibilityDecisions.owner, V))).length;
  const victimBuilds = async () => (await f.db.select({ id: schema.orderBuilds.id }).from(schema.orderBuilds).where(eq(schema.orderBuilds.owner, V))).length;

  test("an anonymous key or another wallet's key cannot build, cancel or close-all for the victim, and writes nothing in its name", async () => {
    ip = IP.DE!;
    const before = { r: await victimReceipts(), d: await victimDecisions(), b: await victimBuilds() };
    for (const key of [ANON, KEY_A]) {
      for (const [path, body] of [
        ["/orders/build", { owner: V, agentRef: "hl:not-the-victims", intent, mode: "relay" }],
        ["/orders/cancel/build", { owner: V, agentRef: "hl:not-the-victims", marketId: "hyperliquid:-:BTC", clientOrderId: "c1" }],
        ["/orders/close-all/build", { owner: V }],
      ] as const) {
        const r = await post(path, body, bearer(key));
        expect(r.status, `${path} with ${key === ANON ? "an anonymous key" : "wallet A's key"}`).toBe(401);
      }
    }
    // from a refused region too: the edge never runs for an unauthenticated owner, so no GEO_REFUSED lands on the victim
    ip = IP.US!;
    expect((await post("/orders/build", { owner: V, agentRef: "hl:x", intent, mode: "relay" }, bearer(ANON))).status).toBe(401);
    expect(await victimReceipts()).toBe(before.r);
    expect(await victimDecisions()).toBe(before.d);
    expect(await victimBuilds()).toBe(before.b);
  });

  test("a key cannot claim another owner's build", async () => {
    ip = IP.DE!;
    const buildId = ulid();
    await f.db.insert(schema.orderBuilds).values({ id: buildId, owner: V, agentRef: "hl:victim", venue: "hyperliquid", marketId: "hyperliquid:-:BTC", intent: {}, payload: {}, preview: {}, eligibilityDecisionId: "eld_x", expiresAt: new Date(NOW + 30_000) });
    const claim = { buildId, signedEnvelope: { buildId, venue: "hyperliquid", encoding: "hl_l1_action", signedBody: {}, signature: "0x00", signerRef: "0xabc", payloadHash: "0x00" }, venueResponse: {} };
    for (const key of [ANON, KEY_A]) expect((await post("/receipts/claim", claim, bearer(key))).status).toBe(401);
    expect(claims).toEqual([]);
    // the victim's own key may claim it
    expect((await post("/receipts/claim", claim, bearer(KEY_V))).status).toBe(200);
    expect(claims).toEqual([buildId]);
  });

  test("an anonymous onboarding refusal names no owner", async () => {
    ip = IP.DE!;
    const before = await victimReceipts();
    const r = await post("/onboarding/build", { venue: "variational", owner: V, agentAddress: A }, bearer(ANON));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("VENUE_DATA_ONLY");
    // an eligibility refusal at the edge for an anonymous onboarding build names no owner either
    ip = IP.US!;
    const g = await post("/onboarding/build", { venue: "hyperliquid", owner: V, agentAddress: A }, bearer(ANON));
    expect(g.status).toBe(403);
    expect((await g.json()).error.code).toBe("GEO_REFUSED");
    expect(await victimReceipts()).toBe(before);
    const unowned = await f.db.select({ id: schema.eligibilityDecisions.id }).from(schema.eligibilityDecisions).where(and(isNull(schema.eligibilityDecisions.owner), eq(schema.eligibilityDecisions.ipCountry, "US")));
    expect(unowned.length).toBeGreaterThan(0);
  });

  test("the public eligibility probe writes no decision and never reveals a declaration", async () => {
    ip = IP.DE!;
    const before = await victimDecisions();
    const named = await (await app.request(`/v1/eligibility?venue=hyperliquid&owner=${V}`)).json();
    const anon = await (await app.request("/v1/eligibility?venue=hyperliquid")).json();
    expect(named).toEqual(anon);
    expect(await victimDecisions()).toBe(before);
  });

  test("the victim itself still acts: its owner signature and its own key reach the handler", async () => {
    ip = IP.DE!;
    // the agent is active and the edge allows; the handler answers (no adapter is mounted here)
    const body = JSON.stringify({ owner: V, agentRef: "hl:victim", intent, mode: "relay" });
    const sig = await app.request("/v1/orders/build", { method: "POST", headers: { "content-type": "application/json", ...signed(victimSk, { method: "POST", path: "/v1/orders/build", body, ts: NOW }) }, body });
    expect((await sig.json()).error.code).toBe("UNSUPPORTED_VENUE");
    const own = await post("/orders/build", JSON.parse(body), bearer(KEY_V));
    expect((await own.json()).error.code).toBe("UNSUPPORTED_VENUE");
  });
});
