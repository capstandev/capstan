import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryGovernor } from "../src/governor";
import { errorResponse, fakeVenueServer } from "../src/fake-server";
import { FIXTURE_SPECS, FIXTURES_DIR, loadFixture, loadFixtureRecord, missingFields, recordFixture, RecordRefused } from "../src/fixtures";
import { venueHttp, VenueHttpError } from "../src/http";

const tmp = mkdtempSync(join(tmpdir(), "capstan-fx-"));
const servers: { stop(): void }[] = [];
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  servers.forEach((s) => s.stop());
});

function allFixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR).flatMap((v) => readdirSync(join(FIXTURES_DIR, v)).filter((f) => f.endsWith(".json")).map((f) => `${v}/${f.replace(/\.json$/, "")}`));
}

describe("fixtures", () => {
  test("read-only", async () => {
    const s = fakeVenueServer({ "/info": () => Response.json({ universe: [] }), "/api/v1/orderBooks": () => Response.json({ order_books: [] }) });
    servers.push(s);
    const g = createMemoryGovernor("rec");
    const hl = venueHttp("hyperliquid", s.url, g);
    const lt = venueHttp("lighter-304", s.url, g);
    const as = venueHttp("aster", s.url, g);
    await expect(recordFixture("hyperliquid/x", () => hl.postJson("/exchange", { action: { type: "order", orders: [] } }), { dir: tmp })).rejects.toThrow(RecordRefused);
    await expect(recordFixture("lighter-304/x", () => lt.postForm("/api/v1/sendTx", { tx_type: "14", tx_info: "{}" }), { dir: tmp })).rejects.toThrow("refusing to record POST /api/v1/sendTx");
    await expect(recordFixture("aster/x", () => as.postForm("/fapi/v3/order", { symbol: "BTCUSDT" }), { dir: tmp })).rejects.toThrow("reads only");
    await expect(recordFixture("aster/y", () => as.request("DELETE", "/fapi/v3/agent"), { dir: tmp })).rejects.toThrow(RecordRefused);
    expect(s.hits).toEqual([]); // nothing was sent
    // reads are recorded with the request and capturedAt
    const r = await recordFixture("hyperliquid/meta", () => hl.postJson("/info", { type: "meta" }), { dir: tmp });
    expect(r).toMatchObject({ name: "hyperliquid/meta", source: "live", status: 200, request: { method: "POST", body: { type: "meta" } }, response: { universe: [] } });
    expect(loadFixture("hyperliquid", "meta", tmp)).toEqual({ universe: [] });
    const r2 = await recordFixture("lighter-304/orderBooks", () => lt.getJson("/api/v1/orderBooks"), { dir: tmp });
    expect(r2.request.method).toBe("GET");
    await expect(recordFixture("bad name", async () => 1, { dir: tmp })).rejects.toThrow("<venue>/<name>");
  });

  test("shape", () => {
    const names = allFixtureNames();
    expect(names.length).toBeGreaterThanOrEqual(30);
    for (const n of names) {
      const [v, f] = n.split("/") as [string, string];
      const raw = readFileSync(join(FIXTURES_DIR, v, `${f}.json`), "utf8");
      expect(raw.length, n).toBeLessThan(200 * 1024);
      const r = loadFixtureRecord<unknown>(v, f);
      expect(r.name, n).toBe(n);
      expect(Number.isNaN(Date.parse(r.capturedAt)), n).toBe(false);
      expect(["GET", "POST"], n).toContain(r.request.method);
      expect(r.request.url, n).toMatch(/^https:\/\//);
      expect(Number.isInteger(r.status), n).toBe(true);
      expect(r.response, n).toBeDefined();
      // every fixture declares the fields adapters read, and has them
      expect(FIXTURE_SPECS[n], `${n} has no FIXTURE_SPECS entry`).toBeDefined();
      expect(missingFields(r.response, FIXTURE_SPECS[n]!), n).toEqual([]);
      if (r.request.method === "POST") expect(r.request.url, n).toEndWith("/info"); // reads only
    }
    for (const n of Object.keys(FIXTURE_SPECS)) expect(names, `spec without a fixture: ${n}`).toContain(n);
    // the loader check really fails when a field the adapters read is gone
    const meta = loadFixture<{ universe: Record<string, unknown>[] }>("hyperliquid", "meta");
    const broken = { ...meta, universe: meta.universe.map((u, i) => (i === 3 ? { ...u, szDecimals: undefined } : u)) };
    expect(missingFields(broken, FIXTURE_SPECS["hyperliquid/meta"]!)).toEqual([".universe[3].szDecimals"]);
  });

  test("closed-items-and-real-errors", async () => {
    // closed or delisted items are in the fixtures
    expect(loadFixture<{ universe: { isDelisted?: boolean }[] }>("hyperliquid", "meta").universe.some((u) => u.isDelisted === true)).toBe(true);
    expect(loadFixture<{ order_books: { status: string }[] }>("lighter-304", "orderBooks").order_books.some((b) => b.status === "inactive")).toBe(true);
    expect(loadFixture<{ order_books: { market_type: string }[] }>("lighter-466324", "orderBooks").order_books.some((b) => b.market_type === "spot")).toBe(true);
    expect(loadFixture<{ symbols: { status: string }[] }>("aster", "exchangeInfo").symbols.some((s) => s.status === "SETTLING")).toBe(true);
    expect(loadFixture<{ symbols: { symbolType?: number }[] }>("aster", "exchangeInfo").symbols.some((s) => s.symbolType === 1)).toBe(true);
    expect(loadFixture<{ markets: { status: string }[] }>("arcus", "markets").markets.some((m) => m.status === "OFFLINE")).toBe(true);
    expect(loadFixture<{ listings: { contract_type: string }[] }>("variational", "stats").listings.some((l) => l.contract_type === "swap")).toBe(true);
    // the venues' real error bodies for unknown items
    const hlErr = loadFixtureRecord<string>("hyperliquid", "error_unknownType");
    expect(hlErr.status).toBe(422);
    expect(hlErr.response).toStartWith("Failed to deserialize the JSON body");
    expect(loadFixtureRecord("lighter-304", "error_unknownMarket")).toMatchObject({ status: 400, response: { code: 21100 } });
    expect(loadFixtureRecord("aster", "error_invalidSymbol")).toMatchObject({ status: 400, response: { code: -1121, msg: "Invalid symbol." } });
    expect(loadFixtureRecord("variational", "error_rateLimited")).toMatchObject({ status: 429, source: "documented", response: { retry_after_seconds: 1 } });
    // the fake venue answers unknown items like the venue, and never 200 for a URL it does not know
    const s = fakeVenueServer({
      "GET /api/v1/accountsByL1Address": () => errorResponse("lighter-304", "error_unknownMarket"),
      "GET /fapi/v3/depth": () => errorResponse("aster", "error_invalidSymbol"),
      "POST /info": () => errorResponse("hyperliquid", "error_unknownType"),
    });
    servers.push(s);
    expect((await fetch(`${s.url}/anything`)).status).toBe(404);
    expect((await fetch(`${s.url}/`)).status).toBe(404);
    const g = createMemoryGovernor("err");
    const e1 = await venueHttp("lighter-304", s.url, g).getJson("/api/v1/accountsByL1Address", { l1_address: "0x1" }).catch((e) => e);
    expect(e1).toBeInstanceOf(VenueHttpError);
    expect((e1 as VenueHttpError).body).toEqual({ code: 21100, message: "account not found" });
    const e2 = await venueHttp("aster", s.url, g).getJson("/fapi/v3/depth", { symbol: "NOPE" }).catch((e) => e);
    expect((e2 as VenueHttpError).httpStatus).toBe(400);
    const e3 = await venueHttp("hyperliquid", s.url, g).postJson("/info", { type: "nope" }).catch((e) => e);
    expect((e3 as VenueHttpError).httpStatus).toBe(422);
    expect(String((e3 as VenueHttpError).body)).toContain("Failed to deserialize");
  });
});
