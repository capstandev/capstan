import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Db } from "@capstan/core";
import { db as schema } from "@capstan/schema";
import { asc, eq } from "drizzle-orm";
import { setDexExecutable, setExecutable } from "../src/review";
import { syncMarkets, type MarketSource } from "../src/sync";
import { dbDescribe, freshDb, HOOK_TIMEOUT_MS } from "./db-helper";
import { allFixtureSources, asterSource, hyperliquidSource, lighterSource, staticSource } from "./fixture-sources";

const T1 = new Date("2026-11-06T00:15:00Z");
const T2 = new Date("2026-11-07T00:15:00Z");
let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: Db;

async function market(id: string) {
  const [r] = await db.select().from(schema.markets).where(eq(schema.markets.id, id));
  return r;
}

dbDescribe("syncMarkets", () => {
  beforeEach(async () => {
    ctx = await freshDb();
    db = ctx.db;
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await ctx.drop();
  }, HOOK_TIMEOUT_MS);

  test("ticker-collision", async () => {
    const dexes = [{ dex: "io", index: 10, liveMarkets: 1 }, { dex: "vntl", index: 3, liveMarkets: 1 }];
    const src = staticSource("hyperliquid", [{ venueSymbol: "io:ANTH", dex: "io" }, { venueSymbol: "vntl:ANTHROPIC", dex: "vntl" }], dexes);
    await syncMarkets(db, [src], T1);
    await syncMarkets(db, [src], T2);
    expect((await market("hyperliquid:io:ANTH"))!.canonicalAsset).toBeNull();
    expect((await market("hyperliquid:vntl:ANTHROPIC"))!.canonicalAsset).toBeNull();
    expect(await db.select().from(schema.equivalences)).toEqual([]);
    expect((await db.select().from(schema.marketAliases)).filter((a) => a.status !== "proposed")).toEqual([]);
  });

  test("delist-keeps-row", async () => {
    await syncMarkets(db, [hyperliquidSource()], T1);
    expect((await market("hyperliquid:-:BTC"))!.status).toBe("active");
    const r = await syncMarkets(db, [hyperliquidSource({ drop: ["hyperliquid:-:BTC"] })], T2);
    expect(r.delisted).toEqual(["hyperliquid:-:BTC"]);
    const btc = await market("hyperliquid:-:BTC");
    expect(btc).toBeDefined(); // the row stays, so positions in it still show
    expect(btc!.status).toBe("delisted");
    expect(btc!.executable).toBe(false);
    expect(btc!.canonicalAsset).toBe("CR:BTC");
  });

  test("dex-gone-reduce-only", async () => {
    await syncMarkets(db, [hyperliquidSource()], T1);
    const para = (await db.select().from(schema.markets).where(eq(schema.markets.dex, "para"))).filter((m) => m.status === "active");
    expect(para.length).toBeGreaterThan(5);
    // one para market was turned on by review before the dex vanished
    await setDexExecutable(db, "hyperliquid", "para", true, "rev", "reviewed para");
    const target = para.find((m) => m.venueSymbol.endsWith(":BTC")) ?? para[0]!;
    await db.update(schema.markets).set({ canonicalAsset: null }).where(eq(schema.markets.id, target.id));
    await db.insert(schema.canonicalAssets).values({ id: "CR:BTC", class: "CR", displayName: "BTC" }).onConflictDoNothing();
    await db.update(schema.markets).set({ canonicalAsset: "CR:BTC" }).where(eq(schema.markets.id, target.id));
    await setExecutable(db, target.id, true, "rev", "reviewed");
    expect((await market(target.id))!.executable).toBe(true);
    const r = await syncMarkets(db, [hyperliquidSource({ dropDexes: ["para"] })], T2);
    for (const m of para) expect(r.reduceOnly, m.id).toContain(m.id);
    for (const m of await db.select().from(schema.markets).where(eq(schema.markets.dex, "para"))) {
      if (para.some((p) => p.id === m.id)) {
        expect(m.status).toBe("reduce_only");
        expect(m.executable).toBe(false);
      }
    }
    expect(r.delisted.filter((id) => id.startsWith("hyperliquid:para:"))).toEqual([]);
    const [d] = await db.select().from(schema.dexes).where(eq(schema.dexes.dex, "para"));
    expect(d!.status).toBe("gone");
    expect(d!.executable).toBe(false);
  });

  test("new-dex-non-executable", async () => {
    const r = await syncMarkets(db, [hyperliquidSource()], T1);
    for (const d of ["xyz", "io", "para", "flx", "vntl", "hyna", "km", "abcd", "cash", "mkts"]) expect(r.newDexes).toContain(d);
    const dexes = await db.select().from(schema.dexes);
    expect(dexes.every((d) => d.executable === false)).toBe(true);
    for (const d of ["flx", "vntl", "hyna", "km", "abcd", "cash"]) expect(dexes.find((x) => x.dex === d)!.liveMarkets).toBe(0);
    expect((await db.select().from(schema.markets)).every((m) => m.executable === false)).toBe(true);
    // only xyz, io and para can be turned on, and only by review
    for (const d of ["flx", "mkts", "cash"]) await expect(setDexExecutable(db, "hyperliquid", d, true, "rev", "n")).rejects.toThrow("can never be executable");
    await setDexExecutable(db, "hyperliquid", "xyz", true, "rev", "reviewed xyz");
    // a later dex appears: it enters non-executable and is reported once
    const more = hyperliquidSource();
    const withNew: MarketSource = { ...more, listDexes: async () => [...(await more.listDexes!()), { dex: "newdex", index: 11, liveMarkets: 0 }] };
    const r2 = await syncMarkets(db, [withNew], T2);
    expect(r2.newDexes).toEqual(["newdex"]);
    expect((await db.select().from(schema.dexes).where(eq(schema.dexes.dex, "newdex")))[0]!.executable).toBe(false);
  });

  test("non-perp-never-executable", async () => {
    await syncMarkets(db, [lighterSource("lighter-466324"), staticSource("variational", [{ venueSymbol: "BTC-SWAP", marketType: "other" }])], T1);
    const rh = await db.select().from(schema.markets).where(eq(schema.markets.venue, "lighter-rh"));
    const spot = rh.filter((m) => m.marketType === "spot");
    expect(spot.length).toBeGreaterThan(0);
    expect(spot.every((m) => !m.executable)).toBe(true);
    await expect(setExecutable(db, spot[0]!.id, true, "rev", "try")).rejects.toThrow("not allowed");
    expect((await market("variational:-:BTC-SWAP"))!.executable).toBe(false);
  });

  test("source-error-isolated", async () => {
    await syncMarkets(db, [asterSource(), hyperliquidSource()], T1);
    const before = (await db.select().from(schema.markets).where(eq(schema.markets.venue, "aster"))).map((m) => [m.id, m.status]);
    const broken: MarketSource = { venue: "aster", listMarkets: async () => Promise.reject(new Error("venue down: HTTP 503")) };
    const r = await syncMarkets(db, [broken, hyperliquidSource({ drop: ["hyperliquid:-:ETH"] })], T2);
    expect(r.errors).toEqual([{ venue: "aster", message: "venue down: HTTP 503" }]);
    expect(r.delisted).toEqual(["hyperliquid:-:ETH"]); // the other source still ran
    const after = (await db.select().from(schema.markets).where(eq(schema.markets.venue, "aster"))).map((m) => [m.id, m.status]);
    expect(after).toEqual(before); // nothing of the failing source was delisted
    // a source that fails half way changes nothing either (one transaction per source)
    const half: MarketSource = { venue: "lighter-mainnet", listMarkets: async () => [{ ...(await lighterSource("lighter-304").listMarkets())[0]!, venue: "aster" }] };
    const r2 = await syncMarkets(db, [half], T2);
    expect(r2.errors[0]!.message).toContain("returned a market of aster");
    expect(await db.select().from(schema.markets).where(eq(schema.markets.venue, "lighter-mainnet"))).toEqual([]);
  });

  test("idempotent", async () => {
    const dump = async () => ({
      markets: await db.select().from(schema.markets).orderBy(asc(schema.markets.id)),
      aliases: (await db.select().from(schema.marketAliases).orderBy(asc(schema.marketAliases.marketId), asc(schema.marketAliases.canonicalAsset))).map(({ id: _id, ...rest }) => rest),
      dexes: await db.select().from(schema.dexes).orderBy(asc(schema.dexes.dex)),
      assets: await db.select().from(schema.canonicalAssets).orderBy(asc(schema.canonicalAssets.id)),
      venues: await db.select().from(schema.venues).orderBy(asc(schema.venues.id)),
    });
    const first = await syncMarkets(db, allFixtureSources(), T1);
    expect(first.added.length).toBeGreaterThan(300);
    expect(first.aliasProposals.length).toBeGreaterThan(0);
    expect(first.errors).toEqual([]);
    const a = await dump();
    const second = await syncMarkets(db, allFixtureSources(), T2);
    expect(second).toEqual({ added: [], updated: [], delisted: [], reduceOnly: [], newDexes: [], aliasProposals: [], errors: [] });
    expect(await dump()).toEqual(a);
  });
});
