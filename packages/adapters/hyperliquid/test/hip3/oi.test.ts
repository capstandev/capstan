// R6: a size that would push open interest past coinToOiCap is insufficient_depth.
import { describe, expect, test } from "bun:test";
import { buildOrder, createHip3Gate, hip3Quote, oiCheck } from "../../src";
import { fx } from "../helpers";
import { setup } from "../orders/util";
import { ctx, hip3Setup, intent } from "./util";

describe("oi", () => {
  test("cap", async () => {
    const m = { oiCapUsd: "1000000" } as never;
    expect(oiCheck(m, "1", "999999")).toEqual({ ok: true });
    expect(oiCheck(m, "1.01", "999999")).toEqual({ ok: false, code: "insufficient_depth" });
    expect(oiCheck({ oiCapUsd: null } as never, "1e9", "0").ok).toBe(true);
    // live-shaped data: xyz:TSLA near its cap
    const cap = Number(fx<any>("perpDexLimits_xyz").coinToOiCap.find((c: [string, string]) => c[0] === "xyz:TSLA")[1]);
    const meta = fx("metaAndAssetCtxs_xyz");
    const i = meta[0].universe.findIndex((u: { name: string }) => u.name === "xyz:TSLA");
    const mark = Number(meta[1][i].markPx);
    meta[1][i].openInterest = String(Math.floor((cap - 50) / mark)); // about $50 of room
    const near = (b: Record<string, any>) => (b.type === "metaAndAssetCtxs" && b.dex === "xyz" ? meta : undefined);
    const { reader } = setup(near);
    const tsla = await reader.instrument("hyperliquid:xyz:TSLA");
    expect(tsla.oiCapUsd).toBe(String(cap.toFixed(1)));
    const book = await reader.getBook("hyperliquid:xyz:TSLA");
    const small = await hip3Quote({ marketId: tsla.id, side: "buy", sizeBase: "0.01", leverage: 1, holdHours: 1, orderType: "market" }, tsla, book, { reader, gate: createHip3Gate({}) });
    expect(small.status).toBe("ok");
    const big = await hip3Quote({ marketId: tsla.id, side: "buy", sizeBase: "5", leverage: 1, holdHours: 1, orderType: "market" }, tsla, book, { reader, gate: createHip3Gate({}) });
    expect(big.status).toBe("insufficient_depth");
    // the build refuses it too
    const h = hip3Setup(near);
    expect((await buildOrder(intent({ size: "5" }), ctx(), h.deps).catch((e) => e)).message).toMatch(/insufficient_depth/);
  });
});
