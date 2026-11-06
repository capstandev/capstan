import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Db } from "@capstan/core";
import { db as schema } from "@capstan/schema";
import { eq, inArray } from "drizzle-orm";
import { isExecutable, setExecutable } from "../src/review";
import { syncMarkets } from "../src/sync";
import { dbDescribe, freshDb } from "./db-helper";
import { arcusSource, variationalSource } from "./fixture-sources";

let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: Db;

dbDescribe("executable", () => {
  beforeAll(async () => {
    ctx = await freshDb();
    db = ctx.db;
    await syncMarkets(db, [variationalSource(), arcusSource()], new Date("2026-11-06T00:15:00Z"));
  });
  afterAll(async () => {
    await ctx.drop();
  });

  test("data-only", async () => {
    const rows = await db.select().from(schema.markets).where(inArray(schema.markets.venue, ["variational", "arcus"]));
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.every((r) => r.executable === false)).toBe(true);
    expect(rows.filter((r) => r.venue === "variational").every((r) => r.dataFreshness === "delayed")).toBe(true);
    for (const id of ["variational:-:BTC-PERP", "arcus:-:BTC-USD"]) {
      const r = rows.find((x) => x.id === id);
      expect(r, id).toBeDefined();
      expect(r!.canonicalAsset).toBe("CR:BTC"); // mapped for the cross-venue funding view, still data only
      expect(await isExecutable(db, id)).toEqual({ ok: false, code: "VENUE_DATA_ONLY" });
      await expect(setExecutable(db, id, true, "rev", "try")).rejects.toThrow("is data only");
    }
    // even a forced flag in the database never makes a data-only venue executable
    await db.update(schema.markets).set({ executable: true }).where(eq(schema.markets.id, "arcus:-:BTC-USD"));
    expect(await isExecutable(db, "arcus:-:BTC-USD")).toEqual({ ok: false, code: "VENUE_DATA_ONLY" });
    expect(await isExecutable(db, "nope:-:X")).toEqual({ ok: false, code: "MARKET_NOT_EXECUTABLE" });
  });
});
