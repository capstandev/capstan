// R4 (todo 30): two concurrent submits of one payload make one venue request and one DUPLICATE_PAYLOAD, on the memory
// store and on Postgres (the unique signed_payload_hash index), the second with DATABASE_URL set.
import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, schema, type Db } from "@capstan/core";
import { handleSubmit } from "../src/pipeline";
import { pgRelayStore, saveBuild } from "../src/stores";
import { codeOf, HL_REF, relayStack, USER_A } from "./helpers";

const PG = process.env.DATABASE_URL;
const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

async function race(s: ReturnType<typeof relayStack>, h: Awaited<ReturnType<ReturnType<typeof relayStack>["hl"]>>) {
  const run = () => codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: "203.0.113.4" }, s.deps));
  const out = await Promise.all([run(), run()]);
  return out.map((r) => r.code).sort();
}

describe("dedupe", () => {
  test("concurrent", async () => {
    const s = relayStack();
    stacks.push(s);
    for (let i = 0; i < 20; i++) {
      s.venues.clear();
      const h = await s.hl();
      expect(await race(s, h)).toEqual(["DUPLICATE_PAYLOAD", null].sort() as never);
      expect(s.venues.hl.length).toBe(1);
    }
  });

  const d = PG ? test : test.skip;
  d("concurrent on postgres", async () => {
    const tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_relay_dedupe" });
    const db: Db = createDb(tmp.url, { max: 8 });
    try {
      const s = relayStack();
      stacks.push(s);
      const mem = s.store;
      const pg = pgRelayStore(db);
      s.deps.store = { ...pg, getDelegation: mem.getDelegation, getBuild: pg.getBuild };
      await db.insert(schema.delegations).values({ id: HL_REF, venue: "hyperliquid", owner: USER_A, agentAddress: mem.delegations.get(HL_REF)!.agentAddress, state: "active" });
      for (let i = 0; i < 10; i++) {
        s.venues.clear();
        const h = await s.hl();
        await saveBuild(db, { build: h.b, owner: USER_A, agentRef: HL_REF, facts: { intent: null, kind: "order", mode: "relay", requestHash: h.s.requestHash, policyId: null, leverage: 1 } });
        expect(await race(s, h)).toEqual(["DUPLICATE_PAYLOAD", null].sort() as never);
        expect(s.venues.hl.length).toBe(1);
      }
      const rows = await db.select().from(schema.orders);
      expect(rows.length).toBe(10);
      expect(new Set(rows.map((r) => r.signedPayloadHash)).size).toBe(10);
      expect(rows.every((r) => r.status === "accepted" && r.mode === "relay")).toBe(true);
    } finally {
      await closeDb(db);
      await tmp.drop();
    }
  }, 60_000);
});
