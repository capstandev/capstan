// R1, R2, R9: the venue matrix. Every write from every union country is GEO_REFUSED on every venue; allowed
// countries pass with a declaration; AE is refused on Lighter-RH and on Hyperliquid equity markets only; data-only
// venues refuse every write.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { VENUE_IDS, type VenueId } from "@capstan/schema";
import { decide, RULES_V1, UNION_LIST_V1, WRITE_ACTIONS, type EligibilityInput } from "../src";
import { dbFixture, geo, IP, NOW, PG, wallet, type DbFixture } from "./helpers";

const EXEC: VenueId[] = ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster"];
const DATA_ONLY: VenueId[] = ["variational", "arcus"];
const now = () => new Date(NOW);

describe.skipIf(!PG)("venue matrix", () => {
  let f: DbFixture;
  const owner = wallet("matrix-owner");
  beforeAll(async () => {
    f = await dbFixture("matrix");
    await f.declare(owner, [...VENUE_IDS]);
  });
  afterAll(() => f?.drop());
  const run = (i: Omit<EligibilityInput, "owner"> & { owner?: EligibilityInput["owner"] }) => decide({ owner: owner.address, ...i }, { geo, db: f.db, now });

  test("per-venue", async () => {
    let refused = 0;
    for (const venue of EXEC) {
      for (const c of UNION_LIST_V1) {
        expect(IP[c], `fixture IP for ${c}`).toBeDefined();
        for (const action of WRITE_ACTIONS) {
          const d = await run({ ip: IP[c]!, venue, action });
          expect(d, `${venue} ${c} ${action}`).toMatchObject({ allowed: false, code: "GEO_REFUSED", ipCountry: c, rulesVersion: 1 });
          refused++;
        }
      }
      for (const c of ["DE", "SG", "DE6", "SG6"]) {
        for (const action of WRITE_ACTIONS) {
          const d = await run({ ip: IP[c]!, venue, action });
          expect(d, `${venue} ${c} ${action}`).toMatchObject({ allowed: true, ipCountry: c.slice(0, 2) });
          expect(d.code).toBeUndefined();
          expect(d.declarationId).toMatch(/^dcl_/);
        }
      }
      // the same allowed country without a declaration is refused
      const anon = await decide({ ip: IP.DE!, venue, action: "order" }, { geo, db: f.db, now });
      expect(anon).toMatchObject({ allowed: false, code: "DECLARATION_MISSING" });
    }
    expect(refused).toBe(EXEC.length * UNION_LIST_V1.length * WRITE_ACTIONS.length);
    // every venue's v1 rule lists the whole union list
    for (const r of RULES_V1) for (const c of UNION_LIST_V1) expect(r.refusedCountries, r.venue).toContain(c);
  });

  test("ae-rule", async () => {
    for (const action of WRITE_ACTIONS) {
      expect(await run({ ip: IP.AE!, venue: "lighter-rh", action }), `rh ${action}`).toMatchObject({ allowed: false, code: "GEO_REFUSED", ipCountry: "AE" });
      expect(await run({ ip: IP.AE6!, venue: "lighter-rh", action }), `rh v6 ${action}`).toMatchObject({ allowed: false, code: "GEO_REFUSED" });
      expect(await run({ ip: IP.AE!, venue: "hyperliquid", action, marketId: "hyperliquid:xyz:TSLA", isEquityMarket: true }), `hl equity ${action}`).toMatchObject({ allowed: false, code: "GEO_REFUSED" });
      expect(await run({ ip: IP.AE!, venue: "hyperliquid", action, marketId: "hyperliquid:-:BTC", isEquityMarket: false }), `hl crypto ${action}`).toMatchObject({ allowed: true });
      expect(await run({ ip: IP.AE!, venue: "lighter-mainnet", action }), `lighter 304 ${action}`).toMatchObject({ allowed: true });
      expect(await run({ ip: IP.AE!, venue: "aster", action }), `aster ${action}`).toMatchObject({ allowed: true });
    }
    // reads stay open, marked read-only
    expect(await run({ ip: IP.AE!, venue: "lighter-rh", action: "quote" })).toMatchObject({ allowed: true, readOnly: true });
    expect(await run({ ip: IP.AE!, venue: "hyperliquid", action: "read", isEquityMarket: true })).toMatchObject({ allowed: true, readOnly: true });
    expect((await run({ ip: IP.AE!, venue: "hyperliquid", action: "read", isEquityMarket: false })).readOnly).toBeUndefined();
  });

  test("data-only", async () => {
    for (const venue of DATA_ONLY) {
      for (const ip of [IP.DE!, IP.US!, "not-an-ip"]) {
        for (const action of WRITE_ACTIONS) {
          expect(await run({ ip, venue, action }), `${venue} ${ip} ${action}`).toMatchObject({ allowed: false, code: "VENUE_DATA_ONLY" });
        }
      }
      expect(await run({ ip: IP.DE!, venue, action: "read" })).toMatchObject({ allowed: true });
      expect(await run({ ip: IP.DE!, venue, action: "quote" })).toMatchObject({ allowed: true });
    }
  });

  test("reads from refused regions are allowed and read-only", async () => {
    for (const venue of EXEC) {
      for (const c of UNION_LIST_V1) {
        for (const action of ["quote", "read"] as const) {
          expect(await run({ ip: IP[c]!, venue, action }), `${venue} ${c} ${action}`).toMatchObject({ allowed: true, readOnly: true });
        }
      }
    }
  });
});
