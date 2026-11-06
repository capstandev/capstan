// R1 and R2: every server-built payload is compared field by field with the intent, and the digest is recomputed.
import { describe, expect, test } from "bun:test";
import type { OrderIntent, UnsignedVenuePayload } from "@capstan/schema";
import { digestTrade, queryString, type Param } from "@capstan/signer-aster";
import { formatPrice, formatSize, l1Digest, type HlOrderAction } from "@capstan/signer-hl";
import { checkBuild, type CheckContext } from "../src/check";
import { bound } from "../src/dec";
import { AGENT, ASTER_REF, asterBuild, BUILDER_HL, HL_REF, HL_SPEC, hlBuild, LIGHTER_ACCT, LIGHTER_REF, LIGHTER_SPEC, lighterBuild, labelAddr, OWNER, pick, randomIntent, rng, T0, testPins } from "./helpers";

const pins = testPins({ lighterIntegratorIndex: { "lighter-mainnet": null } });
const hlCtx = (o: Partial<CheckContext> = {}): CheckContext => ({ venue: "hyperliquid", approvedMax: 3, pins, nowMs: T0, market: HL_SPEC, refPx: HL_REF, identity: { owner: OWNER, agentAddress: AGENT }, ...o });
const asterCtx = (o: Partial<CheckContext> = {}): CheckContext => ({ venue: "aster", approvedMax: 3, pins, nowMs: T0, refPx: ASTER_REF, identity: { owner: OWNER, agentAddress: AGENT }, ...o });
const lighterCtx = (o: Partial<CheckContext> = {}): CheckContext => ({ venue: "lighter-mainnet", approvedMax: 0, pins, nowMs: T0, market: LIGHTER_SPEC, refPx: LIGHTER_REF, identity: { owner: OWNER, ...LIGHTER_ACCT }, ...o });

function redigestHl(b: UnsignedVenuePayload): UnsignedVenuePayload {
  const p = b.payload as { action: HlOrderAction; nonce: number; expiresAfter: number };
  return { ...b, digest: l1Digest(p.action, null, p.nonce, "Mainnet", p.expiresAfter) };
}
function redigestAster(b: UnsignedVenuePayload): UnsignedVenuePayload {
  const p = b.payload as { params: Param[]; chainId: 1666 };
  return { ...b, digest: digestTrade(queryString(p.params), 1666) };
}
const far = (i: OrderIntent, ref: string, extraBps: number) => bound(i.type === "limit" ? i.limitPx! : bound(ref, i.maxSlippageBps + 25, i.side), extraBps, i.side);

type Tamper = { field: string; apply: (i: OrderIntent) => UnsignedVenuePayload; ctx?: Partial<CheckContext> };

function hlTampers(i: OrderIntent): Tamper[] {
  const t = (field: string, m: (a: HlOrderAction) => void, ctx?: Partial<CheckContext>): Tamper => ({ field, apply: () => redigestHl(hlBuild(i, { mutate: m })), ...(ctx ? { ctx } : {}) });
  const o = (a: HlOrderAction) => a.orders[0]!;
  return [
    t("market", (a) => (o(a).a = 1)),
    t("side", (a) => (o(a).b = !o(a).b)),
    t("size", (a) => (o(a).s = formatSize(String(Number(o(a).s) * 2 + 0.001), 5))),
    t("price", (a) => (o(a).p = formatPrice(far(i, HL_REF, 150), 5, i.side === "buy" ? "up" : "down"))),
    t("reduceOnly", (a) => (o(a).r = !o(a).r)),
    t("tif", (a) => ((o(a).t as { limit: { tif: string } }).limit.tif = (o(a).t as { limit: { tif: string } }).limit.tif === "Gtc" ? "Alo" : "Gtc")),
    t("builder.address", (a) => (a.builder!.b = labelAddr("attacker"))),
    t("builder.fee", () => undefined, { approvedMax: 1 }), // f=20 (2 bps) above a 1 bps approval
    t("builder.fee", (a) => (a.builder!.f = 15)), // not in {10, 20}
    t("builder.fee", (a) => (a.builder!.f = 30)),
  ];
}

function asterTampers(i: OrderIntent): Tamper[] {
  const set = (k: string, v: string) => (p: Param[]) => p.map(([a, b]) => (a === k ? [a, v] : [a, b]) as Param);
  const t = (field: string, m: (p: Param[]) => Param[], ctx?: Partial<CheckContext>): Tamper => ({ field, apply: () => redigestAster(asterBuild(i, { mutate: m })), ...(ctx ? { ctx } : {}) });
  const tifNow = i.type === "market" ? "IOC" : ({ ioc: "IOC", gtc: "GTC", alo: "GTX" } as const)[i.tif];
  return [
    t("market", set("symbol", "ETHUSDT")),
    t("side", set("side", i.side === "buy" ? "SELL" : "BUY")),
    t("size", set("quantity", String(Number(i.size) + 1))),
    t("price", set("price", far(i, ASTER_REF, 150).replace(/(\.\d)\d*$/, "$1"))),
    t("reduceOnly", (p) => (i.reduceOnly ? p.filter(([k]) => k !== "reduceOnly") : [...p.slice(0, 6), ["reduceOnly", "true"] as Param, ...p.slice(6)])),
    t("tif", set("timeInForce", tifNow === "GTC" ? "GTX" : "GTC")),
    t("builder.address", set("builder", labelAddr("attacker"))),
    t("builder.fee", (p) => p, { approvedMax: 1 }),
    t("builder.fee", set("feeRate", "0.00015")),
    t("builder.fee", set("feeRate", "0.0003")),
  ];
}

function lighterTampers(i: OrderIntent): Tamper[] {
  const t = (field: string, m: (a: Record<string, number | boolean>) => void, ctx?: Partial<CheckContext>): Tamper => ({ field, apply: () => lighterBuild(i, { mutate: m }), ...(ctx ? { ctx } : {}) });
  return [
    t("market", (a) => (a.marketIndex = 1)),
    t("side", (a) => (a.isAsk = !a.isAsk)),
    t("size", (a) => (a.baseAmount = (a.baseAmount as number) + 1)),
    t("price", (a) => (a.price = Number(far(i, LIGHTER_REF, 150).split(".")[0]) * 100 + (i.side === "buy" ? 1 : -1))),
    t("reduceOnly", (a) => (a.reduceOnly = !a.reduceOnly)),
    t("tif", (a) => (a.timeInForce = ((a.timeInForce as number) + 1) % 3)),
    t("builder.address", (a) => (a.integratorAccountIndex = 999)),
    t("builder.fee", (a) => (a.integratorTakerFee = 1)),
    t("builder.fee", (a) => (a.integratorMakerFee = 5)),
  ];
}

describe("checkBuild", () => {
  test("tamper-per-venue", () => {
    const venues = [
      { name: "hyperliquid", ctx: hlCtx, build: (i: OrderIntent) => hlBuild(i), tampers: hlTampers, market: HL_SPEC.marketId, ref: HL_REF, dp: 5 },
      { name: "aster", ctx: asterCtx, build: (i: OrderIntent) => asterBuild(i), tampers: asterTampers, market: "aster:-:BTCUSDT", ref: ASTER_REF, dp: 3 },
      { name: "lighter", ctx: lighterCtx, build: (i: OrderIntent) => lighterBuild(i), tampers: lighterTampers, market: LIGHTER_SPEC.marketId, ref: LIGHTER_REF, dp: 4 },
    ];
    let refused = 0;
    const seen = new Map<string, Set<string>>();
    for (const v of venues) {
      const r = rng(0xc0ffee + v.name.length);
      seen.set(v.name, new Set());
      for (let n = 0; n < 300; n++) {
        const i = randomIntent(r, v.market, v.ref, v.dp);
        // the honest build passes and yields the build's own digest
        const ok = checkBuild(i, v.build(i), v.ctx());
        if (!ok.ok) throw new Error(`${v.name} honest build refused: ${ok.field} ${JSON.stringify(i)}`);
        const tm = pick(r, v.tampers(i));
        const res = checkBuild(i, tm.apply(i), v.ctx(tm.ctx));
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.code).toBe("PAYLOAD_MISMATCH");
          if (res.field !== tm.field) throw new Error(`${v.name}: tamper ${tm.field} refused as ${res.field} for ${JSON.stringify(i)}`);
          refused++;
          seen.get(v.name)!.add(res.field);
        }
      }
    }
    expect(refused).toBe(900);
    // every tamper kind was drawn at least once per venue
    expect([...seen.get("hyperliquid")!].sort()).toEqual(["builder.address", "builder.fee", "market", "price", "reduceOnly", "side", "size", "tif"]);
    expect([...seen.get("aster")!].sort()).toEqual(["builder.address", "builder.fee", "market", "price", "reduceOnly", "side", "size", "tif"]);
    expect([...seen.get("lighter")!].sort()).toEqual(["builder.address", "builder.fee", "market", "price", "reduceOnly", "side", "size", "tif"]);
  });

  test("digest-mismatch", () => {
    const i: OrderIntent = { marketId: HL_SPEC.marketId, side: "buy", size: "0.01", type: "limit", limitPx: "76000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 };
    const good = hlBuild(i);
    expect(checkBuild(i, good, hlCtx())).toEqual({ ok: true, digest: good.digest });
    // every field matches, but the server's digest is for something else (another nonce, network or action)
    const p = good.payload as { action: HlOrderAction; nonce: number; expiresAfter: number };
    for (const wrong of [l1Digest(p.action, null, p.nonce + 1, "Mainnet", p.expiresAfter), l1Digest(p.action, null, p.nonce, "Testnet", p.expiresAfter), `0x${"11".repeat(32)}`]) {
      expect(checkBuild(i, { ...good, digest: wrong as `0x${string}` }, hlCtx())).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "digest" });
    }
    const ai: OrderIntent = { marketId: "aster:-:BTCUSDT", side: "sell", size: "0.002", type: "limit", limitPx: "76500.1", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 };
    const ab = asterBuild(ai);
    expect(checkBuild(ai, ab, asterCtx()).ok).toBe(true);
    const q = queryString((ab.payload as { params: Param[] }).params);
    expect(checkBuild(ai, { ...ab, digest: digestTrade(q, 714) }, asterCtx())).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "digest" });
  });

  test("expired and over-long builds", () => {
    const i: OrderIntent = { marketId: HL_SPEC.marketId, side: "buy", size: "0.01", type: "limit", limitPx: "76000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 };
    expect(checkBuild(i, hlBuild(i), hlCtx({ nowMs: T0 + 31_000 }))).toEqual({ ok: false, code: "BUILD_EXPIRED", field: "expiresAt" });
    const long = hlBuild(i);
    expect(checkBuild(i, { ...long, expiresAt: T0 + 3_600_000 }, hlCtx()).ok).toBe(false);
  });

  test("market orders need an independent reference and stay inside it", () => {
    const i: OrderIntent = { marketId: HL_SPEC.marketId, side: "buy", size: "0.01", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 };
    expect(checkBuild(i, hlBuild(i), hlCtx()).ok).toBe(true);
    expect(checkBuild(i, hlBuild(i), hlCtx({ refPx: null }))).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "price" });
    // the server used a reference 2% above the venue's: refused
    expect(checkBuild(i, hlBuild(i, { ref: "77700" }), hlCtx())).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "price" });
  });

  test("no builder fee without an approval; a missing builder field is allowed", () => {
    const i: OrderIntent = { marketId: HL_SPEC.marketId, side: "sell", size: "0.01", type: "limit", limitPx: "77000", tif: "alo", reduceOnly: true, maxSlippageBps: 50 };
    expect(checkBuild(i, hlBuild(i), hlCtx({ approvedMax: null }))).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "builder.fee" });
    expect(checkBuild(i, hlBuild(i, { builder: null }), hlCtx({ approvedMax: null })).ok).toBe(true);
    expect(checkBuild(i, hlBuild(i, { f: 10 }), hlCtx({ approvedMax: 1 })).ok).toBe(true);
    expect(BUILDER_HL).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
