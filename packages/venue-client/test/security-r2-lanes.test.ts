// Security review r2, D2-ADP-05 (review-r1:7 F5): every adapter read ran in the free governor lane with no deadline,
// so a flood of public reads on one IP held the Lighter budget (60 a minute, one a second) and stalled builds and
// kill-path reads behind it. A caller now names its lane with withVenueLane, and every wait has a deadline that fails
// closed with VENUE_RATE_LIMITED.
import { describe, expect, test } from "bun:test";
import { createMemoryGovernor, fakeVenueServer, venueHttp, withVenueLane } from "../src";

describe("security r2 D2-ADP-05", () => {
  test("a-full-free-lane-does-not-delay-a-safety-read-past-its-deadline", async () => {
    const srv = fakeVenueServer({ "GET /api/v1/orderBookOrders": () => Response.json({ ok: true }), "GET /api/v1/nextNonce": () => Response.json({ nonce: 7 }) });
    try {
      const http = venueHttp("lighter-304", srv.url, createMemoryGovernor("lanes-test"), { maxTries: 1 });
      // 12 public reads queue up at one a second: about 12 s of free traffic
      const free = Array.from({ length: 12 }, () => http.getJson("/api/v1/orderBookOrders", { market_id: 0 }).then(() => "ok", (e: { code?: string }) => e.code ?? "err"));
      await Bun.sleep(50);
      const t0 = Date.now();
      const r = await withVenueLane({ priority: "safety", deadlineMs: 4_000 }, () => http.getJson<{ nonce: number }>("/api/v1/nextNonce", { account_index: 1, api_key_index: 4 }));
      expect(r.nonce).toBe(7);
      expect(Date.now() - t0).toBeLessThan(4_000);
      // a lane's deadline fails closed with VENUE_RATE_LIMITED instead of waiting behind the queue
      const late = await withVenueLane({ priority: "free", deadlineMs: 500 }, () => http.getJson("/api/v1/orderBookOrders", { market_id: 1 })).then(() => "ok", (e: { code?: string }) => e.code ?? "err");
      expect(late).toBe("VENUE_RATE_LIMITED");
      void free;
    } finally {
      srv.stop();
    }
  }, 20_000);
});
