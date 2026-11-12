// Agent-safe onboarding stores the owner's signed policy (spec 7.6). Before this fix /onboarding/submit ignored the
// agent_policy step: policyId stayed null, the server held no policy and the relay let any order through. Here the
// real Hyperliquid composition runs against the fork's stand-in venue: the policy is verified before any venue step
// (a bad or mismatched signature or a used nonce refuses with nothing sent), stored as POST /v1/agents/policy stores
// it, and its id goes into the delegation state and the onboarding receipt. The relay then refuses an order that
// breaches it (POLICY_BREACH) right after onboarding. Without a policy nothing changes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, schema, type Db } from "@capstan/core";
import type { ReceiptDraft } from "@capstan/receipts";
import type { AgentPolicy, Hex, OnboardingBundle, VenueId } from "@capstan/schema";
import { fakeVenueServer } from "@capstan/venue-client";
import { eq } from "drizzle-orm";
import { hashTypedPayload } from "../../../packages/signers/hl/src";
import { hlRoutes, hlState } from "../../../ops/fork/fake-venues";
import { wallet } from "../../../packages/eligibility/test/helpers";
import { codeOf, relayStack } from "../../relay/test/helpers";
import { dbPolicySource } from "../../relay/src/wire";
import { handleSubmit } from "../../relay/src/pipeline";
import { AGENT as RELAY_AGENT } from "../../../packages/adapters/hyperliquid/test/orders/util";
import { composeAdapters, type BuildAdapter } from "../src/adapters";
import { createOnboardingRoutes } from "../src/routes/onboarding.routes";
import { smallApp } from "./gw-helpers";

const PG = process.env.DATABASE_URL;
const owner = wallet("api-onboarding-policy-store-owner");
const other = wallet("api-onboarding-policy-store-other");
// a second owner: an owner has 3 named agent slots at Hyperliquid
const owner2 = wallet("api-onboarding-policy-store-owner2");
let n = 0;
const agentAddr = () => `0x00000000000000000000000000000000000000${(0xe0 + ++n).toString(16)}` as Hex;

const policyFor = (o: Hex, agent: string, over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  owner: o,
  agents: [{ venue: "hyperliquid", agentRef: `hl:${agent.toLowerCase()}` }],
  maxNotionalPerOrderUsd: "100",
  maxGrossNotionalUsd: "500",
  maxLeverage: 3,
  allowedMarkets: "*",
  allowedVenues: ["hyperliquid"],
  maxOrdersPerDay: 50,
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  nonce: `n-${Date.now()}-${n}`,
  ...over,
});

describe.skipIf(!PG)("agent-safe onboarding stores the signed policy", () => {
  const st = hlState("Mainnet");
  const routes = hlRoutes(st);
  let exchangeCalls = 0;
  const inner = routes["POST /exchange"]!;
  routes["POST /exchange"] = ((...args: Parameters<typeof inner>) => {
    exchangeCalls++;
    return inner(...args);
  }) as typeof inner;
  const venue = fakeVenueServer(routes as never);
  let tmp: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  let app: Awaited<ReturnType<typeof smallApp>>["app"];
  const drafts: ReceiptDraft[] = [];
  beforeAll(async () => {
    tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_onb_policy_store" });
    db = createDb(tmp.url, { max: 4 });
    const { adapters } = await composeAdapters({ CAPSTAN_NETWORK: "mainnet", CAPSTAN_VENUE_URL_HYPERLIQUID: venue.url }, { db, redis: null });
    ({ app } = await smallApp(createOnboardingRoutes(() => ({ db, adapters: adapters as Map<VenueId, BuildAdapter>, issue: async (d) => (drafts.push(d), { receiptId: `r${drafts.length}` }), now: () => Date.now() })), { verifiers: { owner_sig: () => null, api_key: () => null } }));
  }, 60_000);
  afterAll(async () => {
    venue.stop();
    if (db) await closeDb(db);
    await tmp?.drop();
  }, 60_000);

  const post = (path: string, body: unknown) => app.request(`/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  /** Build and sign every step as the owner's wallet would; `policySigner` signs the policy step instead when given. */
  async function onboard(agent: Hex, policy?: AgentPolicy, policySigner = owner, who = owner) {
    const res = await post("/onboarding/build", { venue: "hyperliquid", owner: who.address, agentAddress: agent, builderMaxBps: 3, mode: "relay", ...(policy ? { policy } : {}) });
    expect(res.status).toBe(200);
    const b = (await res.json()) as OnboardingBundle;
    const signatures: { step: number; sig: Hex }[] = [];
    for (let i = 0; i < b.steps.length; i++) {
      const td = b.steps[i]!.typedData!;
      const w = b.steps[i]!.kind === "agent_policy" ? policySigner : who;
      const sig = !td.primaryType.includes(":") ? await w.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message } as never) : await w.sign({ hash: hashTypedPayload(td) });
      signatures.push({ step: i, sig });
    }
    const before = exchangeCalls;
    const sub = await post("/onboarding/submit", { bundleId: b.bundleId, signatures });
    return { sub, body: (await sub.json()) as { agentRef?: string; delegation?: { policyId?: string }; receiptId?: string; error?: { code: string; message: string } }, sent: exchangeCalls - before, bundleId: b.bundleId };
  }

  const policiesOf = (o: string) => db.select().from(schema.agentPolicies).where(eq(schema.agentPolicies.owner, o.toLowerCase()));

  // first: an owner has a few agent slots at the venue, so this runs before the policy cases fill them on main
  test("no-policy-unchanged", async () => {
    const agent = agentAddr();
    const count = (await policiesOf(owner.address)).length;
    const r = await onboard(agent);
    expect(r.sub.status).toBe(200);
    expect(r.body.delegation?.policyId).toBeUndefined();
    expect(drafts.at(-1)!).toMatchObject({ action: "onboarding.complete", policyId: null });
    expect((await policiesOf(owner.address)).length).toBe(count);
  });

  test("policy-stored-at-submit-and-enforced-by-relay", async () => {
    const policy = policyFor(owner.address, RELAY_AGENT);
    const r = await onboard(RELAY_AGENT, policy);
    expect(r.sub.status).toBe(200);
    expect(r.sent).toBeGreaterThan(0);
    const policyId = r.body.delegation?.policyId;
    expect(typeof policyId).toBe("string");
    // the receipt names the stored policy, and the server holds it for the new agent
    expect(drafts.at(-1)!).toMatchObject({ action: "onboarding.complete", policyId });
    const [row] = await db.select().from(schema.agentPolicies).where(eq(schema.agentPolicies.id, policyId!));
    expect(row?.agentRefs).toEqual([`hl:${RELAY_AGENT}`]);
    // the relay finds it for the new agent at once: an order above maxNotionalPerOrderUsd is refused
    const s = relayStack();
    try {
      s.deps.policy = dbPolicySource(db);
      const ref = `hl:${RELAY_AGENT}`;
      s.store.delegations.set(ref, { id: ref, venue: "hyperliquid", owner: owner.address.toLowerCase() as Hex, agentAddress: RELAY_AGENT, accountIndex: null, apiKeyIndex: null, state: "active", expiresAt: null });
      const h = await s.hl({ size: "0.01" }, { agentRef: ref, policyId: policyId! }); // about 760 USD > 100
      h.s.owner = owner.address.toLowerCase() as Hex;
      const out = await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: "203.0.113.70" }, s.deps));
      expect(out.code).toBe("POLICY_BREACH");
      expect(out.field).toBe("maxNotionalPerOrderUsd");
      expect(s.venues.hl).toHaveLength(0);
    } finally {
      s.stop();
    }
  });

  test("bad-policy-signature-refused-nothing-sent", async () => {
    const agent = agentAddr();
    const r = await onboard(agent, policyFor(owner.address, agent), other);
    expect(r.sub.status).toBe(401);
    expect(r.body.error?.code).toBe("UNAUTHORIZED");
    expect(r.sent).toBe(0);
    const [sess] = await db.select().from(schema.onboardingSessions).where(eq(schema.onboardingSessions.id, r.bundleId));
    expect(sess?.status).toBe("failed");
    expect(await db.select().from(schema.delegations).where(eq(schema.delegations.id, `hl:${agent}`))).toHaveLength(0);
  });

  test("policy-for-another-owner-refused-nothing-sent", async () => {
    const agent = agentAddr();
    const r = await onboard(agent, policyFor(other.address, agent), other);
    expect(r.sub.status).toBe(401);
    expect(r.sent).toBe(0);
    expect(await policiesOf(other.address)).toHaveLength(0);
  });

  test("policy-not-naming-the-new-agent-refused-nothing-sent", async () => {
    const agent = agentAddr();
    const r = await onboard(agent, policyFor(owner.address, agentAddr()));
    expect(r.sub.status).toBe(400);
    expect(r.body.error?.code).toBe("INVALID_INPUT");
    expect(r.sent).toBe(0);
  });

  test("reused-policy-nonce-refused-nothing-sent", async () => {
    const a1 = agentAddr();
    const first = await onboard(a1, policyFor(owner2.address, a1, { nonce: "reused-nonce-1" }), owner2, owner2);
    expect(first.sub.status).toBe(200);
    const a2 = agentAddr();
    const r = await onboard(a2, policyFor(owner2.address, a2, { nonce: "reused-nonce-1" }), owner2, owner2);
    expect(r.sub.status).toBe(400);
    expect(r.body.error?.message).toContain("nonce");
    expect(r.sent).toBe(0);
  });

});

describe("agent-safe onboarding on venues other than Hyperliquid", () => {
  test("aster-bundle-carries-the-policy-step", async () => {
    const { adapters } = await composeAdapters({ CAPSTAN_NETWORK: "mainnet", ASTER_EXECUTION: "1", RELAY_EGRESS_IP: "203.0.113.9", ASTER_BUILDER_ADDRESS: "0x00000000000000000000000000000000c0ffee02" }, { db: null, redis: null });
    const agent = "0x00000000000000000000000000000000000000a5" as Hex;
    const policy = { ...policyFor(owner.address, agent), agents: [{ venue: "aster" as VenueId, agentRef: `aster:${owner.address.toLowerCase()}:${agent}` }], allowedVenues: ["aster" as VenueId] };
    const b = await adapters.get("aster")!.buildOnboarding({ venue: "aster", owner: owner.address, agentAddress: agent, policy } as never);
    expect(b.steps.map((s) => s.kind)).toEqual(["eligibility_declaration", "aster_approve_agent", "aster_approve_builder", "agent_policy"]);
    expect(b.steps.at(-1)!.typedData!.domain.name).toBe("CapstanAgentPolicy");
  });

  test("a-policy-the-venue-cannot-carry-is-refused-at-build", async () => {
    const bundle: OnboardingBundle = { bundleId: "b-nopolicy", venue: "lighter-mainnet", owner: owner.address, steps: [{ kind: "lighter_change_pubkey", signer: "main_wallet", personalSignText: "x" }], humanReadable: [], templateHash: "0x00" as Hex, expiresAt: Date.now() + 60_000 } as never;
    const stub = { caps: { execution: true }, buildOnboarding: async () => bundle } as unknown as BuildAdapter;
    const writes: unknown[] = [];
    const db = { insert: () => ({ values: (v: unknown) => (writes.push(v), { onConflictDoUpdate: async () => undefined }) }) } as unknown as Db;
    const { app } = await smallApp(createOnboardingRoutes(() => ({ db, adapters: new Map([["lighter-mainnet" as VenueId, stub]]), issue: async () => ({ receiptId: "r" }), now: () => Date.now() })), { verifiers: { owner_sig: () => null, api_key: () => null } });
    const res = await app.request("/v1/onboarding/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ venue: "lighter-mainnet", owner: owner.address, lighterPubKey: `0x${"ab".repeat(40)}`, mode: "relay", policy: policyFor(owner.address, "0x00000000000000000000000000000000000000a6") }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("not available for lighter-mainnet");
    expect(writes).toHaveLength(0); // no bundle stored, nothing to sign
  });
});
