import { closeDb, createDb, createTempDatabase, type Db } from "@capstan/core";
import { db as schema } from "@capstan/schema";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containsIp, insertRequestLog, retainLogs, retainTables } from "../src";

const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 10, 6, 2, 15, 0));
const IP4 = "203.0.113.42";
const IP6 = "2001:db8:85a3::8a2e:370:7334";

function writeLogs(dir: string) {
  mkdirSync(join(dir, "api"), { recursive: true });
  mkdirSync(join(dir, "caddy"), { recursive: true });
  const old = new Date(NOW.getTime() - DAY).toISOString(); // 1 day old now; 9 days old once the clock moves 8 days
  const api = [
    JSON.stringify({ ts: old, level: "info", service: "api", msg: "request", ip: IP4, ip_country: "DE", route: "/v1/markets" }),
    JSON.stringify({ ts: old, level: "warn", service: "api", msg: `rate limited ${IP6}`, client_ip: IP6 }),
  ];
  writeFileSync(join(dir, "api", "api.jsonl"), api.join("\n") + "\n");
  // Caddy access log: unix seconds, nested remote_ip and X-Forwarded-For headers
  const caddy = JSON.stringify({ ts: (NOW.getTime() - DAY) / 1000, request: { remote_ip: IP4, headers: { "X-Forwarded-For": [IP4] } }, status: 200 });
  writeFileSync(join(dir, "caddy", "access.log"), caddy + "\n");
  // a plain-text rotated file
  writeFileSync(join(dir, "api", "api.jsonl.1"), `plain text line from ${IP4}\n`);
  const oldMtime = (NOW.getTime() - DAY) / 1000;
  utimesSync(join(dir, "api", "api.jsonl.1"), oldMtime, oldMtime);
}

const dbTest = process.env.DATABASE_URL ? describe : describe.skip;

describe("retention (logs)", () => {
  test("records younger than 7 days keep their IP; older ones keep only the country", () => {
    const dir = mkdtempSync(join(tmpdir(), "capstan-ret-"));
    writeLogs(dir);
    const first = retainLogs({ dir, now: NOW });
    expect(first.recordsStripped).toBe(0); // 1 day old: untouched
    expect(readFileSync(join(dir, "api", "api.jsonl"), "utf8")).toContain(IP4);
    const later = new Date(NOW.getTime() + 8 * DAY);
    const r = retainLogs({ dir, now: later, country: () => "NL" });
    expect(r.filesRewritten).toBe(3);
    for (const f of ["api/api.jsonl", "api/api.jsonl.1", "caddy/access.log"]) expect(containsIp(readFileSync(join(dir, f), "utf8"))).toBeFalse();
    const lines = readFileSync(join(dir, "api", "api.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].ip_country).toBe("DE"); // kept as recorded
    expect(lines[1].ip_country).toBe("NL"); // looked up before the IP was dropped
    expect(lines[0].route).toBe("/v1/markets");
    // idempotent: a second run changes nothing
    expect(retainLogs({ dir, now: later }).filesRewritten).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

dbTest("retention (tables)", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTempDatabase(process.env.DATABASE_URL!, { migrated: true, prefix: "capstan_tel" });
    db = createDb(t.url, { max: 2 });
    drop = t.drop;
  }, 30_000);
  afterAll(async () => {
    await closeDb(db);
    await drop();
  });

  test("country-only-after-7d: after the retention run with a clock 8 days ahead, no raw IP remains in logs or tables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capstan-ret-"));
    writeLogs(dir);
    await insertRequestLog(db, { service: "api", route: "/v1/markets", clientId: "key_1", ip: IP4, ipCountry: "DE", status: 200, ts: new Date(NOW.getTime() - DAY) }, "salt");
    await insertRequestLog(db, { service: "mcp", route: "tools/call", clientId: "c_9", ip: IP6, status: 200, ts: new Date(NOW.getTime() - DAY) }, "salt");
    await db.insert(schema.eligibilityDecisions).values({ id: "ed1", ipCountry: "FR", rulesVersion: 1, allowed: true, ts: new Date(NOW.getTime() - DAY) });

    const later = new Date(NOW.getTime() + 8 * DAY);
    retainLogs({ dir, now: later });
    const t = await retainTables(db, later);
    expect(t.requestLogs).toBe(2);

    const rows = await db.select().from(schema.requestLogs);
    expect(rows.every((r) => r.ip === null)).toBeTrue();
    expect(rows.map((r) => r.ipCountry).sort()).toEqual(["DE", "ZZ"]);
    expect(rows.every((r) => r.clientHash && !r.clientHash.includes("key_1"))).toBeTrue();
    const all = JSON.stringify(await db.select().from(schema.eligibilityDecisions)) + JSON.stringify(rows);
    expect(containsIp(all)).toBeFalse();
    expect(all).toContain("FR");
    for (const f of ["api/api.jsonl", "api/api.jsonl.1", "caddy/access.log"]) expect(containsIp(readFileSync(join(dir, f), "utf8"))).toBeFalse();
    // a fresh row stays as it is
    await insertRequestLog(db, { service: "api", route: "/v1/quote", ip: IP4, status: 200, ts: later }, "salt");
    expect((await retainTables(db, later)).requestLogs).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
