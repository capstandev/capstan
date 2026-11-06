// spread-scan job: caches rows per approved asset and for all assets (TTL 90 s), never an unapproved equivalence.
import { describe, expect, test } from "bun:test";
import { job, runSpreadScan, scanKey, SCAN_TTL_MS } from "../src/jobs/spread-scan.job";
import { M, setup } from "../../../packages/spreads/test/scan/helpers";

describe("spread-scan job", () => {
  test("caches per asset", async () => {
    expect(job).toMatchObject({ name: "spread-scan", queue: "spreadScan", schedule: { every: 60_000 }, concurrency: 1 });
    const s = setup();
    s.eqs.push({ id: "eq-proposed", canonicalAsset: "CR:BTC", marketIds: [M.hl.id], status: "proposed", notes: null });
    const puts = new Map<string, { v: string; ttl: number }>();
    const r = await runSpreadScan({ deps: s.deps, kv: { put: async (k, v, ttl) => void puts.set(k, { v, ttl }) } });
    expect(r.assets).toBe(1);
    expect([...puts.keys()].sort()).toEqual([scanKey("all"), scanKey("CR:ETH")].sort());
    for (const p of puts.values()) expect(p.ttl).toBe(SCAN_TTL_MS);
    const eth = JSON.parse(puts.get("md:scan:CR:ETH")!.v) as { rows: { equivalenceId: string }[] };
    expect(eth.rows.length).toBe(r.rows);
    expect(eth.rows.every((x) => x.equivalenceId === "eq-eth")).toBe(true);
  });
});
