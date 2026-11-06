// R11: close-all is one full-size reduce-only IOC per position per dex; above 1,000 open orders it cancels first.
import { describe, expect, test } from "bun:test";
import { buildCloseAll } from "../../src";
import { fx } from "../helpers";
import { ctx, setup, USER_A } from "./util";

describe("closeall", () => {
  test("reduce-only-full", async () => {
    const { deps } = setup();
    const id = { venue: "hyperliquid" as const, owner: USER_A };
    const builds = await buildCloseAll(id, ctx(), deps);
    const acct = await deps.reader.getAccount(id);
    expect(builds.length).toBe(acct.positions.length);
    for (const [i, b] of builds.entries()) {
      const p = acct.positions[i]!;
      const w = (b.payload.action as any).orders[0];
      expect(b.meta.marketId).toBe(p.marketId);
      expect(w.r).toBe(true);
      expect(w.t).toEqual({ limit: { tif: "Ioc" } });
      expect(w.s).toBe(p.size.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
      expect(w.b).toBe(p.side === "short"); // a short closes with a buy
      expect((b.payload.action as any).builder.f).toBe(20); // the fee applies to closes too
    }
    // core and HIP-3 positions both covered
    expect(builds.some((b) => b.meta.marketId === "hyperliquid:-:BTC")).toBe(true);
    expect(builds.some((b) => b.meta.marketId.startsWith("hyperliquid:xyz:"))).toBe(true);
    expect(builds.some((b) => b.meta.marketId.startsWith("hyperliquid:io:"))).toBe(true);
  });

  test("over-1000-open-orders", async () => {
    const base = fx<any[]>("openOrders_userA_xyz");
    const many = Array.from({ length: 1001 }, (_, i) => ({ ...base[i % base.length], oid: 600000000000 + i }));
    const { deps } = setup((b) => (b.type === "frontendOpenOrders" && b.dex === "xyz" ? many : undefined));
    const builds = await buildCloseAll({ venue: "hyperliquid", owner: USER_A }, ctx(), deps);
    const xyzStart = builds.findIndex((b) => b.meta.marketId.startsWith("hyperliquid:xyz:"));
    const first = builds[xyzStart]!;
    expect(first.meta.kind).toBe("cancel");
    expect((first.payload.action as any).type).toBe("cancel");
    expect((first.payload.action as any).cancels.length).toBe(1001);
    expect((first.payload.action as any).builder).toBeUndefined();
    // the closes follow the cancel; the core dex (few orders) has no cancel
    expect(builds.slice(xyzStart + 1).filter((b) => b.meta.marketId.startsWith("hyperliquid:xyz:")).every((b) => (b.payload.action as any).orders[0].r === true)).toBe(true);
    expect(builds[0]!.meta.kind).toBe("close");
  });
});
