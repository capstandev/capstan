// Found while recording the demo videos on the fork: agent-safe onboarding (a policy, relay only) answered 500
// "Internal error" with nothing in the api log. The production policy step (policyStepOf) put BigInt times into the
// bundle's typed data, and a BigInt cannot be written as JSON, so the bundle could never be stored or answered. Here
// the real Hyperliquid adapter composition runs against the fork's stand-in venue: build with a policy answers the
// bundle, every step signs, and the submit completes. A bad policy is a 400, not a 500.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, schema, type Db } from "@capstan/core";
import { policyDigest, recoverDigestSigner } from "@capstan/policy";
import type { AgentPolicy, Hex, OnboardingBundle, VenueId } from "@capstan/schema";
import { hashTypedPayload } from "../../../packages/signers/hl/src";
import { fakeVenueServer } from "@capstan/venue-client";
import { eq } from "drizzle-orm";
import { hlRoutes, hlState } from "../../../ops/fork/fake-venues";
import { wallet } from "../../../packages/eligibility/test/helpers";
import { composeAdapters, type BuildAdapter } from "../src/adapters";
import { createOnboardingRoutes } from "../src/routes/onboarding.routes";
import { smallApp } from "./gw-helpers";

const PG = process.env.DATABASE_URL;
const owner = wallet("api-onboarding-policy-owner");
const AGENT = "0x00000000000000000000000000000000000000d1" as Hex;

const policyFor = (o: Hex): AgentPolicy => ({
  owner: o,
  agents: [{ venue: "hyperliquid", agentRef: `hl:${AGENT}` }],
  maxNotionalPerOrderUsd: "1000",
  maxGrossNotionalUsd: "5000",
  maxLeverage: 3,
  allowedMarkets: "*",
  allowedVenues: ["hyperliquid"],
  maxOrdersPerDay: 50,
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  nonce: "0011223344556677",
});

describe.skipIf(!PG)("agent-safe onboarding (policy) on the real Hyperliquid composition", () => {
  const venue = fakeVenueServer(hlRoutes(hlState("Mainnet")));
  let tmp: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  let app: Awaited<ReturnType<typeof smallApp>>["app"];
  beforeAll(async () => {
    tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_onb_policy" });
    db = createDb(tmp.url, { max: 4 });
    const { adapters } = await composeAdapters({ CAPSTAN_NETWORK: "mainnet", CAPSTAN_VENUE_URL_HYPERLIQUID: venue.url }, { db, redis: null });
    ({ app } = await smallApp(createOnboardingRoutes(() => ({ db, adapters: adapters as Map<VenueId, BuildAdapter>, issue: async () => ({ receiptId: "r0" }), now: () => Date.now() })), { verifiers: { owner_sig: () => null, api_key: () => null } }));
  }, 60_000);
  afterAll(async () => {
    venue.stop();
    if (db) await closeDb(db);
    await tmp?.drop();
  }, 60_000);

  const post = (path: string, body: unknown) => app.request(`/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("policy-build-and-submit", async () => {
    const policy = policyFor(owner.address);
    const res = await post("/onboarding/build", { venue: "hyperliquid", owner: owner.address, agentAddress: AGENT, builderMaxBps: 3, mode: "relay", policy });
    expect(res.status).toBe(200);
    const b = (await res.json()) as OnboardingBundle;
    const pi = b.steps.findIndex((s) => s.kind === "agent_policy");
    expect(pi).toBeGreaterThan(0);
    // the wire form is plain JSON numbers, and it hashes to the same digest the policy store verifies
    const msg = b.steps[pi]!.typedData!.message as Record<string, unknown>;
    expect(typeof msg.expiresAt).toBe("number");
    expect(typeof msg.reduceOnlyAfter).toBe("number");
    const [row] = await db.select().from(schema.onboardingSessions).where(eq(schema.onboardingSessions.id, b.bundleId));
    expect(row?.status).toBe("built");
    // the owner signs every step as a wallet would (the typed data straight from the JSON answer)
    const signatures: { step: number; sig: Hex }[] = [];
    for (let i = 0; i < b.steps.length; i++) {
      const td = b.steps[i]!.typedData!;
      // HL struct names hold a colon, which viem refuses, so those steps sign their digest; the rest are plain EIP-712
      const sig = !td.primaryType.includes(":") ? await owner.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message } as never) : await owner.sign({ hash: hashTypedPayload(td) });
      signatures.push({ step: i, sig });
    }
    expect(recoverDigestSigner(policyDigest(policy), signatures[pi]!.sig)?.toLowerCase()).toBe(owner.address.toLowerCase());
    const sub = await post("/onboarding/submit", { bundleId: b.bundleId, signatures });
    expect(sub.status).toBe(200);
    expect(((await sub.json()) as { agentRef: string }).agentRef).toBe(`hl:${AGENT}`);
  });

  test("bad-policy-is-400", async () => {
    const res = await post("/onboarding/build", { venue: "hyperliquid", owner: owner.address, agentAddress: "0x00000000000000000000000000000000000000d2", builderMaxBps: 3, mode: "relay", policy: { ...policyFor(owner.address), expiresAt: "not a time" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
  });
});
