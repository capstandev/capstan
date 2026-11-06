import { describe, expect, test } from "bun:test";
import { addDays, killCriteria } from "../usage";
import { usageDay } from "./helpers";

const LAUNCH = "2026-12-01";
const flat = (endOffset: number, perDay: string) => Array.from({ length: 7 }, (_, i) => usageDay(addDays(LAUNCH, endOffset - 6 + i), { notional: { hl: perDay } }));

describe("thresholds", () => {
  test("thresholds: 24 and 25 approvals on day 14; $29.9M and $30M on day 30; $149.9M and $150M on day 60", () => {
    const d14 = (union: number) => killCriteria([usageDay(addDays(LAUNCH, 14), { approvals: { hl: union, aster: 0, union } })], LAUNCH).day14;
    expect(d14(24).pass).toBe(false);
    expect(d14(25).pass).toBe(true);
    expect(d14(25).value).toBe("25");
    // run-rate = 7-day sum x 30 / 7: $30M needs 7,000,000 over the 7 days
    const d30 = (perDay: string) => killCriteria(flat(30, perDay), LAUNCH).day30;
    expect(d30("1000000").pass).toBe(true); // exactly $30,000,000.000000
    expect(d30("1000000").value).toBe("30000000.000000");
    expect(d30("996666.666666").pass).toBe(false); // $29,899,999.99998
    const d60 = (perDay: string) => killCriteria(flat(60, perDay), LAUNCH).day60;
    expect(d60("5000000").pass).toBe(true); // $150M
    expect(d60("4996666.666666").pass).toBe(false); // $149.9M
    expect(d60("4996666.666666").value!.startsWith("149899999.")).toBeTrue();
  });

  test("a check whose day has no data yet is not decided", () => {
    const v = killCriteria([usageDay(LAUNCH)], LAUNCH);
    expect([v.day14.pass, v.day30.pass, v.day60.pass]).toEqual([null, null, null]);
    expect(v.day30.note).toContain("no data for 2026-12-31");
    // missing days inside the 7-day window count as 0 and are named
    const part = killCriteria([usageDay(addDays(LAUNCH, 30), { notional: { hl: "7000000" } })], LAUNCH).day30;
    expect(part.pass).toBe(true);
    expect(part.note).toContain("6 days missing");
  });
});
