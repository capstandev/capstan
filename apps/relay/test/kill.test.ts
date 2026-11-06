// R5 (todo 30): after a kill the relay refuses that agent within 1 s, timed over 50 runs. Each kill is the real
// thing: the agent's own signed kill message (self-halt) through the todo 22 kill route, which sets the Redis flag
// and publishes on ps:kill; the relay's view hears it. With Redis down the relay refuses every agent under a policy
// (fail closed) and lets plain agents through. Needs DATABASE_URL and REDIS_URL (skips without them).
import { afterAll, describe, expect, test } from "bun:test";
import { capstanMessage, closeDb, createDb, createRedis, createTempDatabase, memoryNonceStore, schema, type Db, type Redis } from "@capstan/core";
import { redisKillSwitch } from "@capstan/policy";
import { addressOf } from "@capstan/signer-hl";
import { hashMessage } from "viem";
import { Hono } from "hono";
import { createAgentRoutes } from "../../api/src/routes/agents.routes";
import { signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import { redisKillView } from "../src/kill";
import { handleSubmit } from "../src/pipeline";
import { codeOf, HL_REF, NOW, policyFor, relayStack, testKey, USER_A } from "./helpers";

const PG = process.env.DATABASE_URL;
const REDIS = process.env.REDIS_URL;
const HOST = "api.capstan.test";
const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

describe("kill", () => {
  const d = PG && REDIS ? test : test.skip;
  d("under-1s-and-fail-closed", async () => {
    const tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_relay_kill" });
    const db: Db = createDb(tmp.url, { max: 4 });
    const redis: Redis = createRedis(REDIS!);
    const view = redisKillView(redis);
    await view.ready;
    const killSwitch = redisKillSwitch(redis, db, { now: () => new Date(NOW) });
    const s = relayStack();
    stacks.push(s);
    s.deps.kill = view;
    s.deps.lanes = { take: async (o) => ({ ok: true, lane: o.lane }) };
    const api = new Hono();
    for (const r of createAgentRoutes(() => ({ db, killSwitch, nonces: memoryNonceStore(), receipts: { issue: async (dr) => ({ receiptId: (await s.receipts.issue(dr)).receiptId }) }, adapters: new Map(), host: HOST, now: () => NOW }))) api.on(r.method, `/v1${r.path}`, (c) => r.handler(c));
    const run = Date.now().toString(36);
    const times: number[] = [];
    try {
      for (let i = 0; i < 50; i++) {
        const sk = testKey(`kill-agent-${run}-${i}`);
        const agent = addressOf(sk).toLowerCase() as `0x${string}`;
        const ref = `hl:kill-${run}-${i}`;
        s.store.delegations.set(ref, { ...s.store.delegations.get(HL_REF)!, id: ref, agentAddress: agent });
        await db.insert(schema.delegations).values({ id: ref, venue: "hyperliquid", owner: USER_A, agentAddress: agent, state: "active" });
        const before = await s.hl({}, { agentRef: ref, agentKey: sk });
        expect((await codeOf(handleSubmit({ buildId: before.b.buildId, signedEnvelope: before.env }, { ip: "203.0.113.5" }, s.deps))).code).toBeNull();
        const next = await s.hl({}, { agentRef: ref, agentKey: sk });
        const message = capstanMessage({ purpose: "kill", owner: USER_A, host: HOST, chainId: 4663, nonce: `kill-${run}-${i}`, issuedAt: NOW - 1000, expiresAt: NOW + 60_000, body: ref });
        const t0 = performance.now();
        const res = await api.request(`/v1/agents/${encodeURIComponent(ref)}/kill`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, sig: signDigestRsv(hashMessage(message), sk) }) });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { by: string }).by).toBe("agent");
        let code: string | null = null;
        while (performance.now() - t0 < 1000) {
          code = (await codeOf(handleSubmit({ buildId: next.b.buildId, signedEnvelope: next.env }, { ip: "203.0.113.5" }, s.deps))).code;
          if (code === "AGENT_KILLED") break;
          await Bun.sleep(5);
        }
        times.push(performance.now() - t0);
        expect(code).toBe("AGENT_KILLED");
      }
      times.sort((a, b) => a - b);
      expect(times.length).toBe(50);
      expect(times.at(-1)!).toBeLessThan(1000);
    } finally {
      await killSwitch.close?.();
      await view.close();
      await redis.quit();
      await closeDb(db);
      await tmp.drop();
    }

    // Redis unreachable: the view answers 'unknown'; policy agents are refused, plain agents are not
    const dead = createRedis("redis://127.0.0.1:9", { lazyConnect: true });
    dead.on("error", () => undefined);
    const deadView = redisKillView(dead, { getTimeoutMs: 100 });
    const s2 = relayStack();
    stacks.push(s2);
    s2.deps.kill = deadView;
    expect(await deadView.status("hl:any")).toBe("unknown");
    const polRef = "hl:policy-redis-down";
    s2.store.delegations.set(polRef, { ...s2.store.delegations.get(HL_REF)!, id: polRef });
    s2.policies.set(polRef, { policyId: "pol-down", policy: policyFor(polRef) });
    const p = await s2.hl({}, { agentRef: polRef, policyId: "pol-down" });
    expect((await codeOf(handleSubmit({ buildId: p.b.buildId, signedEnvelope: p.env }, { ip: "203.0.113.5" }, s2.deps))).code).toBe("AGENT_KILLED");
    const plain = await s2.hl();
    expect((await codeOf(handleSubmit({ buildId: plain.b.buildId, signedEnvelope: plain.env }, { ip: "203.0.113.5" }, s2.deps))).code).toBeNull();
    deadView.close().catch(() => undefined);
    dead.disconnect();
  }, 120_000);
});
