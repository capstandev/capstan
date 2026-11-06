// R12: IPs are stored only as country codes. No eligibility table has a raw IP column, and a decision row never
// holds the caller's IP in any column.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@capstan/core";
import { getTableColumns } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { decide } from "../src";
import { dbFixture, geo, IP, NOW, PG, wallet, type DbFixture } from "./helpers";

const RAW_IP = /(^|_)(ip|ips|ip_addr|ip_address|remote_addr|client_ip|x_forwarded_for)$/i;

describe("columns", () => {
  test("no-raw-ip", () => {
    for (const [name, table] of [["eligibility_decisions", schema.eligibilityDecisions], ["declarations", schema.declarations], ["eligibility_rules", schema.eligibilityRules]] as const) {
      const cols = Object.values(getTableColumns(table)).map((c) => c.name);
      for (const c of cols) expect(RAW_IP.test(c), `${name}.${c}`).toBe(false);
      if (name === "eligibility_decisions") expect(cols).toContain("ip_country");
    }
    expect(RAW_IP.test("ip")).toBe(true);
    expect(RAW_IP.test("client_ip")).toBe(true);
    expect(RAW_IP.test("ip_country")).toBe(false);
  });
});

describe.skipIf(!PG)("decision rows", () => {
  let f: DbFixture;
  beforeAll(async () => {
    f = await dbFixture("columns");
  });
  afterAll(() => f?.drop());

  test("a decision row holds the country, never the IP", async () => {
    for (const ip of [IP.DE!, IP.US!, IP.SG6!, "10.0.0.1"]) {
      const d = await decide({ ip, owner: wallet("cols").address, venue: "hyperliquid", action: "order" }, { geo, db: f.db, now: () => new Date(NOW) });
      const [row] = await f.db.select().from(schema.eligibilityDecisions).where(eq(schema.eligibilityDecisions.id, d.id));
      expect(JSON.stringify(row)).not.toContain(ip);
      expect(row!.ipCountry).toBe(d.ipCountry);
    }
  });
});
