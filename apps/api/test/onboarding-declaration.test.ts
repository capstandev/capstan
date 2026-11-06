// Found on the fork run (todo 40): onboarding submit never stored the signed eligibility declaration, so no owner could
// ever place an order (every order answered DECLARATION_MISSING). The submit now verifies the declaration step's
// signature and stores it before the venue steps are sent; a bad or missing signature sends nothing to the venue.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, schema, ulid, type Db } from "@capstan/core";
import { DECLARATION_DOMAIN, declarationStep } from "@capstan/eligibility";
import type { Hex, OnboardingBundle, OnboardingRequest, SignedOnboarding, VenueId } from "@capstan/schema";
import { eq } from "drizzle-orm";
import { wallet } from "../../../packages/eligibility/test/helpers";
import type { BuildAdapter } from "../src/adapters";
import { createOnboardingRoutes, SESSION_LIFE_MS } from "../src/routes/onboarding.routes";
import { smallApp, T } from "./gw-helpers";

const PG = process.env.DATABASE_URL;
const owner = wallet("api-onboarding-declaration-owner");

describe.skipIf(!PG)("onboarding stores the declaration", () => {
  let tmp: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  let app: Awaited<ReturnType<typeof smallApp>>["app"];
  const venueSubmits: string[] = [];
  beforeAll(async () => {
    tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_onb_decl" });
    db = createDb(tmp.url, { max: 4 });
    const reqs = new Map<string, OnboardingRequest & Record<string, unknown>>();
    const hl = {
      caps: { venue: "hyperliquid", execution: true },
      async buildOnboarding(req: OnboardingRequest & Record<string, unknown>): Promise<OnboardingBundle> {
        const b: OnboardingBundle = { bundleId: ulid(), venue: "hyperliquid", owner: req.owner, steps: [declarationStep(req.owner, ["hyperliquid"], T)], humanReadable: ["Sign the declaration."], templateHash: "0x01", expiresAt: T + SESSION_LIFE_MS };
        reqs.set(b.bundleId, req);
        return b;
      },
      async submitOnboarding(s: SignedOnboarding) {
        venueSubmits.push(s.bundleId);
        return { agentRef: `hl:${String(reqs.get(s.bundleId)!.agentAddress).toLowerCase()}`, delegation: { agentActive: true, builderMaxBps: 3, routing: "ok" as const }, venueResponses: [] };
      },
    } as unknown as BuildAdapter;
    ({ app } = await smallApp(createOnboardingRoutes(() => ({ db, adapters: new Map<VenueId, BuildAdapter>([["hyperliquid", hl]]), issue: async () => ({ receiptId: "r0" }), now: () => T })), { verifiers: { owner_sig: () => null, api_key: () => null } }));
  }, 60_000);
  afterAll(async () => {
    if (db) await closeDb(db);
    await tmp?.drop();
  }, 60_000);

  const post = (path: string, body: unknown) => app.request(`/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const sign = (b: OnboardingBundle) => {
    const td = b.steps[0]!.typedData!;
    const m = td.message as Record<string, unknown>;
    return owner.signTypedData({ domain: DECLARATION_DOMAIN, types: { Declaration: td.types.Declaration! }, primaryType: "Declaration", message: { ...m, issuedAt: BigInt(m.issuedAt as number), expiresAt: BigInt(m.expiresAt as number) } as never });
  };

  test("declaration-stored-on-submit", async () => {
    const b1 = (await (await post("/onboarding/build", { venue: "hyperliquid", owner: owner.address.toLowerCase(), agentAddress: "0x00000000000000000000000000000000000000c1" })).json()) as OnboardingBundle;
    // a signature by someone else: refused, nothing stored, nothing sent to the venue
    const wrong = await wallet("api-onboarding-declaration-mallory").signMessage({ message: "x" });
    const bad = await post("/onboarding/submit", { bundleId: b1.bundleId, signatures: [{ step: 0, sig: wrong }] });
    expect(bad.status).toBe(401);
    expect(venueSubmits).toHaveLength(0);
    expect(await db.select().from(schema.declarations).where(eq(schema.declarations.owner, owner.address.toLowerCase()))).toHaveLength(0);
    // the owner's own signature: stored first, then the venue steps go
    const b2 = (await (await post("/onboarding/build", { venue: "hyperliquid", owner: owner.address.toLowerCase(), agentAddress: "0x00000000000000000000000000000000000000c2" })).json()) as OnboardingBundle;
    const ok = await post("/onboarding/submit", { bundleId: b2.bundleId, signatures: [{ step: 0, sig: (await sign(b2)) as Hex }] });
    expect(ok.status).toBe(200);
    expect(venueSubmits).toEqual([b2.bundleId]);
    const rows = await db.select().from(schema.declarations).where(eq(schema.declarations.owner, owner.address.toLowerCase()));
    expect(rows).toHaveLength(1);
  });
});
