// R5: an unknown IP country refuses writes and allows reads (fail closed). Also the DB-IP parser on real rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, fileGeo, parseDbIpCsv, parseIpv4, parseIpv6, staticGeo, WRITE_ACTIONS } from "../src";
import { dbFixture, FIXTURE_CSV, geo, IP, NOW, PG, wallet, type DbFixture } from "./helpers";

describe("DB-IP Lite parser", () => {
  test("real sample rows resolve, ZZ and gaps are null, IPv6 and mapped IPv4 work", () => {
    expect(geo.country("1.0.1.0")).toBe("CN");
    expect(geo.country("1.0.3.255")).toBe("CN");
    expect(geo.country("1.178.10.77")).toBe("DE");
    expect(geo.country("10.1.2.3")).toBeNull(); // not in the sample: null
    expect(geo.country("0.0.0.1")).toBeNull(); // ZZ
    expect(geo.country("2001:208::1")).toBe("SG");
    expect(geo.country("2001:418:144d:ffff:ffff:ffff:ffff:ffff")).toBe("DE");
    expect(geo.country("::ffff:1.178.10.1")).toBe("DE");
    expect(geo.country("[2001:208::1]")).toBe("SG");
    for (const bad of ["", "1.2.3", "1.2.3.256", "::1::2", "hello", "1.2.3.4.5", "x".repeat(100)]) expect(geo.country(bad), bad).toBeNull();
  });

  test("ip parsing", () => {
    expect(parseIpv4("255.255.255.255")).toBe(2 ** 32 - 1);
    expect(parseIpv6("::")).toBe(0n);
    expect(parseIpv6("::1")).toBe(1n);
    expect(parseIpv6("2001:db8::ff00:42:8329")).toBe(0x20010db8000000000000ff0000428329n);
    expect(parseIpv6("::ffff:192.0.2.1")).toBe(0xffffc0000201n);
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toBe(0x00010002000300040005000600070008n);
    expect(parseIpv6("1:2:3:4:5:6:7")).toBeNull();
    expect(parseIpv6("1::2::3")).toBeNull();
  });

  test("malformed and out-of-order rows are counted and skipped", () => {
    const g = parseDbIpCsv("1.0.0.0,1.0.0.255,AU\nbad line\n0.0.0.0,0.0.0.9,US\n1.0.1.0,1.0.1.255,cn\n2.0.0.0,1.0.0.0,DE\n");
    expect(g.stats).toEqual({ v4Ranges: 2, v6Ranges: 0, malformed: 3 });
    expect(g.country("1.0.1.5")).toBe("CN");
  });

  test("fileGeo reloads on a new file and fails closed when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "capstan-geo-"));
    try {
      const p = join(dir, "geo.csv");
      let t = 0;
      const g = fileGeo(p, { checkEveryMs: 1000, now: () => t });
      expect(g.country("1.0.0.1")).toBeNull();
      expect(g.loaded()).toBe(false);
      writeFileSync(p, "1.0.0.0,1.0.0.255,AU\n");
      t += 1000;
      expect(g.country("1.0.0.1")).toBe("AU");
      writeFileSync(p, "1.0.0.0,1.0.0.255,NZ\n");
      utimesSync(p, new Date(), new Date(Date.now() + 5000));
      expect(g.country("1.0.0.1")).toBe("AU"); // not re-checked inside the window
      t += 1000;
      expect(g.country("1.0.0.1")).toBe("NZ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(FIXTURE_CSV).toContain("2026-11");
  });
});

describe.skipIf(!PG)("unknown country", () => {
  let f: DbFixture;
  const owner = wallet("geo-owner");
  beforeAll(async () => {
    f = await dbFixture("geo");
    await f.declare(owner, ["hyperliquid", "aster"]);
  });
  afterAll(() => f?.drop());

  test("unknown-country", async () => {
    const now = () => new Date(NOW);
    const unknown = staticGeo({});
    for (const ip of ["10.1.2.3", "", "garbage", "0.0.0.1"]) {
      for (const venue of ["hyperliquid", "aster"] as const) {
        for (const action of WRITE_ACTIONS) {
          const d = await decide({ ip, owner: owner.address, venue, action }, { geo: ip === "" ? unknown : geo, db: f.db, now });
          expect(d, `${ip} ${venue} ${action}`).toMatchObject({ allowed: false, code: "GEO_REFUSED", ipCountry: null });
        }
        for (const action of ["read", "quote"] as const) {
          expect(await decide({ ip, venue, action }, { geo, db: f.db, now }), `${ip} ${action}`).toMatchObject({ allowed: true, readOnly: true, ipCountry: null });
        }
      }
    }
    // the same owner from a known allowed country passes
    expect(await decide({ ip: IP.SG!, owner: owner.address, venue: "aster", action: "order" }, { geo, db: f.db, now })).toMatchObject({ allowed: true, ipCountry: "SG" });
    // a geo source answering junk codes counts as unknown
    expect(await decide({ ip: "1.1.1.1", owner: owner.address, venue: "aster", action: "order" }, { geo: staticGeo({ "1.1.1.1": "ZZ" }), db: f.db, now })).toMatchObject({ code: "GEO_REFUSED", ipCountry: null });
    expect(await decide({ ip: "1.1.1.1", owner: owner.address, venue: "aster", action: "order" }, { geo: staticGeo({ "1.1.1.1": "Germany" }), db: f.db, now })).toMatchObject({ code: "GEO_REFUSED", ipCountry: null });
  });
});
