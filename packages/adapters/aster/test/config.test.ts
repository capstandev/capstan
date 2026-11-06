// Host rule R8 (todo 13): only the two fapi hosts are ever used.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ASTER_MAINNET, ASTER_TESTNET, assertV3Path, asterConfig, AsterConfigError, validateAsterConfig, type AsterConfig } from "../src/config";
import { asterHttp } from "../src/read";
import { createMemoryGovernor } from "@capstan/venue-client";

describe("aster config", () => {
  test("host", () => {
    expect(ASTER_MAINNET.rest).toBe("https://fapi.asterdex.com");
    expect(ASTER_TESTNET.rest).toBe("https://fapi.asterdex-testnet.com");
    expect(ASTER_MAINNET.tradeChainId).toBe(1666);
    expect(ASTER_TESTNET.tradeChainId).toBe(714);
    expect(asterConfig("Testnet")).toBe(ASTER_TESTNET);
    validateAsterConfig(ASTER_MAINNET);
    validateAsterConfig(ASTER_TESTNET);
    const bad = (over: Partial<Record<keyof AsterConfig, unknown>>) => () => validateAsterConfig({ ...ASTER_MAINNET, ...over } as AsterConfig);
    // the alternative host from the venue's Python example answers 403 from our egress: refused
    expect(bad({ rest: "https://fapi3.asterdex.com" })).toThrow(AsterConfigError);
    expect(bad({ rest: "https://fapi.asterdex.com.evil.example" })).toThrow(AsterConfigError);
    expect(bad({ rest: "http://fapi.asterdex.com" })).toThrow(AsterConfigError);
    expect(bad({ rest: "https://fapi.asterdex-testnet.com" })).toThrow(AsterConfigError); // mainnet with testnet host
    expect(bad({ tradeChainId: 714 })).toThrow(AsterConfigError);
    expect(bad({ mgmtChainId: 1 })).toThrow(AsterConfigError);
    expect(bad({ governorKey: "aster-testnet" })).toThrow(AsterConfigError);
    expect(bad({ ws: "wss://example.com" })).toThrow(AsterConfigError);
    expect(() => asterHttp({ ...ASTER_MAINNET, rest: "https://fapi3.asterdex.com" } as unknown as AsterConfig, createMemoryGovernor("t"))).toThrow(AsterConfigError);
    expect(() => assertV3Path("/fapi/v1/depth")).toThrow(AsterConfigError);
    expect(assertV3Path("/fapi/v3/depth")).toBe("/fapi/v3/depth");
    // no source file names the refused host
    const dir = join(import.meta.dir, "../src");
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "utf8").includes("fapi3")).toBe(false);
  });
});
