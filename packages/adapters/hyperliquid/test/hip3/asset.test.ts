// R1, R2: HIP-3 asset ids, mainnet and testnet, delisted entries counted.
import { describe, expect, test } from "bun:test";
import { buildOrder, hip3AssetId } from "../../src";
import { fx } from "../helpers";
import { setup } from "../orders/util";
import { ctx, hip3Setup, intent } from "./util";

describe("asset", () => {
  test("ids", async () => {
    const { reader } = setup();
    const ms = await reader.listMarkets();
    const by = (s: string) => ms.find((m) => m.venueSymbol === s)!;
    expect(by("xyz:XYZ100").assetId).toBe(110000);
    expect(by("xyz:TSLA").assetId).toBe(110001);
    expect(ms.filter((m) => m.dex === "para").sort((a, b) => a.venueIndex! - b.venueIndex!)[0]!.assetId).toBe(180000);
    expect(by("io:OAI").assetId).toBe(200000);
    expect(hip3AssetId(1, 1)).toBe(110001);
    expect(() => hip3AssetId(0, 1)).toThrow();
    // testnet: test:ABC is dex 1, position 0
    const tmeta = fx("meta_testnet_test");
    const t = setup((b) => {
      if (b.type === "perpDexs") return fx("perpDexs_testnet");
      if (b.type === "metaAndAssetCtxs") return b.dex === "test" ? [tmeta, [{ funding: "0", openInterest: "0", prevDayPx: "1", dayNtlVlm: "0", premium: null, oraclePx: "1", markPx: "1", midPx: "1", impactPxs: null, dayBaseVlm: "0" }]] : [{ universe: [], collateralToken: 0 }, []];
      return undefined;
    });
    const tm = (await t.reader.listMarkets()).find((m) => m.venueSymbol === "test:ABC")!;
    expect(tm.assetId).toBe(110000);
    expect(tm.id).toBe("hyperliquid:test:ABC");
    // the built order carries the stored asset id
    const h = hip3Setup();
    const b = await buildOrder(intent(), ctx(), h.deps);
    expect((b.payload.action as any).orders[0].a).toBe(110001);
  });

  test("delisted-counted", async () => {
    const meta = fx("metaAndAssetCtxs_xyz");
    meta[0].universe[3].isDelisted = true;
    const { reader } = setup((b) => (b.type === "metaAndAssetCtxs" && b.dex === "xyz" ? meta : undefined));
    const ms = (await reader.listMarkets()).filter((m) => m.dex === "xyz");
    const at = (i: number) => ms.find((m) => m.venueIndex === i)!;
    expect(at(3).status).toBe("delisted");
    expect(at(4).status).toBe("active");
    expect(at(4).assetId).toBe(110004);
    expect(at(5).assetId).toBe(110005);
  });
});
