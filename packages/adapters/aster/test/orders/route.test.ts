// POST /v1/risk/ingest (todo 15): owner-signature auth, the ingest checks, and 12 ingests per owner per minute.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSignedRead, memoryAccountStore } from "../../src/signedread";
import { accountSigner } from "@capstan/signer-aster";
import { agent, NOW, owner } from "./setup";

const API = join(import.meta.dir, "../../../../../apps/api/src");

describe("risk ingest route", () => {
  test("route-ingest-and-limit", async () => {
    const { createApp, discoverRoutes } = await import(join(API, "app.ts"));
    const mod = await import(join(API, "routes/risk-ingest.routes.ts"));
    // the drop-in file mounts with owner_sig auth
    const found = (await discoverRoutes()) as { spec: { method: string; path: string; auth: string } }[];
    expect(found.some((r) => r.spec.method === "POST" && r.spec.path === "/risk/ingest" && r.spec.auth === "owner_sig")).toBe(true);
    const store = memoryAccountStore(() => NOW);
    let clock = NOW;
    const limiter = mod.memoryRateLimiter();
    const routes = mod.createRiskIngestRoutes(() => ({
      ingest: { network: "Mainnet", delegations: { isActive: async () => true }, store, marginAssetOf: () => "USDT" },
      limiter,
      now: () => clock,
    }));
    const { app } = await createApp({ routesDir: join(import.meta.dir, "no-routes"), extraRoutes: routes, verifiers: { owner_sig: () => null } });
    const body = async () => {
      const r = buildSignedRead("positionRisk", owner.address, agent.address, BigInt(clock) * 1000n, "Mainnet");
      return { venue: "aster", snapshot: [{ symbol: "BTCUSDT", positionAmt: "0.01", entryPrice: "70000", markPrice: "76000", liquidationPrice: "40000", leverage: "5", marginType: "cross" }], signedRead: { path: r.path, query: r.query, signature: await accountSigner(agent)(r.digest), signer: agent.address, owner: owner.address, fetchedAtMs: clock } };
    };
    const post = async (b: unknown) => app.request("/v1/risk/ingest", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } });
    const r1 = await post(await body());
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true, source: "client_read", asOf: new Date(NOW).toISOString(), positions: 1 });
    expect((await store.get(owner.address))!.snapshot.positions[0]!.liqPxSource).toBe("venue");
    for (let i = 1; i < 12; i++) {
      clock += 1;
      expect((await post(await body())).status).toBe(200);
    }
    clock += 1;
    const limited = await post(await body());
    expect(limited.status).toBe(429);
    clock += 60_000;
    expect((await post(await body())).status).toBe(200);
    // a bad read is refused with the error body shape
    const bad = await body();
    bad.signedRead.owner = "0x1111111111111111111111111111111111111111";
    const rb = await post(bad);
    expect(rb.status).toBe(401);
    expect(((await rb.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
    // without an owner_sig verifier the route answers 401 (deny by default)
    const { app: closed } = await createApp({ routesDir: join(import.meta.dir, "no-routes"), extraRoutes: routes });
    expect((await closed.request("/v1/risk/ingest", { method: "POST", body: "{}" })).status).toBe(401);
  });
});
