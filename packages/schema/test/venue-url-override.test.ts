// The fork stack points venues at local fake servers with CAPSTAN_VENUE_URL_<VENUE>; only loopback http is accepted.
import { describe, expect, test } from "bun:test";
import { venueUrlOverride } from "../src/networks";

describe("venue URL override", () => {
  test("loopback-only", () => {
    expect(venueUrlOverride("hyperliquid", {})).toBeNull();
    expect(venueUrlOverride("hyperliquid", { CAPSTAN_VENUE_URL_HYPERLIQUID: "http://127.0.0.1:22420/" })).toBe("http://127.0.0.1:22420");
    expect(venueUrlOverride("lighter-rh", { CAPSTAN_VENUE_URL_LIGHTER_RH: "http://localhost:22421/rh" })).toBe("http://localhost:22421/rh");
    for (const bad of ["https://api.hyperliquid.xyz", "http://10.0.0.5:80", "http://127.0.0.1.example.com", "http://u:p@127.0.0.1:1", "nope"]) {
      expect(() => venueUrlOverride("hyperliquid", { CAPSTAN_VENUE_URL_HYPERLIQUID: bad })).toThrow(/CAPSTAN_VENUE_URL_HYPERLIQUID/);
    }
  });
});
