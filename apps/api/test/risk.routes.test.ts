// R10 (todo 19): /positions and /risk need the owner's read signature (purpose read, at most 5 minutes, nonce once,
// bound to the exact request). R11: /risk/snapshot and /risk/liq-heatmap are x402 at $0.01 and $0.02.
import { describe, expect, test } from "bun:test";
import { capstanMessage, memoryNonceStore, type RouteSpec } from "@capstan/core";
import { memoryCatalog } from "@capstan/quote";
import { BANNER, encodeReadMessage, memoryKv, READ_MESSAGE_HEADER, READ_SIGNATURE_HEADER, readRequestBody, type AccountAdapter, type CapstanRiskView } from "@capstan/risk";
import type { AccountSnapshot, Hex, VenueId } from "@capstan/schema";
import { Hono } from "hono";
import { testWallet } from "../../../packages/policy/test/accounts";
import { createPositionsRoutes } from "../src/routes/positions.routes";
import { createRiskRoutes, type RiskRouteDeps } from "../src/routes/risk.routes";
import { createApp } from "../src/app";

const HOST = "api.capstan.test";
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const owner = testWallet("risk owner");
const other = testWallet("risk other");
const caps = (venue: VenueId) => ({ venue, execution: true, keyType: "secp256k1" as const, delegation: "agent" as const, canWithdraw: false as const, builderFee: null, collateral: ["USDC"], directSubmitSupported: true, publicAccountReads: venue !== "aster" });
const hlSnap = (o: Hex): AccountSnapshot => ({ venue: "hyperliquid", identity: { venue: "hyperliquid", owner: o }, equityUsd: "1000", freeCollateralUsd: "400", positions: [{ venue: "hyperliquid", marketId: "hyperliquid:-:ETH", canonicalAsset: null, side: "long", size: "1", entryPx: "2000", markPx: "2000", notionalUsd: "2000", leverage: 5, marginMode: "isolated", liqPx: "1700", liqPxSource: "venue", marginRatio: null, unrealisedPnlUsd: "0", collateralAsset: "USDC", asOf: new Date(NOW).toISOString() }], asOf: new Date(NOW).toISOString() });

function deps(): RiskRouteDeps & { reads: string[] } {
  const reads: string[] = [];
  const hl: AccountAdapter = { caps: caps("hyperliquid"), getAccount: async (id) => (reads.push(id.owner), hlSnap(id.owner)) };
  return {
    reads,
    identities: async (o) => [{ venue: "hyperliquid", owner: o }, { venue: "aster", owner: o }],
    accounts: { adapters: new Map([["hyperliquid", hl]]), cache: memoryKv(() => NOW), asterIngested: async () => null },
    catalog: memoryCatalog([]),
    marks: async () => new Map(),
    recentViews: async () => [{ perVenue: [hlSnap(owner.address)] } as Pick<CapstanRiskView, "perVenue">],
    nonces: memoryNonceStore(),
    host: HOST,
    now: () => NOW,
  };
}

function app(d: RiskRouteDeps): Hono {
  const h = new Hono();
  for (const r of [...createRiskRoutes(() => d), ...createPositionsRoutes(() => d)]) h.on(r.method, `/v1${r.path}`, (c) => r.handler(c));
  return h;
}

let n = 0;
async function signedGet(h: Hono, path: string, o: Partial<{ signer: typeof owner; issuedAt: number; ttl: number; purpose: "read" | "api_request"; bodyPath: string; nonce: string }> = {}) {
  const issuedAt = o.issuedAt ?? NOW - 1000;
  const text = capstanMessage({ purpose: o.purpose ?? "read", owner: owner.address, host: HOST, chainId: 4663, nonce: o.nonce ?? `read-nonce-${n++}`, issuedAt, expiresAt: issuedAt + (o.ttl ?? 120_000), body: readRequestBody("GET", o.bodyPath ?? path) });
  const sig = await (o.signer ?? owner).signMessage({ message: text });
  return h.request(path, { headers: { [READ_MESSAGE_HEADER]: encodeReadMessage(text), [READ_SIGNATURE_HEADER]: sig } });
}

describe("risk routes", () => {
  test("owner-sig", async () => {
    const d = deps();
    const h = app(d);
    for (const path of [`/v1/positions?owner=${owner.address}`, `/v1/risk?owner=${owner.address}`]) {
      // no signature: nothing, not even public parts
      const none = await h.request(path);
      expect(none.status).toBe(401);
      // the owner's read signature works
      const ok = await signedGet(h, path);
      expect(ok.status, path).toBe(200);
      const j = (await ok.json()) as { banner: string; pending: { status: string }[] };
      expect(j.banner).toBe(BANNER);
      expect(j.pending.map((p) => p.status)).toEqual(["needs_signed_read"]);
      // another signer, another purpose, an expiry over 5 minutes, an expired message, another request: refused
      expect((await signedGet(h, path, { signer: other })).status).toBe(401);
      expect((await signedGet(h, path, { purpose: "api_request" })).status).toBe(401);
      expect((await signedGet(h, path, { ttl: 5 * 60_000 + 1 })).status).toBe(401);
      expect((await signedGet(h, path, { issuedAt: NOW - 200_000, ttl: 100_000 })).status).toBe(401);
      expect((await signedGet(h, path, { bodyPath: `${path}&venues=aster` })).status).toBe(401);
      // a replayed nonce is refused
      expect((await signedGet(h, path, { nonce: `replay-${path.length}` })).status).toBe(200);
      expect((await signedGet(h, path, { nonce: `replay-${path.length}` })).status).toBe(401);
    }
    // positions answer per venue, read with the master address
    const pos = (await (await signedGet(h, `/v1/positions?owner=${owner.address}`)).json()) as { venues: { venue: string; positions: unknown[] }[] };
    expect(pos.venues.map((v) => v.venue)).toEqual(["hyperliquid"]);
    expect(new Set(d.reads.map((x) => x.toLowerCase()))).toEqual(new Set([owner.address.toLowerCase()]));
  });

  test("priced", async () => {
    const specs: RouteSpec[] = createRiskRoutes(() => deps());
    const by = new Map(specs.map((s) => [`${s.method} ${s.path}`, s]));
    expect(by.get("POST /risk/snapshot")).toMatchObject({ auth: "x402", priced: { usd: "0.01" } });
    expect(by.get("GET /risk/liq-heatmap")).toMatchObject({ auth: "x402", priced: { usd: "0.02" } });
    expect(by.get("GET /risk")!.auth).toBe("owner_sig");
    expect(createPositionsRoutes(() => deps())[0]).toMatchObject({ method: "GET", path: "/positions", auth: "owner_sig" });
    // mounted through the real app: the x402 routes are refused without a payment verifier (deny by default)
    const { app: a, routes } = await createApp();
    expect(routes.find((r) => r.path === "/risk/snapshot")).toMatchObject({ auth: "x402", file: "risk.routes.ts" });
    expect((await a.request("/v1/risk/liq-heatmap?asset=CR:ETH")).status).toBe(401);
    // the handlers themselves: third-party snapshot excludes Aster and reads only public venues
    const d = deps();
    const h = app(d);
    const snap = await h.request("/v1/risk/snapshot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addresses: [{ venue: "hyperliquid", owner: other.address }, { venue: "aster", owner: other.address }] }) });
    expect(snap.status).toBe(200);
    const v = (await snap.json()) as CapstanRiskView;
    expect(v.owner).toBeNull();
    expect(v.perVenue.map((s) => s.venue)).toEqual(["hyperliquid"]);
    expect(v.pending).toEqual([expect.objectContaining({ venue: "aster", status: "excluded" })]);
    expect(v.banner).toBe(BANNER);
    const heat = await h.request("/v1/risk/liq-heatmap?asset=CR:ETH");
    expect(heat.status).toBe(200);
    expect(JSON.stringify(await heat.json())).not.toMatch(/0x[0-9a-fA-F]{6,}/);
  });
});
