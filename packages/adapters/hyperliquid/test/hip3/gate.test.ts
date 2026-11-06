// R3, R7, R8: only xyz, io, para execute; the gate can only switch a dex off; no builder key when it is off.
import { describe, expect, test } from "bun:test";
import { buildOrder, createHip3Gate, HIP3_WIRING, toReceiptDraft } from "../../src";
import { fx } from "../helpers";
import { sign } from "../orders/util";
import { ctx, hip3Setup, intent } from "./util";

describe("gate", () => {
  test("wiring-order", async () => {
    expect([...HIP3_WIRING]).toEqual(["xyz", "io", "para"]);
    // turn one market live on each dex so the build reaches the HIP-3 rules
    const live = (dex: string) => {
      const m = fx(`metaAndAssetCtxs_${dex}`);
      m[0].universe[0].isDelisted = false;
      return m;
    };
    const { deps, reader } = hip3Setup((b) => {
      if (b.type === "metaAndAssetCtxs" && ["flx", "vntl", "hyna", "km", "abcd", "cash"].includes(b.dex)) return live(b.dex);
      if (b.type === "clearinghouseState" && b.dex === "para") return fx("clearinghouseState_userA_io"); // some para collateral
      return undefined;
    });
    const ms = await reader.listMarkets();
    for (const dex of ["flx", "vntl", "hyna", "km", "abcd", "cash", "mkts"]) {
      const m = ms.find((x) => x.dex === dex && x.status === "active")!;
      expect(m).toBeDefined();
      const err = await buildOrder(intent({ marketId: m.id }), ctx(), deps).catch((e) => e);
      expect(err.code).toBe("MARKET_NOT_EXECUTABLE");
    }
    for (const id of ["hyperliquid:xyz:TSLA", "hyperliquid:io:OAI", ms.find((x) => x.dex === "para" && x.status === "active")!.id]) {
      const b = await buildOrder(intent({ marketId: id, size: "0.1" }), ctx(), deps);
      expect(b.meta.marketId).toBe(id);
    }
    // not executable in the catalog: refused even on a wired dex
    const { deps: d2 } = hip3Setup(undefined, { isExecutable: () => false });
    expect((await buildOrder(intent(), ctx(), d2).catch((e) => e)).code).toBe("MARKET_NOT_EXECUTABLE");
  });

  test("only-off", () => {
    const g = createHip3Gate({ HIP3_BUILDER_OFF: "io" });
    expect(g.builderFeeSupported("xyz")).toBe(true);
    expect(g.builderFeeSupported("io")).toBe(false);
    expect(g.builderFeeSupported("para")).toBe(true);
    g.apply({ io: true, xyz: true, para: false });
    expect(g.builderFeeSupported("io")).toBe(false); // a true never re-enables
    expect(g.builderFeeSupported("xyz")).toBe(true);
    expect(g.builderFeeSupported("para")).toBe(false);
    g.apply({ para: true });
    expect(g.builderFeeSupported("para")).toBe(false);
    expect(g.off()).toEqual(["io", "para"]);
  });

  test("no-field-when-off", async () => {
    const { deps } = hip3Setup(undefined, {}, { HIP3_BUILDER_OFF: "xyz" });
    const b = await buildOrder(intent(), ctx(), deps);
    expect("builder" in (b.payload.action as object)).toBe(false);
    expect(b.preview.builderFeeBps).toBe(0);
    expect(b.preview.builderFee).toBeNull();
    expect(b.meta.builder).toBeNull();
    expect(toReceiptDraft(b, sign(b), { status: "ok" }).builder).toBeNull();
    expect(b.preview.warnings).toContain("builder fee off on xyz");
    // on: the field is there
    const on = hip3Setup();
    expect((await buildOrder(intent(), ctx(), on.deps)).payload.action).toHaveProperty("builder");
  });
});
