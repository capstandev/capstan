// R1, R2 (todo 29): every mounted route is in the route auth table with an auth kind, compared with the committed
// snapshot (UPDATE_SNAPSHOT=1 rewrites it); a route without auth fails mount. Every routed write (orders, onboarding,
// claims) has the eligibility edge and owner_sig or api_key auth; every other POST or DELETE is listed here with the
// reason it routes nothing to a venue; every self-verified route's handler really makes its own signature check.
import { describe, expect, test } from "bun:test";
import { ROUTE_AUTHS } from "@capstan/core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, discoverRoutes, MountError, routeTable, ROUTES_DIR } from "../src/app";
import { routeKey, SELF_VERIFIED } from "../src/auth";

const SNAP = join(import.meta.dir, "route-table.snap.json");

/** POST and DELETE routes that route nothing to a venue, so they carry no eligibility edge (spec 10 scope). */
export const NON_ROUTED: Record<string, string> = {
  "POST /quote": "a read with a body",
  "POST /risk/snapshot": "a priced read of public venue accounts",
  "POST /risk/ingest": "stores the owner's own signed venue read",
  "POST /agents/policy": "stores a signed policy; tightens what agents may do",
  "POST /agents/:agentRef/kill": "the exit path: a refused region must still be able to stop its agent",
  "POST /account/keys": "creates a Capstan API key",
  "POST /alerts/webhooks": "registers a webhook",
  "DELETE /alerts/webhooks/:id": "removes a webhook",
  "POST /spreads/plan": "plans only; each leg is an order build through /orders/build (edge there)",
  "POST /spreads/:id/ack": "acknowledges the risk label",
  "POST /spreads/:id/events": "client-reported leg events",
  "POST /credits/topup/5": "buys premium-call credits",
  "POST /credits/topup/20": "buys premium-call credits",
  "POST /credits/topup/100": "buys premium-call credits",
};

describe("route auth table", () => {
  test("snapshot-and-default-deny", async () => {
    const { routes } = await createApp();
    const table = routeTable(routes);
    console.log(table.map((r) => `${r.method.padEnd(6)} ${r.path.padEnd(34)} ${r.auth}${r.authAlt ? `|${r.authAlt.join("|")}` : ""}${r.priced ? ` $${r.priced}` : ""}${r.write ? ` write:${r.action}` : ""}`).join("\n"));
    for (const r of table) expect(ROUTE_AUTHS).toContain(r.auth);
    if (process.env.UPDATE_SNAPSHOT === "1" || !existsSync(SNAP)) writeFileSync(SNAP, `${JSON.stringify(table, null, 2)}\n`);
    expect(table).toEqual(JSON.parse(readFileSync(SNAP, "utf8")));
    // deny by default: with no verifiers registered only public routes answer without 401
    const { app } = await createApp({ verifiers: {} });
    for (const r of table.filter((x) => x.auth !== "public" && x.method === "GET" && !x.path.includes(":"))) {
      const res = await app.request(r.path);
      expect([401, 402, 503]).toContain(res.status);
    }
    await expect(createApp({ routesDir: ROUTES_DIR, extraRoutes: [{ method: "GET", path: "/nope", handler: (c: { json(x: unknown): Response }) => c.json({}) } as never] })).rejects.toThrow(MountError);
  });

  test("writes-gated", async () => {
    const found = (await discoverRoutes()).map((r) => r.spec);
    const writes = found.filter((s) => s.method === "POST" || s.method === "DELETE");
    expect(writes.length).toBeGreaterThan(15);
    for (const s of writes) {
      const key = routeKey(s);
      if (s.write) {
        const kinds = [s.auth, ...(s.authAlt ?? [])];
        expect(kinds.some((k) => k === "owner_sig" || k === "api_key"), key).toBe(true);
        expect(kinds, key).not.toContain("public");
      } else expect(NON_ROUTED[key], `${key} routes to a venue without an edge or is not listed`).toBeDefined();
    }
    // the routed actions: orders, onboarding and direct-mode claims
    expect(found.filter((s) => s.write).map(routeKey).sort()).toEqual(["POST /onboarding/build", "POST /onboarding/submit", "POST /orders/build", "POST /orders/cancel/build", "POST /orders/close-all/build", "POST /orders/submit", "POST /receipts/claim"]);
    // and they never mount without the edge
    await expect(createApp({ routesDir: ROUTES_DIR, edge: undefined })).rejects.toThrow("has no eligibility edge");
    // self-verified routes: each handler file really calls its signature check
    const files = await discoverRoutes();
    for (const [key, what] of Object.entries(SELF_VERIFIED)) {
      const hit = files.find((f) => routeKey(f.spec) === key);
      expect(hit, key).toBeDefined();
      expect(hit!.spec.auth).toBe("owner_sig");
      const fn = /\(([A-Za-z]+)\)/.exec(what)![1]!;
      expect(readFileSync(join(ROUTES_DIR, hit!.file), "utf8"), `${key} -> ${fn}`).toContain(`${fn}(`);
    }
  });
});
