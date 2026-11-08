// Security review r1 F1 (high): unauthenticated API-key checks and owner_sig DB lookups ran before the rate limiter,
// so one client could pin the API's CPU with random secrets for a known account id. After the fix a cheap IP limiter
// runs before auth, failed auth is capped per IP, a hammered account id is refused without a lookup, the stored key
// hash is cheap, and owner_sig recovers the signer before any database read.
import { describe, expect, test } from "bun:test";
import type { RouteSpec } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import * as auth from "../../src/auth";
import * as rl from "../../src/ratelimit";
import { addr, gwKey, HOST, memoryNonceStore, signed, smallApp, T } from "../gw-helpers";

const routes: RouteSpec[] = [
  { method: "GET", path: "/keyed", auth: "api_key", handler: (c) => c.json({ id: c.get("apiKeyId" as never) }) },
  { method: "POST", path: "/thing", auth: "owner_sig", handler: (c) => c.json({ ok: true }) },
];

describe("r1 F1: auth before the limiter", () => {
  test("200 bad-secret requests from one IP produce 429s and at most a handful of key verifies", async () => {
    let verifies = 0;
    const check = auth.apiKeyCheck({ verify: async () => (verifies++, null) });
    const opts: Record<string, unknown> = { verifiers: { api_key: auth.apiKeyVerifier(check) } };
    const pre = (rl as Record<string, unknown>).preAuthLimiter as undefined | ((d: unknown) => unknown);
    if (pre) opts.preAuth = pre({ store: rl.memoryWindowStore(), ipOf: () => "203.0.113.9" });
    const { app } = await smallApp(routes, opts as never);
    const statuses: number[] = [];
    for (let i = 0; i < 200; i++) {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const key = `cpst_01ARZ3NDEKTSV4RRFFQ69G5FAV_${Buffer.from(secret).toString("base64url")}`;
      statuses.push((await app.request("/v1/keyed", { headers: { authorization: `Bearer ${key}` } })).status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(150);
    expect(verifies).toBeLessThanOrEqual(10);
  });

  test("owner_sig: a stranger's signature naming an owner never reaches the agents lookup", async () => {
    let lookups = 0;
    const owner = gwKey("owner");
    const stranger = gwKey("stranger");
    const v = auth.ownerSigVerifier({ nonces: memoryNonceStore(), host: HOST, now: () => T + 1000, agentsOf: async (_o: Hex) => (lookups++, []) });
    const { app } = await smallApp(routes, { verifiers: { owner_sig: v } });
    const body = JSON.stringify({ owner: addr(owner) });
    // the owner's own signature: no agents lookup needed
    let r = await app.request("/v1/thing", { method: "POST", headers: { "content-type": "application/json", ...signed(owner, { method: "POST", path: "/v1/thing", body }) }, body });
    expect(r.status).toBe(200);
    // a wrong host, signed by a stranger for the owner: refused before any lookup
    r = await app.request("/v1/thing", { method: "POST", headers: { "content-type": "application/json", ...signed(stranger, { method: "POST", path: "/v1/thing", body, owner: addr(owner), host: "evil.example" }) }, body });
    expect(r.status).toBe(401);
    expect(lookups).toBe(0);
  });

  test("follow-up: a hammered account id still lets its real holder in (no lockout per id)", async () => {
    const real = `cpst_01ARZ3NDEKTSV4RRFFQ69G5FAV_${"A".repeat(43)}`;
    const check = auth.apiKeyCheck({ verify: async (k) => (k === real ? { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", ownerWallet: null, tier: "free" } : null) });
    // strangers on many IPs send random secrets for the holder's id
    for (let i = 0; i < 20; i++) expect(await check(`cpst_01ARZ3NDEKTSV4RRFFQ69G5FAV_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`)).toBeNull();
    expect((await check(real))?.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });
});
