// R2: HIP-3 asset ids from the raw perpDexs order and raw universe index.
import { describe, expect, test } from "bun:test";
import { assetId } from "../src";
import { fixtureReader } from "./helpers";

describe("assets", () => {
  test("hip3-asset-ids", async () => {
    const { reader } = fixtureReader();
    const all = await reader.listMarkets();
    const by = (sym: string) => all.find((m) => m.venueSymbol === sym)!;
    expect(by("xyz:XYZ100").assetId).toBe(110000);
    expect(by("xyz:TSLA").assetId).toBe(110001);
    const firstPara = all.filter((m) => m.dex === "para").sort((a, b) => a.venueIndex! - b.venueIndex!)[0]!;
    expect(firstPara.assetId).toBe(180000);
    expect(by("io:OAI").assetId).toBe(200000);
    // para:H100 (index 3) is delisted; para:AVGO at index 4 still gets +4
    expect(by("para:H100").status).toBe("delisted");
    expect(by("para:AVGO").venueIndex).toBe(4);
    expect(by("para:AVGO").assetId).toBe(180004);
    expect(assetId(0, 5)).toBe(5);
    expect(assetId(1, 0)).toBe(110000);
    expect(assetId(10, 0)).toBe(200000);
    expect(() => assetId(1, 10000)).toThrow();
    expect(() => assetId(-1, 0)).toThrow();
  });
});
