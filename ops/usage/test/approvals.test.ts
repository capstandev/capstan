import { describe, expect, test } from "bun:test";
import { countApprovals, hlInfoReader, type HlReader } from "../usage";
import none from "./fixtures/hl-max-builder-fee-none.json";
import { addr } from "./helpers";

const BUILDER = addr(0xb0);
const fakeHl = (approved: Set<string>): HlReader & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, maxBuilderFee: async (u, b) => (calls.push(`${u}:${b}`), approved.has(u.toLowerCase()) && b === BUILDER ? 20 : 0) };
};

describe("approvals", () => {
  test("union-unique: wallets with HL maxBuilderFee > 0 or an Aster approval; approved on both counts once", async () => {
    const hlApproved = new Set([addr(1), addr(2), addr(3)]);
    const asterList = [addr(3), addr(4), addr(4).toUpperCase().replace("0X", "0x") as `0x${string}`];
    const r = await countApprovals([addr(1), addr(2), addr(3), addr(1), addr(9)], { hl: fakeHl(hlApproved), builder: BUILDER, asterApproved: async () => asterList });
    expect(r.hl).toBe(3);
    expect(r.aster).toBe(2); // addr(4) listed twice in different case
    expect(r.union).toBe(4); // 1, 2, 3, 4: addr(3) on both venues counts once
    expect(r.asterRead).toBeTrue();
    // 24 vs 25 is decided by the union, not the per-venue sum
    expect(r.union).toBeLessThan(r.hl + r.aster);
  });

  test("venue-truth: a database delegation without a venue approval is not counted and is flagged", async () => {
    const hl = fakeHl(new Set([addr(1)]));
    const r = await countApprovals([addr(1), addr(2)], { hl, builder: BUILDER, asterApproved: async () => [addr(5)], dbAster: [addr(5), addr(6)] });
    expect(r.hl).toBe(1);
    expect(r.aster).toBe(1);
    expect(r.union).toBe(2);
    expect(r.flagged).toBe(2); // addr(2) on HL, addr(6) on Aster
    expect(hl.calls.length).toBe(2); // every candidate read from the venue, once
    // Aster not readable here (VPS only): its count is 0 and marked as not read, never guessed from the database
    const off = await countApprovals([addr(1)], { hl: fakeHl(new Set([addr(1)])), builder: BUILDER, dbAster: [addr(7)] });
    expect(off).toEqual({ hl: 1, aster: 0, union: 1, flagged: 0, asterRead: false });
  });

  test("the Hyperliquid reader parses the recorded maxBuilderFee body and refuses odd ones", async () => {
    expect(none).toBe(0);
    const http = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await hlInfoReader(http(none)).maxBuilderFee(addr(1), BUILDER)).toBe(0);
    expect(await hlInfoReader(http(20)).maxBuilderFee(addr(1), BUILDER)).toBe(20);
    await expect(hlInfoReader(http("20")).maxBuilderFee(addr(1), BUILDER)).rejects.toThrow();
    await expect(hlInfoReader(http(null, 500)).maxBuilderFee(addr(1), BUILDER)).rejects.toThrow();
    const seen: string[] = [];
    const spy = (async (u: string, init?: RequestInit) => (seen.push(`${u} ${init?.body}`), new Response("0"))) as unknown as typeof fetch;
    await hlInfoReader(spy).maxBuilderFee(addr(1), BUILDER);
    expect(seen[0]).toBe(`https://api.hyperliquid.xyz/info {"type":"maxBuilderFee","user":"${addr(1)}","builder":"${BUILDER}"}`);
  });

  test.skipIf(!process.env.CAPSTAN_LIVE)("live: maxBuilderFee for an address with no approval is 0", async () => {
    expect(await hlInfoReader().maxBuilderFee(addr(1), addr(2))).toBe(0);
  });
});
