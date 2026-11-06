// R4 (todo 29): owner_sig refuses a signature by another address, a ts older than 5 minutes and a replayed nonce;
// it binds method, path, query and body; an active agent may sign for its owner. Also the API key verifier and cache.
import { describe, expect, test } from "bun:test";
import type { RouteSpec } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { apiKeyCheck, apiKeyVerifier, ownerSigVerifier } from "../src/auth";
import { addr, gwKey, HOST, memoryNonceStore, signed, smallApp, T } from "./gw-helpers";

const owner = gwKey("owner");
const agent = gwKey("agent");
const stranger = gwKey("stranger");

const echo: RouteSpec[] = [
  { method: "POST", path: "/thing", auth: "owner_sig", handler: (c) => c.json({ owner: c.get("owner" as never), agentRef: c.get("agentRef" as never) ?? null }) },
  { method: "GET", path: "/thing", auth: "owner_sig", handler: (c) => c.json({ owner: c.get("owner" as never) }) },
  { method: "GET", path: "/keyed", auth: "api_key", handler: (c) => c.json({ id: c.get("apiKeyId" as never) }) },
];

async function app(now = T + 1000) {
  const verifiers = {
    owner_sig: ownerSigVerifier({ nonces: memoryNonceStore(), host: HOST, now: () => now, agentsOf: async (o: Hex) => (o === addr(owner) ? [{ address: addr(agent), agentRef: "hl:agent-1" }] : []) }),
  };
  return (await smallApp(echo, { verifiers })).app;
}

describe("auth", () => {
  test("owner-sig", async () => {
    const a = await app();
    const body = JSON.stringify({ owner: addr(owner), x: 1 });
    const post = (h: Record<string, string>, b = body) => a.request("/v1/thing", { method: "POST", headers: { "content-type": "application/json", ...h }, body: b });
    // the owner signs: allowed, and the owner reaches the handler
    let r = await post(signed(owner, { method: "POST", path: "/v1/thing", body }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ owner: addr(owner), agentRef: null });
    // an active agent of the owner signs for it
    r = await post(signed(agent, { method: "POST", path: "/v1/thing", body, owner: addr(owner) }));
    expect(await r.json()).toEqual({ owner: addr(owner), agentRef: "hl:agent-1" });
    // another address signing for this owner
    expect((await post(signed(stranger, { method: "POST", path: "/v1/thing", body, owner: addr(owner) }))).status).toBe(401);
    // a stranger's own message naming itself, on a body naming the owner
    expect((await post(signed(stranger, { method: "POST", path: "/v1/thing", body }))).status).toBe(401);
    // too old: issued more than 5 minutes ago (expired by its own window)
    expect((await post(signed(owner, { method: "POST", path: "/v1/thing", body, ts: T - 6 * 60_000, ttlMs: 5 * 60_000 }))).status).toBe(401);
    // a validity window longer than 5 minutes is refused too
    expect((await post(signed(owner, { method: "POST", path: "/v1/thing", body, ttlMs: 6 * 60_000 }))).status).toBe(401);
    // a replayed nonce
    const once = signed(owner, { method: "POST", path: "/v1/thing", body, nonce: "replay-me-1" });
    expect((await post(once)).status).toBe(200);
    const replay = await post(once);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: { message: string } }).error.message).toContain("replay");
    // the signature binds the body, the path and the query
    expect((await post(signed(owner, { method: "POST", path: "/v1/thing", body }), JSON.stringify({ owner: addr(owner), x: 2 }))).status).toBe(401);
    expect((await a.request("/v1/thing?owner=" + addr(owner), { headers: signed(owner, { method: "GET", path: "/v1/thing" }) })).status).toBe(401);
    expect((await a.request("/v1/thing?owner=" + addr(owner), { headers: signed(owner, { method: "GET", path: `/v1/thing?owner=${addr(owner)}` }) })).status).toBe(200);
    // another host, and a read-purpose signature on a route that is not self-verified
    expect((await post(signed(owner, { method: "POST", path: "/v1/thing", body, host: "evil.example" }))).status).toBe(401);
    expect((await a.request(`/v1/thing?owner=${addr(owner)}`, { headers: signed(owner, { method: "GET", path: `/v1/thing?owner=${addr(owner)}`, purpose: "read" }) })).status).toBe(401);
    // no headers at all
    expect((await post({})).status).toBe(401);
  });

  test("api-key-verify-and-cache", async () => {
    let calls = 0;
    let now = T;
    const check = apiKeyCheck({ verify: async (k) => (calls++, k === "cpst_good_key" ? { id: "acct-1", ownerWallet: null, tier: "free" } : null), now: () => now });
    const a = (await smallApp(echo, { verifiers: { api_key: apiKeyVerifier(check) } })).app;
    const get = (k?: string) => a.request("/v1/keyed", { headers: k ? { authorization: `Bearer ${k}` } : {} });
    expect((await get()).status).toBe(401);
    expect((await get("cpst_bad")).status).toBe(401);
    expect(await (await get("cpst_good_key")).json()).toEqual({ id: "acct-1" });
    await get("cpst_good_key");
    expect(calls).toBe(2); // the second good call came from the 60 s cache
    now += 61_000;
    await get("cpst_good_key");
    expect(calls).toBe(3);
  });
});
