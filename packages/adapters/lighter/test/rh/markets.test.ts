// R8: RH market ids never reuse mainnet indexes: an index that exists on both exchanges maps to two different ids.
import { afterAll, describe, expect, test } from "bun:test";
import { LIGHTER_CONFIGS } from "../../src";
import { fakeLighter, readerFor } from "../helpers";

const main = fakeLighter("lighter-304");
const rh = fakeLighter("lighter-466324");
afterAll(() => {
  main.stop();
  rh.stop();
});

describe("rh markets", () => {
  test("index-not-shared", async () => {
    const m = await readerFor(LIGHTER_CONFIGS.mainnet, main.url).listMarkets();
    const r = await readerFor(LIGHTER_CONFIGS.rh, rh.url).listMarkets();
    const shared = r.filter((x) => m.some((y) => y.venueIndex === x.venueIndex));
    expect(shared.length).toBeGreaterThan(10);
    for (const x of shared) {
      const y = m.find((z) => z.venueIndex === x.venueIndex)!;
      expect(x.id).not.toBe(y.id);
      expect(x.id.startsWith("lighter-rh:")).toBe(true);
      expect(y.id.startsWith("lighter-mainnet:")).toBe(true);
    }
    // index 2 is SOL on mainnet and HYPE on RH (recorded 2026-11-06): same number, different markets
    expect(m.find((z) => z.venueIndex === 2)?.venueSymbol).toBe("SOL");
    expect(r.find((z) => z.venueIndex === 2)?.venueSymbol).toBe("HYPE");
    // the same symbol on both is still two markets
    expect(r.find((z) => z.venueSymbol === "ETH")!.id).toBe("lighter-rh:-:ETH");
    expect(m.find((z) => z.venueSymbol === "ETH")!.id).toBe("lighter-mainnet:-:ETH");
  });
});
