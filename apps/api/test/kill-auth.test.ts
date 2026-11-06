// POST /v1/agents/{agentRef}/kill behind the real owner_sig gate (spec 7.6: "authorised by the owner's signature, or
// by the agent itself for self-halt"). The kill message in the body is the only authority:
// - the owner can always kill (also an agent that is already killed);
// - the agent can halt itself, with or without request-signature headers, also when it retries after its first kill
//   went through (before this fix the gate re-checked an api_request header against the owner's ACTIVE agents and
//   refused the retry of a self-halt with 401);
// - nobody else: a stranger, or another agent of the same owner, is refused 401 even with its own valid request
//   signature, and the agent stays live.
// Needs DATABASE_URL and REDIS_URL (skips without them).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { capstanMessage, closeDb, createDb, createRedis, createTempDatabase, memoryNonceStore, schema, type Db, type Redis } from "@capstan/core";
import { redisKillSwitch } from "@capstan/policy";
import { createReceiptService } from "@capstan/receipts";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { hashMessage } from "viem";
import { signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import { testReceiptSigner } from "../../../packages/policy/test/accounts";
import { HANDLER_ONLY_AUTH, ownerSigVerifier, SELF_VERIFIED } from "../src/auth";
import { agentsOfDb } from "../src/auth/env";
import { createAgentRoutes, type AgentRouteDeps } from "../src/routes/agents.routes";
import { addr, gwKey, HOST, signed, smallApp } from "./gw-helpers";

const PG = process.env.DATABASE_URL;
const REDIS = process.env.REDIS_URL;
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const ownerSk = gwKey("kill owner");
const agentSk = gwKey("kill agent self");
const otherAgentSk = gwKey("kill agent other");
const strangerSk = gwKey("kill stranger");
const OWNER = addr(ownerSk);

(PG && REDIS ? describe : describe.skip)("kill route auth through the gate", () => {
  let tmp: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  let redis: Redis;
  let app: Hono;
  let deps: AgentRouteDeps;
  const run = Date.now().toString(36);
  const refOwnerKill = `hl:${run}:owner-kill`;
  const refSelf = `hl:${run}:self`;
  const refOther = `hl:${run}:other`;

  beforeAll(async () => {
    tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_killauth" });
    db = createDb(tmp.url, { max: 4 });
    redis = createRedis(REDIS!);
    await db.insert(schema.delegations).values([
      { id: refOwnerKill, venue: "hyperliquid", owner: OWNER, agentAddress: addr(gwKey("kill agent owner-killed")), state: "active" },
      { id: refSelf, venue: "hyperliquid", owner: OWNER, agentAddress: addr(agentSk), state: "active" },
      { id: refOther, venue: "hyperliquid", owner: OWNER, agentAddress: addr(otherAgentSk), state: "active" },
    ]);
    const svc = createReceiptService({ db, signer: await testReceiptSigner(), now: () => new Date(NOW) });
    deps = { db, killSwitch: redisKillSwitch(redis, db, { now: () => new Date(NOW) }), nonces: memoryNonceStore(), receipts: { issue: async (d) => ({ receiptId: (await svc.issue(d)).receiptId }) }, adapters: new Map(), host: HOST, now: () => NOW };
    const verifier = ownerSigVerifier({ nonces: memoryNonceStore(), host: HOST, now: () => NOW, agentsOf: agentsOfDb(db) });
    app = (await smallApp(createAgentRoutes(() => deps), { verifiers: { owner_sig: verifier } })).app;
  }, 60_000);
  afterAll(async () => {
    await redis?.quit();
    if (db) await closeDb(db);
    await tmp?.drop();
  }, 60_000);

  let n = 0;
  /** A kill body signed by `sk` for `agentRef`; with `headers`, the same request also carries sk's api_request signature. */
  async function kill(agentRef: string, sk: Uint8Array, o: { headers?: boolean } = {}) {
    const issuedAt = NOW - 2000;
    const message = capstanMessage({ purpose: "kill", owner: OWNER, host: HOST, chainId: 4663, nonce: `kill-auth-${run}-${++n}`, issuedAt, expiresAt: issuedAt + 300_000, body: agentRef });
    const raw = JSON.stringify({ sig: signDigestRsv(hashMessage(message), sk), message, ts: issuedAt });
    const path = `/v1/agents/${encodeURIComponent(agentRef)}/kill`;
    const headers = { "content-type": "application/json", ...(o.headers ? signed(sk, { method: "POST", path, body: raw, owner: OWNER, ts: NOW, nonce: `kill-auth-hdr-${run}-${n}` }) : {}) };
    const r = await app.request(path, { method: "POST", headers, body: raw });
    return { status: r.status, body: (await r.json()) as { by?: string; alreadyKilled?: boolean; error?: { code: string } } };
  }

  test("handler-only-is-self-verified", () => {
    // the gate skips header checks only where the handler verifies its own signature
    expect([...HANDLER_ONLY_AUTH]).toEqual(["POST /agents/:agentRef/kill"]);
    for (const k of HANDLER_ONLY_AUTH) expect(SELF_VERIFIED[k]).toBeDefined();
  });

  test("owner-always", async () => {
    const a = await kill(refOwnerKill, ownerSk);
    expect(a.status).toBe(200);
    expect(a.body.by).toBe("owner");
    // the owner again, with its own request signature, on an agent that is already killed
    const b = await kill(refOwnerKill, ownerSk, { headers: true });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ by: "owner", alreadyKilled: true });
  });

  test("agent-self-halt", async () => {
    const a = await kill(refSelf, agentSk, { headers: true });
    expect(a.status).toBe(200);
    expect(a.body.by).toBe("agent");
    expect(await deps.killSwitch.isKilled(refSelf)).toBe(true);
    // the agent retries its self-halt (say the first answer was lost): still its own kill, never a 401
    const b = await kill(refSelf, agentSk, { headers: true });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ by: "agent", alreadyKilled: true });
    const c = await kill(refSelf, agentSk);
    expect(c.status).toBe(200);
  });

  test("nobody-else", async () => {
    // a stranger, and another agent of the same owner (the self-halt agent of refSelf)
    for (const sk of [strangerSk, agentSk]) {
      for (const headers of [false, true]) {
        const r = await kill(refOther, sk, { headers });
        expect(r.status).toBe(401);
        expect(r.body.error?.code).toBe("UNAUTHORIZED");
      }
    }
    expect(await deps.killSwitch.isKilled(refOther)).toBe(false);
    const [dg] = await db.select().from(schema.delegations).where(eq(schema.delegations.id, refOther));
    expect(dg!.state).toBe("active");
    expect((await db.select().from(schema.killEvents)).filter((e) => e.agentRef === refOther)).toEqual([]);
    // and the agent itself still can
    expect((await kill(refOther, otherAgentSk)).body.by).toBe("agent");
  });
});
