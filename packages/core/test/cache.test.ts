// MarketDataCache: TTLs, and putBook / putMark publish on the matching channel (needs REDIS_URL for the Redis part).
import { afterAll, describe, expect, test } from "bun:test";
import { CACHE_TTL_MS, createMarketDataCache, memoryMarketDataCache, PUBSUB } from "../src/cache";
import { createRedis } from "../src/redis";

const book = { marketId: "hyperliquid:-:BTC", bids: [["100", "1"]] as [string, string][], asks: [["101", "2"]] as [string, string][], asOf: "2026-11-05T00:00:00.000Z" };

describe("cache", () => {
  test("spec 2 TTLs", () => {
    expect(CACHE_TTL_MS).toEqual({ book: 1000, mark: 1000, funding: 30000, meta: 600000 });
    expect(PUBSUB.book("m")).toBe("ps:book:m");
    expect(PUBSUB.receipts("0xabc")).toBe("ps:receipts:0xabc");
  });

  test("memory cache publishes books and marks", async () => {
    const seen: [string, string][] = [];
    const c = memoryMarketDataCache((ch, p) => seen.push([ch, p]));
    await c.putBook(book);
    await c.putMark("m", "1.5", "t");
    expect(await c.getBook(book.marketId)).toEqual(book);
    expect(await c.getMark("m")).toEqual({ mark: "1.5", asOf: "t" });
    expect(seen.map((s) => s[0])).toEqual([PUBSUB.book(book.marketId), PUBSUB.mark("m")]);
  });

  const URL_ = process.env.REDIS_URL;
  (URL_ ? describe : describe.skip)("redis", () => {
    const r = URL_ ? createRedis(URL_) : null;
    const sub = URL_ ? createRedis(URL_) : null;
    afterAll(async () => {
      await r?.quit();
      await sub?.quit();
    });
    test("putBook and putMark publish in the same call; TTL expires", async () => {
      const id = `test:${process.pid}:${Date.now()}`;
      const got: string[] = [];
      await sub!.subscribe(PUBSUB.book(id), PUBSUB.mark(id));
      sub!.on("message", (ch) => got.push(ch));
      const c = createMarketDataCache(r!, { book: 1500, mark: 1500, funding: 1500, meta: 1500 });
      await c.putBook({ ...book, marketId: id });
      await c.putMark(id, "2", "t");
      expect((await c.getBook(id))?.marketId).toBe(id);
      for (let i = 0; i < 200 && got.length < 2; i++) await Bun.sleep(10);
      expect(got.sort()).toEqual([PUBSUB.book(id), PUBSUB.mark(id)].sort());
      for (let i = 0; i < 200 && (await c.getBook(id)) !== null; i++) await Bun.sleep(10);
      expect(await c.getBook(id)).toBeNull();
      expect(await c.getMark(id)).toBeNull();
    });
  });
});
