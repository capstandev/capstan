// Security review r1, review-r1:2 R1-05: the policy check and the order row that usage counts are one atomic step per
// agent. Eight concurrent submits of about 760 USD under a 1,000 USD gross cap and a 3-order day send exactly one.
// The Postgres store is checked the same way when DATABASE_URL is set.
import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, schema, type Db } from "@capstan/core";
import { sql } from "drizzle-orm";
import { handleSubmit } from "../src/pipeline";
import { pgRelayStore, saveBuild } from "../src/stores";
import { codeOf, HL_REF, policyFor, relayStack } from "./helpers";

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));
const PG = process.env.DATABASE_URL;

async function race(s: ReturnType<typeof relayStack>) {
  const ref = "hl:race-agent";
  s.store.delegations.set(ref, { ...s.store.delegations.get(HL_REF)!, id: ref });
  s.policies.set(ref, { policyId: "pol-race", policy: policyFor(ref, { maxGrossNotionalUsd: "1000", maxNotionalPerOrderUsd: "1000", maxOrdersPerDay: 3 }) });
  const made = [];
  for (let i = 0; i < 8; i++) made.push(await s.hl({ size: "0.01" }, { agentRef: ref, policyId: "pol-race" }));
  return { ref, made, out: await Promise.all(made.map((h) => codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: "203.0.113.55" }, s.deps)))) };
}

describe("security r1 R1-05", () => {
  test("concurrent-submits-respect-policy-caps", async () => {
    const s = relayStack({ concurrency: 8 });
    stacks.push(s);
    const { out } = await race(s);
    expect(s.venues.hl.length).toBe(1);
    expect(out.filter((r) => r.code === null).length).toBe(1);
    expect(out.filter((r) => r.code === "POLICY_BREACH").length).toBe(7);
  });

  (PG ? test : test.skip)("concurrent-submits-respect-policy-caps-postgres", async () => {
    const tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_sec_r105" });
    const db: Db = createDb(tmp.url, { max: 8 });
    try {
      const s = relayStack({ concurrency: 8 });
      stacks.push(s);
      const mem = s.store;
      const pg = pgRelayStore(db);
      // builds live in Postgres so the pg store's usage query sees them; delegations stay in memory
      s.deps.store = { ...pg, getDelegation: (r) => mem.getDelegation(r), getBuild: async (id) => mem.builds.get(id) ?? null };
      const ref = "hl:race-agent";
      mem.delegations.set(ref, { ...mem.delegations.get(HL_REF)!, id: ref });
      s.policies.set(ref, { policyId: "pol-race", policy: policyFor(ref, { maxGrossNotionalUsd: "1000", maxNotionalPerOrderUsd: "1000", maxOrdersPerDay: 3 }) });
      const made = [];
      for (let i = 0; i < 8; i++) {
        const h = await s.hl({ size: "0.01" }, { agentRef: ref, policyId: "pol-race" });
        await saveBuild(db, { build: h.b, owner: h.s.owner, agentRef: ref, facts: { intent: null, kind: "order", mode: "relay", requestHash: h.s.requestHash, policyId: "pol-race", leverage: 1 } });
        made.push(h);
      }
      // open all 8 pool connections first, so the submits really run side by side
      await Promise.all([...Array(8)].map(() => db.execute(sql`select pg_sleep(0.05)`)));
      const out = await Promise.all(made.map((h) => codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: "203.0.113.56" }, s.deps))));
      expect(s.venues.hl.length).toBe(1);
      expect(out.filter((r) => r.code === null).length).toBe(1);
      const rows = await db.select().from(schema.orders);
      expect(rows.length).toBe(1);
    } finally {
      await closeDb(db);
      await tmp.drop();
    }
  }, 60_000);
});
