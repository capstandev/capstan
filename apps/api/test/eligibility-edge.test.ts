// R10: the eligibility edge runs on every write route and attaches eligibilityDecisionId before the handler; the
// mount refuses a write route when no edge is wired; refusals never reach the handler and carry a receipt id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RouteSpec } from "@capstan/core";
import { edgeFor, WRITE_ACTIONS } from "@capstan/eligibility";
import type { Context } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbFixture, geo, IP, NOW, PG, wallet, type DbFixture } from "../../../packages/eligibility/test/helpers";
// the real routes folder now has its own write routes at these paths (todo 30), so these mount alone
const EMPTY_ROUTES = mkdtempSync(join(tmpdir(), "capstan-edge-routes-"));
import { createApp, MountError } from "../src/app";

const get = (c: Context, k: string) => (c as unknown as { get(k: string): unknown }).get(k);

describe("write routes need the edge", () => {
  test("mount refuses a write route without an edge", async () => {
    const dirs: string[] = [];
    const routesDir = (body: string) => {
      const d = mkdtempSync(join(tmpdir(), "capstan-edge-"));
      dirs.push(d);
      writeFileSync(join(d, "w.routes.ts"), body);
      return d;
    };
    try {
      const noEdge = routesDir(`export const routes = [{ method: "POST", path: "/orders/build", auth: "public", write: { action: "order" }, handler: (c) => c.json({ ok: 1 }) }];\n`);
      await expect(createApp({ routesDir: noEdge })).rejects.toThrow(MountError);
      await expect(createApp({ routesDir: noEdge })).rejects.toThrow("w.routes.ts: write route POST /orders/build has no eligibility edge");
      const bad = routesDir(`export const routes = [{ method: "POST", path: "/x", auth: "public", write: { action: "withdraw" }, handler: (c) => c.json({ ok: 1 }) }];\n`);
      await expect(createApp({ routesDir: bad, edge: () => async (_c, next) => next() })).rejects.toThrow("bad write action");
      // an edge that forgets to set the decision id never lets the handler run
      const lazy = routesDir(`export const routes = [{ method: "POST", path: "/x", auth: "public", write: { action: "order" }, handler: (c) => c.json({ ran: true }) }];\n`);
      const { app } = await createApp({ routesDir: lazy, edge: () => async (_c, next) => next() });
      const r = await app.request("/v1/x", { method: "POST" });
      expect(r.status).toBe(500);
      expect(await r.text()).not.toContain("ran");
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!PG)("eligibility edge", () => {
  let f: DbFixture;
  const owner = wallet("edge-owner");
  const seen: { path: string; id: unknown }[] = [];
  const handler = (c: Context) => {
    seen.push({ path: c.req.path, id: get(c, "eligibilityDecisionId") });
    return c.json({ ok: true, decision: get(c, "eligibilityDecisionId") });
  };
  const writes: RouteSpec[] = [
    { method: "POST", path: "/orders/build", auth: "public", write: { action: "order" }, handler },
    { method: "POST", path: "/orders/submit", auth: "public", write: { action: "order" }, handler },
    { method: "POST", path: "/onboarding/build", auth: "public", write: { action: "onboarding" }, handler },
    { method: "POST", path: "/spreads/:id/legs", auth: "public", write: { action: "spread_leg" }, handler },
    { method: "DELETE", path: "/orders/:id", auth: "public", write: { action: "order", venue: (c) => c.req.query("v") ?? null }, handler },
  ];
  let ip = "";
  beforeAll(async () => {
    f = await dbFixture("edge");
    await f.declare(owner, ["hyperliquid", "aster", "lighter-rh"]);
  });
  afterAll(() => f?.drop());
  const app = async () => (await createApp({ routesDir: EMPTY_ROUTES, extraRoutes: writes, edge: edgeFor({ geo, db: f.db, now: () => new Date(NOW), issue: (d) => f.receipts.issue(d), ipOf: () => ip }) })).app;
  const post = (a: Awaited<ReturnType<typeof app>>, path: string, body: unknown, method = "POST") =>
    a.request(`/v1${path}`, { method, headers: { "content-type": "application/json" }, body: method === "DELETE" ? undefined : JSON.stringify(body) });

  test("every-write", async () => {
    const a = await app();
    const { routes } = await createApp({ routesDir: EMPTY_ROUTES, extraRoutes: writes, edge: edgeFor({ geo, db: f.db, now: () => new Date(NOW), issue: (d) => f.receipts.issue(d) }) });
    expect(routes.filter((r) => r.write).length).toBe(writes.length);
    expect(new Set<string>(writes.map((w) => w.write!.action))).toEqual(new Set<string>(WRITE_ACTIONS));
    const body = { venue: "hyperliquid", owner: owner.address, marketId: "hyperliquid:-:BTC" };
    // allowed: each write route ran with a decision id
    ip = IP.DE!;
    for (const w of writes) {
      const path = w.path.replace(":id", "p1") + (w.method === "DELETE" ? "?v=hyperliquid" : "");
      seen.length = 0;
      const r = await post(a, path, body, w.method);
      if (w.method === "DELETE") {
        // a DELETE has no body, so no owner: it needs the authenticated owner and is refused here
        expect(r.status).toBe(403);
        expect((await r.json()).error.code).toBe("DECLARATION_MISSING");
        continue;
      }
      expect(r.status, path).toBe(200);
      const j = (await r.json()) as { decision: string };
      expect(j.decision).toMatch(/^eld_/);
      expect(seen).toEqual([{ path: `/v1${path}`, id: j.decision }]);
    }
    // the authenticated owner wins over the body
    const authed = await createApp({ routesDir: EMPTY_ROUTES, extraRoutes: writes, verifiers: { public: (c) => { (c as unknown as { set(k: string, v: unknown): void }).set("owner", owner.address); return null; } }, edge: edgeFor({ geo, db: f.db, now: () => new Date(NOW), issue: (d) => f.receipts.issue(d), ipOf: () => ip }) });
    expect((await authed.app.request("/v1/orders/p1?v=hyperliquid", { method: "DELETE" })).status).toBe(200);

    // refused: the handler never runs, the answer is 403 with the code and a receipt id
    const refusals: [string, unknown, string][] = [
      [IP.US!, body, "GEO_REFUSED"],
      ["10.9.9.9", body, "GEO_REFUSED"],
      [IP.AE!, { ...body, venue: "lighter-rh", marketId: undefined }, "GEO_REFUSED"],
      [IP.AE!, { ...body, marketId: "hyperliquid:xyz:TSLA" }, "GEO_REFUSED"], // HIP-3 dex market counts as equity by default
      [IP.DE!, { ...body, owner: wallet("nobody").address }, "DECLARATION_MISSING"],
      [IP.DE!, { ...body, venue: "arcus" }, "VENUE_DATA_ONLY"],
    ];
    for (const [callerIp, b, code] of refusals) {
      ip = callerIp;
      for (const w of writes.filter((x) => x.method === "POST")) {
        seen.length = 0;
        const path = w.path.replace(":id", "p1");
        const r = await post(a, path, b);
        expect(r.status, `${code} ${path}`).toBe(403);
        const e = (await r.json()) as { error: { code: string; message: string; receiptId?: string } };
        expect(e.error.code).toBe(code);
        expect(e.error.receiptId).toBeString();
        if (code === "GEO_REFUSED") expect(e.error.message).toBe("Not available in your region.");
        expect(seen).toEqual([]);
        const rc = await f.receipts.get(e.error.receiptId!);
        expect(rc?.action).toBe("refusal");
      }
    }
    // AE on a core crypto market passes
    ip = IP.AE!;
    expect((await post(a, "/orders/build", body)).status).toBe(200);
    // no venue: 400, handler not run
    seen.length = 0;
    expect((await post(a, "/orders/build", { owner: owner.address })).status).toBe(400);
    expect(seen).toEqual([]);
  });
});
