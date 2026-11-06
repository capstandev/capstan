import type { Db } from "@capstan/core";
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoIdentifiers, renderReport, writeReport } from "../report";
import { addDays, writeDay } from "../usage";
import { dbDescribe, freshDb, HOOK_TIMEOUT_MS, usageDay } from "./helpers";

const LAUNCH = "2026-11-01";

describe("report", () => {
  test("no-identifiers: the report has counts only: no address, account index or IP", () => {
    const days = Array.from({ length: 16 }, (_, i) =>
      usageDay(addDays(LAUNCH, i), { approvals: { hl: i, aster: 1, union: i + 1 }, approvalsDb: i + 2, approvalsFlagged: 1, notional: { hl: "1000000", lighter304: "50" }, x402: { payments: 3, usd: "0.03", byRail: { "eip155:8453:0xusdc": "0.03" } }, mcp: { calls: 9, uniqueClients: 2 }, refusals: { REGION_REFUSED: 4 } }),
    );
    const text = renderReport(LAUNCH, addDays(LAUNCH, 15), days, LAUNCH);
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(text).not.toMatch(/account[_ ]?index/i);
    expect(text).not.toContain("0xusdc"); // rails are aggregated in the report table
    expect(text).toContain("Day 14 (2026-11-15): FAIL");
    expect(text).toContain("Flag: on 16 day(s)");
    expect(text).toContain("Run-rate (7 days ending 2026-11-16, x 30 / 7): total $30001500.000000");
    // the scan refuses identifiers if one ever slips in
    expect(() => assertNoIdentifiers(`wallet 0x${"ab".repeat(20)}`)).toThrow();
    expect(() => assertNoIdentifiers("from 203.0.113.9")).toThrow();
    expect(() => assertNoIdentifiers("account_index 12")).toThrow();
    // without a launch day the checks are not evaluated
    expect(renderReport(LAUNCH, LAUNCH, [], null)).toContain("Launch day not set");
  });
});

dbDescribe("report (database)", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await freshDb()), HOOK_TIMEOUT_MS);
  afterAll(async () => await drop());
  test("writes out/usage/<to>.md from usage_daily rows", async () => {
    await writeDay(db, usageDay("2026-11-03", { approvals: { hl: 2, aster: 0, union: 2 }, notional: { hl: "10" } }));
    const dir = mkdtempSync(join(tmpdir(), "capstan-usage-"));
    const r = await writeReport(db, "2026-11-01", "2026-11-05", null, dir);
    expect(r.file).toBe(join(dir, "2026-11-05.md"));
    const text = readFileSync(r.file, "utf8");
    expect(text).toContain("| 2026-11-03 | 2 | 0 | 2 |");
    expect(text).toContain("| 2026-11-01 | no data");
    rmSync(dir, { recursive: true, force: true });
  });
});
