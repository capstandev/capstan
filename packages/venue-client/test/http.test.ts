import { afterAll, describe, expect, test } from "bun:test";
import { CapstanError } from "@capstan/schema";
import { createMemoryGovernor } from "../src/governor";
import { fakeVenueServer } from "../src/fake-server";
import { isRetryableRead, isUnknownOutcome, venueHttp, VenueHttpError } from "../src/http";
import { parseJsonLossless } from "../src/json";

const servers: { stop(): void }[] = [];
afterAll(() => servers.forEach((s) => s.stop()));
function server(routes: Parameters<typeof fakeVenueServer>[0]) {
  const s = fakeVenueServer(routes);
  servers.push(s);
  return s;
}
const gov = () => createMemoryGovernor(`http-${Math.random()}`);

describe("venueHttp", () => {
  test("no-retry-on-submit", async () => {
    let n = 0;
    const s = server({
      "GET /flaky": () => (++n < 3 ? new Response("oops", { status: 500 }) : Response.json({ ok: true })),
      "POST /exchange": () => new Response("boom", { status: 500 }),
      "POST /info": () => new Response("busy", { status: 502 }),
      "POST /api/v1/sendTx": () => new Response("boom", { status: 500 }),
      "POST /fapi/v3/order": () => new Response("boom", { status: 500 }),
    });
    const hl = venueHttp("hyperliquid", s.url, gov(), { backoffBaseMs: 1 });
    // a GET read retries 5xx and succeeds on the third try
    const get = venueHttp("variational", s.url, gov(), { backoffBaseMs: 1 });
    expect(await get.getJson("/flaky")).toEqual({ ok: true });
    expect(s.hits.filter((h) => h === "GET /flaky").length).toBe(3);
    // an HL exchange action is sent once and never retried
    await expect(hl.postJson("/exchange", { action: { type: "order", orders: [{}] } })).rejects.toBeInstanceOf(VenueHttpError);
    expect(s.hits.filter((h) => h === "POST /exchange").length).toBe(1);
    // an HL info read is retried (max 3 tries)
    await expect(hl.postJson("/info", { type: "meta" })).rejects.toThrow("HTTP 502");
    expect(s.hits.filter((h) => h === "POST /info").length).toBe(3);
    // Lighter sendTx and an Aster order are never retried
    const lighter = venueHttp("lighter-304", s.url, createMemoryGovernor("lt"), { backoffBaseMs: 1 });
    await expect(lighter.postForm("/api/v1/sendTx", { tx_type: "14", tx_info: "{}" })).rejects.toThrow("HTTP 500");
    expect(s.hits.filter((h) => h === "POST /api/v1/sendTx").length).toBe(1);
    const aster = venueHttp("aster", s.url, gov(), { backoffBaseMs: 1 });
    await expect(aster.postForm("/fapi/v3/order", { symbol: "BTCUSDT" })).rejects.toThrow("HTTP 500");
    expect(s.hits.filter((h) => h === "POST /fapi/v3/order").length).toBe(1);
    expect(isRetryableRead("hyperliquid", "POST", "/exchange")).toBe(false);
    expect(isRetryableRead("lighter-304", "POST", "/api/v1/sendTx")).toBe(false);
    // a network error on a read is retried, then reported as VENUE_ERROR
    const dead = venueHttp("variational", "http://127.0.0.1:1", gov(), { backoffBaseMs: 1, timeoutMs: 500 });
    await expect(dead.getJson("/x")).rejects.toMatchObject({ code: "VENUE_ERROR" });
  });

  test("aster-503-unknown", async () => {
    const s = server({ "POST /fapi/v3/order": () => new Response('{"code":-1007,"msg":"Timeout waiting for response from backend server. Send status unknown; execution status unknown."}', { status: 503 }) });
    const aster = venueHttp("aster", s.url, gov());
    const r = await aster.postForm("/fapi/v3/order", { symbol: "BTCUSDT" });
    expect(isUnknownOutcome(r)).toBe(true);
    expect(r).toMatchObject({ status: "unknown", httpStatus: 503, venue: "aster", path: "/fapi/v3/order" });
    expect(s.hits.length).toBe(1);
  });

  test("big-int-ids-lossless", async () => {
    const body = '{"oid":9007199254740993,"tid":12,"px":"1.5","sz":0.25,"nested":[{"order_index":18446744073709551615,"nonce":-9007199254740995}],"s":"9007199254740993999","e":1e21}';
    const s = server({ "GET /order": () => new Response(body, { headers: { "content-type": "application/json" } }) });
    const r = await venueHttp("variational", s.url, gov()).getJson<Record<string, unknown>>("/order");
    expect(r.oid).toBe("9007199254740993");
    expect(r.tid).toBe(12);
    expect(r.sz).toBe(0.25);
    expect(r.s).toBe("9007199254740993999");
    expect((r.nested as Record<string, unknown>[])[0]).toEqual({ order_index: "18446744073709551615", nonce: "-9007199254740995" });
    expect(r.e).toBe(1e21);
    expect(parseJsonLossless('[1,"a\\"9007199254740993",{"x":9007199254740991}]')).toEqual([1, 'a"9007199254740993', { x: 9007199254740991 }]);
  });

  test("429 on a read waits for the cool-off, then retries", async () => {
    let n = 0;
    const s = server({ "GET /metadata/v2/stats": () => (++n === 1 ? Response.json({ error: "rate_limited", retry_after_seconds: 1 }, { status: 429 }) : Response.json({ listings: [] })) });
    const t0 = Date.now();
    const r = await venueHttp("variational", s.url, gov(), { backoffBaseMs: 1 }).getJson("/metadata/v2/stats");
    expect(r).toEqual({ listings: [] });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  });

  test("418 ban: no request is sent while banned", async () => {
    const until = Date.now() + 60_000;
    const s = server({ "GET /fapi/v3/depth": () => Response.json({ code: -1003, msg: `Way too many requests; IP banned until ${until}.` }, { status: 418 }) });
    const aster = venueHttp("aster", s.url, gov());
    await expect(aster.getJson("/fapi/v3/depth", { symbol: "BTCUSDT", limit: 5 })).rejects.toMatchObject({ code: "VENUE_RATE_LIMITED", httpStatus: 418 });
    await expect(aster.getJson("/fapi/v3/depth", { symbol: "BTCUSDT", limit: 5 })).rejects.toBeInstanceOf(CapstanError);
    expect(s.hits.length).toBe(1);
  });

  test("a 4xx is surfaced with the venue body for the adapter", async () => {
    const s = server({ "GET /api/v1/accountsByL1Address": () => Response.json({ code: 21100, message: "account not found" }, { status: 400 }) });
    const err = await venueHttp("lighter-304", s.url, createMemoryGovernor("l4")).getJson("/api/v1/accountsByL1Address", { l1_address: "0x1" }).catch((e) => e);
    expect(err).toBeInstanceOf(VenueHttpError);
    expect((err as VenueHttpError).httpStatus).toBe(400);
    expect((err as VenueHttpError).body).toEqual({ code: 21100, message: "account not found" });
  });
});
