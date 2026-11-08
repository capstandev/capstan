// R11: GET /v1/eligibility?venue= answers { allowed, code, rulesVersion } from the caller's IP and never echoes the IP.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbFixture, geo, IP, NOW, PG, wallet, type DbFixture } from "../../../packages/eligibility/test/helpers";
import { createApp } from "../src/app";
import { createEligibilityRoutes } from "../src/routes/eligibility.routes";

describe.skipIf(!PG)("eligibility route", () => {
  let f: DbFixture;
  const owner = wallet("route-owner");
  let ip = "";
  beforeAll(async () => {
    f = await dbFixture("route");
    await f.declare(owner, ["hyperliquid"]);
  });
  afterAll(() => f?.drop());

  test("no-ip-echo", async () => {
    const routes = createEligibilityRoutes(() => ({ geo, db: f.db, now: () => new Date(NOW), ipOf: () => ip }));
    const { app: a } = await createApp({ routesDir: mkdtempSync(join(tmpdir(), "capstan-routes-")), extraRoutes: routes });
    const cases: [string, string, Record<string, unknown>][] = [
      [IP.US!, "venue=hyperliquid", { allowed: false, code: "GEO_REFUSED", rulesVersion: 1 }],
      [IP.DE!, "venue=hyperliquid", { allowed: false, code: "DECLARATION_MISSING", rulesVersion: 1 }],
      // an unsigned ?owner= never reveals whether that wallet holds a declaration (r1 ELIG-2): the answer is the region's
      [IP.DE!, `venue=hyperliquid&owner=${owner.address}`, { allowed: false, code: "DECLARATION_MISSING", rulesVersion: 1 }],
      [IP.DE6!, `venue=hyperliquid&owner=${owner.address}`, { allowed: false, code: "DECLARATION_MISSING", rulesVersion: 1 }],
      [IP.DE!, "venue=arcus", { allowed: false, code: "VENUE_DATA_ONLY", rulesVersion: 1 }],
      [IP.AE!, "venue=lighter-rh", { allowed: false, code: "GEO_REFUSED", rulesVersion: 1 }],
      ["192.168.1.20", "venue=aster", { allowed: false, code: "GEO_REFUSED", rulesVersion: 1 }],
    ];
    for (const [callerIp, q, want] of cases) {
      ip = callerIp;
      const r = await a.request(`/v1/eligibility?${q}`, { headers: { "x-forwarded-for": callerIp } });
      expect(r.status, q).toBe(200);
      const text = await r.text();
      expect(JSON.parse(text)).toEqual(want);
      expect(text).not.toContain(callerIp);
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(["allowed", "code", "rulesVersion"]);
      r.headers.forEach((v, k) => expect(`${k}: ${v}`).not.toContain(callerIp));
    }
    expect((await a.request("/v1/eligibility?venue=nope")).status).toBe(400);
    expect((await a.request("/v1/eligibility")).status).toBe(400);
    expect((await a.request("/v1/eligibility?venue=aster&owner=0x12")).status).toBe(400);
  });
});
