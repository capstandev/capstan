// R4, R5, R6: the builder CSV. 403 and lag handling, a bounded linear streaming parser, the lowercase address URL,
// and the cross-check against stored fills on recorded data (one address, 2026-11-02, 71 rows through one builder).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hex } from "@capstan/schema";
import { csvUrl, httpCsvFetcher, lz4Frames, memoryCsvState, parseBuilderCsv, reconcileHl, ReconError, CSV_COLUMNS, Lz4Error } from "../../src/reconcile";
import { BUILDER, collector, CSV_ALL, CSV_LINKED, CSV_ONE_USER, fakeCsv, fakeHl, FILLS, FILLS_DAY, FILLS_USER, lz4Literal, marketOf, PG, plant, RUN_DAY, type Planted } from "./helpers";

const HEADER = CSV_COLUMNS.join(",");
const row = (i: number) => `2026-11-02T00:00:${String(i % 60).padStart(2, "0")}Z,0x${(i + 1).toString(16).padStart(40, "0")},BTC,Bid,70000.${i % 10},0.001,true,Na,Gtc,false,0x${"0".repeat(39)}1,0,0,0.0007`;
const all = async (it: AsyncIterable<unknown>) => {
  const out: unknown[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe("builder CSV parser", () => {
  test("bounded-linear", async () => {
    // real files: one block, and the same rows in linked 64 KB blocks
    for (const f of [CSV_ALL, CSV_LINKED]) {
      const p = parseBuilderCsv(f);
      const rows = (await all(p)) as { coin: string; side: string; user: string }[];
      expect(rows.length).toBe(1320);
      expect(p.stats).toMatchObject({ rows: 1320, malformed: 0, bytes: 213752 });
      expect(rows.some((r) => r.coin.startsWith("xyz:"))).toBe(true);
      expect(rows.every((r) => r.side === "Bid" || r.side === "Ask")).toBe(true);
      expect(rows.every((r) => r.user === r.user.toLowerCase())).toBe(true);
    }
    // the cap: PARSE_TOO_LARGE once the decompressed size passes it
    await expect(all(parseBuilderCsv(CSV_ALL, 100_000))).rejects.toMatchObject({ code: "PARSE_TOO_LARGE" });
    await expect(all(parseBuilderCsv(CSV_ALL, 100_000))).rejects.toBeInstanceOf(ReconError);
    expect(parseBuilderCsv(CSV_ALL).stats.bytes).toBe(0); // nothing is read before iteration
    // a malformed row is counted and skipped, not fatal
    const mixed = [HEADER, row(1), "garbage,line", row(2), row(3).replace("Bid", "Buy"), "", row(4), `${row(5)},extra`, row(6)].join("\n");
    const p2 = parseBuilderCsv(lz4Literal(mixed));
    expect((await all(p2)).length).toBe(4);
    expect(p2.stats).toMatchObject({ rows: 4, malformed: 3 });
    // a changed header is refused
    await expect(all(parseBuilderCsv(lz4Literal(`time,user,coin\n${row(1)}`)))).rejects.toMatchObject({ code: "PARSE_BAD_HEADER" });
    // a line with no end is dropped once past the line cap, and the rows after it still parse
    const long = [HEADER, row(1), "x".repeat(200_000), row(2), row(3)].join("\n");
    const p3 = parseBuilderCsv(lz4Literal(long, 4096));
    expect((await all(p3)).length).toBe(3);
    expect(p3.stats.malformed).toBe(1);
    // linear: loop steps grow with the input, not its square
    const steps: number[] = [];
    for (const n of [2_000, 16_000]) {
      const text = [HEADER, ...Array.from({ length: n }, (_, i) => row(i))].join("\n");
      const p = parseBuilderCsv(lz4Literal(text));
      expect((await all(p)).length).toBe(n);
      steps.push(p.stats.steps);
      expect(p.stats.steps).toBeLessThanOrEqual(n + 2 + Math.ceil(text.length / (60 * 1024)) * 2);
    }
    expect(steps[1]! / steps[0]!).toBeLessThan(8.5);
  });

  test("lz4 frame errors are refused", () => {
    const bad = CSV_ALL.slice();
    bad[bad.length - 2] = bad[bad.length - 2]! ^ 0xff; // content checksum
    expect(() => [...lz4Frames(bad)]).toThrow(Lz4Error);
    expect(() => [...lz4Frames(CSV_ALL.subarray(0, 1000))]).toThrow("truncated");
    const magic = CSV_ALL.slice();
    magic[0] = 0;
    expect(() => [...lz4Frames(magic)]).toThrow("bad frame magic");
  });

  test("lowercase-address", async () => {
    const mixed = "0x1924B8561EEF20E70EDE628A296175D358BE80E5" as Hex;
    expect(csvUrl(mixed, "20261102")).toBe("https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/0x1924b8561eef20e70ede628a296175d358be80e5/20261102.csv.lz4");
    const urls: string[] = [];
    const f = httpCsvFetcher({ fetchImpl: (async (u: string) => (urls.push(String(u)), new Response("denied", { status: 403 }))) as unknown as typeof fetch });
    expect(await f.get(mixed, "20261102")).toBe(403);
    expect(urls[0]).toContain("/builder_fills/0x1924b8561eef20e70ede628a296175d358be80e5/");
    if (PG) {
      const p = await plant("csv-lower");
      try {
        const c = fakeCsv({});
        await reconcileHl(RUN_DAY, { db: p.db, hl: fakeHl({}).hl, builder: mixed, csv: c.csv });
        expect(c.calls).toEqual([{ addr: mixed.toLowerCase(), day: "20261102" }]);
      } finally {
        await p.drop();
      }
    }
  });

  test.skipIf(process.env.CAPSTAN_LIVE !== "1")("live: a public builder CSV downloads and parses", async () => {
    const f = httpCsvFetcher();
    const day = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
    const got = await f.get(BUILDER, day);
    if (got === 403) return; // a quiet builder can skip a day
    const p = parseBuilderCsv(got);
    expect((await all(p)).length).toBeGreaterThan(0);
    expect(p.stats.malformed).toBe(0);
  });
});

describe.skipIf(!PG)("CSV cross-check", () => {
  let p: Planted;
  beforeAll(async () => {
    p = await plant("csv");
    // the 71 recorded fills that went through this builder are ours: plant their orders and receipts
    const rows = (await all(parseBuilderCsv(CSV_ONE_USER))) as { coin: string; timeMs: number; px: string; sz: string }[];
    const ours = FILLS.filter((f) => rows.some((r) => r.coin === f.coin && Math.floor(r.timeMs / 1000) === Math.floor(f.time / 1000) && Number(r.px) === Number(f.px) && Number(r.sz) === Number(f.sz)));
    expect(ours.length).toBe(71);
    for (const oid of new Set(ours.map((f) => String(f.oid)))) {
      const f = ours.find((x) => String(x.oid) === oid)!;
      await p.order({ owner: FILLS_USER as Hex, oid, marketId: marketOf(f.coin) });
    }
    // reconcile the fills day itself (stores the fills)
    const r = await reconcileHl(FILLS_DAY, { db: p.db, hl: fakeHl({ [FILLS_USER]: FILLS }).hl, builder: BUILDER, csv: fakeCsv({}).csv });
    expect(r.fills).toBe(71);
    expect(r.unmatchedFills).toEqual([]);
  });
  afterAll(() => p?.drop());

  test("403-and-lag", async () => {
    const state = memoryCsvState();
    const al = collector();
    // run on 11-05: the 11-02 file is not up yet: pending_lag, no alert
    const r1 = await reconcileHl(RUN_DAY, { db: p.db, hl: fakeHl({}).hl, builder: BUILDER, csv: fakeCsv({}).csv, csvState: state, publish: al.publish });
    expect(r1.csvCrossCheck).toMatchObject({ day: FILLS_DAY, status: "pending_lag" });
    expect(await state.pending()).toEqual([FILLS_DAY]);
    // next run (11-06): 11-02 is retried and now published: ok, fees equal, no alert; 11-03 is 403 and waits
    const c2 = fakeCsv({ "20261102": CSV_ONE_USER });
    const r2 = await reconcileHl("2026-11-06", { db: p.db, hl: fakeHl({}).hl, builder: BUILDER, csv: c2.csv, csvState: state, publish: al.publish });
    expect(c2.calls.map((c) => c.day)).toEqual(["20261102", "20261103"]);
    expect(r2.csvCrossCheck).toMatchObject({ day: "2026-11-03", status: "pending_lag" });
    expect(await state.pending()).toEqual(["2026-11-03"]);
    expect(al.events).toEqual([]);
    // a day still 403 a week after it ended is missing: tolerated, dropped, no alert
    const r3 = await reconcileHl("2026-11-11", { db: p.db, hl: fakeHl({}).hl, builder: BUILDER, csv: fakeCsv({}).csv, csvState: state, publish: al.publish });
    expect(r3.csvCrossCheck).toMatchObject({ day: "2026-11-08", status: "pending_lag" });
    expect(await state.pending()).toEqual(["2026-11-08"]); // 11-03 aged out as missing_403
    expect(al.events).toEqual([]);
    const old = await reconcileHl("2026-11-20", { db: p.db, hl: fakeHl({}).hl, builder: BUILDER, csv: fakeCsv({}).csv, now: () => new Date("2026-11-27T02:00:00Z") });
    expect(old.csvCrossCheck).toMatchObject({ day: "2026-11-17", status: "missing_403" });
  });

  test("ok, diff and CSV rows without a receipt", async () => {
    const ok = await reconcileHl(RUN_DAY, { db: p.db, hl: fakeHl({}).hl, builder: BUILDER, csv: fakeCsv({ "20261102": CSV_ONE_USER }).csv });
    expect(ok.csvCrossCheck).toMatchObject({ day: FILLS_DAY, rows: 71, status: "ok", unmatchedRows: 0, feeUsd: "0.236725" });
    // the full builder file has 1,249 rows of other users: our builder's fills with no fill or receipt on record
    const al = collector();
    const all1 = await reconcileHl(RUN_DAY, { db: p.db, hl: fakeHl({}).hl, builder: BUILDER, csv: fakeCsv({ "20261102": CSV_ALL }).csv, publish: al.publish });
    expect(all1.csvCrossCheck).toMatchObject({ rows: 1320, unmatchedRows: 1249, status: "diff" });
    expect(al.reasons().sort()).toEqual(["csv_fee_diff", "csv_fill_without_receipt"]);
  });
});
