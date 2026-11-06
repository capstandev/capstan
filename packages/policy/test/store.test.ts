// R10: a policy nonce cannot be reused by the same owner; a newer policy for the same agent supersedes the older one
// (latest issuedAt wins, the older is marked revoked). Needs DATABASE_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema, type Db } from "@capstan/core";
import type { AgentPolicy } from "@capstan/schema";
import { eq } from "drizzle-orm";
import { activePolicyFor, getPolicy, policyTypedData, PolicyStoreError, storePolicy } from "../src";
import { testWallet } from "./accounts";
import { HOOK_MS, PG, tempDb } from "./db";
import { basePolicy, NOW } from "./fixtures";

const owner = testWallet("store owner");
const other = testWallet("store other");
const sign = async (p: AgentPolicy, w = owner) => w.signTypedData(policyTypedData(p) as never);

const d = PG ? describe : describe.skip;
d("policy store", () => {
  let t: Awaited<ReturnType<typeof tempDb>>;
  let db: Db;
  beforeAll(async () => {
    t = await tempDb("capstan_policy");
    db = t.db;
  }, HOOK_MS);
  afterAll(async () => t?.drop(), HOOK_MS);

  let clock = NOW;
  const now = () => new Date((clock += 1000));

  test("nonce-and-supersede", async () => {
    const p1 = basePolicy(owner.address, { nonce: "nonce-one-0001", agents: [{ venue: "hyperliquid", agentRef: "A" }, { venue: "hyperliquid", agentRef: "B" }] });
    const { policyId: id1 } = await storePolicy(db, p1, await sign(p1), { now });
    expect((await activePolicyFor(db, "A", owner.address))?.policyId).toBe(id1);

    // same nonce, same owner: refused even with a different body
    const reuse = { ...p1, maxLeverage: 2 };
    await expect(storePolicy(db, reuse, await sign(reuse), { now })).rejects.toMatchObject({ code: "NONCE_REUSED" });
    // the same nonce under another owner is fine
    const po = basePolicy(other.address, { nonce: "nonce-one-0001", agents: [{ venue: "hyperliquid", agentRef: "Z" }] });
    await storePolicy(db, po, await sign(po, other), { now });

    // a newer policy for A only: A follows the new one; the old one still covers B, so it is not revoked
    const p2 = basePolicy(owner.address, { nonce: "nonce-two-0002", maxLeverage: 2, agents: [{ venue: "hyperliquid", agentRef: "A" }] });
    const { policyId: id2 } = await storePolicy(db, p2, await sign(p2), { now });
    expect((await activePolicyFor(db, "A", owner.address))?.policyId).toBe(id2);
    expect((await activePolicyFor(db, "A", owner.address))?.policy.maxLeverage).toBe(2);
    expect((await activePolicyFor(db, "B", owner.address))?.policyId).toBe(id1);
    expect((await getPolicy(db, id1))?.revoked).toBe(false);

    // now B also gets a newer policy: every agent of p1 is covered by newer ones, so p1 is revoked
    const p3 = basePolicy(owner.address, { nonce: "nonce-three-03", agents: [{ venue: "hyperliquid", agentRef: "B" }] });
    const { policyId: id3 } = await storePolicy(db, p3, await sign(p3), { now });
    expect((await activePolicyFor(db, "B", owner.address))?.policyId).toBe(id3);
    expect((await getPolicy(db, id1))?.revoked).toBe(true);
    expect((await getPolicy(db, id2))?.revoked).toBe(false);
    const issued = await db.select({ id: schema.agentPolicies.id, at: schema.agentPolicies.issuedAt }).from(schema.agentPolicies).where(eq(schema.agentPolicies.owner, owner.address.toLowerCase()));
    expect(issued.length).toBe(3);

    // a racing reuse of one nonce stores exactly one
    const p4 = basePolicy(owner.address, { nonce: "nonce-race-004", agents: [{ venue: "hyperliquid", agentRef: "C" }] });
    const sig4 = await sign(p4);
    const results = await Promise.allSettled([storePolicy(db, p4, sig4, { now }), storePolicy(db, p4, sig4, { now })]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(PolicyStoreError);
  });

  test("a policy never binds another owner's agent", async () => {
    await db.insert(schema.delegations).values({ id: "victim-agent", venue: "lighter-mainnet", owner: other.address, accountIndex: 1, apiKeyIndex: 4, state: "active" });
    const p = basePolicy(owner.address, { nonce: "nonce-foreign-6", agents: [{ venue: "lighter-mainnet", agentRef: "victim-agent" }] });
    await expect(storePolicy(db, p, await sign(p), { now })).rejects.toMatchObject({ code: "INVALID" });
    // the victim's own policy lookup never returns a policy signed by someone else
    expect(await activePolicyFor(db, "Z", owner.address)).toBeNull();
    expect((await activePolicyFor(db, "Z", other.address))?.policy.owner).toBe(other.address);
  });

  test("signature, shape and expiry are checked before storing", async () => {
    const p = basePolicy(owner.address, { nonce: "nonce-sig-0005" });
    await expect(storePolicy(db, p, await sign(p, other), { now })).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    const bad = { ...p, maxNotionalPerOrderUsd: "-1" };
    await expect(storePolicy(db, bad, await sign(bad), { now })).rejects.toMatchObject({ code: "INVALID" });
    const old = { ...p, expiresAt: new Date(NOW - 1).toISOString() };
    await expect(storePolicy(db, old, await sign(old), { now })).rejects.toMatchObject({ code: "EXPIRED" });
    // nothing was stored for that nonce, so it is still usable
    await storePolicy(db, p, await sign(p), { now });
  });
});
