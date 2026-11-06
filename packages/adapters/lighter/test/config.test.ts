// R1: the config switch carries host and signing id together; both testnets use 300 on different hosts; no code path
// picks a host from a chain id.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIGHTER_CONFIGS, lighterConfig } from "../src";

describe("config", () => {
  test("host-and-id-together", () => {
    expect(LIGHTER_CONFIGS.mainnet).toMatchObject({ venue: "lighter-mainnet", signingChainId: 304, rest: "https://mainnet.zklighter.elliot.ai", ws: "wss://mainnet.zklighter.elliot.ai/stream", l1ChainId: 1, collateral: "USDC", governorKey: "lighter-304" });
    expect(LIGHTER_CONFIGS.rh).toMatchObject({ venue: "lighter-rh", signingChainId: 466324, rest: "https://api.rh.lighter.xyz", ws: "wss://api.rh.lighter.xyz/stream", l1ChainId: 4663, collateral: "USDG", governorKey: "lighter-466324" });
    expect(LIGHTER_CONFIGS.rh.readonlyWs).toBe("wss://api.rh.lighter.xyz/stream?readonly=true");
    const t1 = LIGHTER_CONFIGS.mainnetTestnet;
    const t2 = LIGHTER_CONFIGS.rhTestnet;
    expect(t1.signingChainId).toBe(300);
    expect(t2.signingChainId).toBe(300);
    expect(t1.rest).toBe("https://testnet.zklighter.elliot.ai");
    expect(t2.rest).toBe("https://api.rh-testnet.lighter.xyz");
    expect(t1.rest).not.toBe(t2.rest);
    expect(t1.venue).not.toBe(t2.venue);
    // the signing id is never an EVM chain id: RH settles on 4663, signs with 466324
    expect(LIGHTER_CONFIGS.rh.l1ChainId).not.toBe(LIGHTER_CONFIGS.rh.signingChainId);
    expect(lighterConfig("rh")).toBe(LIGHTER_CONFIGS.rh);
    expect(() => lighterConfig("nope" as never)).toThrow();
    expect(Object.isFrozen(LIGHTER_CONFIGS.mainnet)).toBe(true);
    // no source file selects a config, host or URL by chain id
    const src = join(import.meta.dir, "../src");
    const files = readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    const bad = /(signingChainId|chainId)\s*===?\s*[^;]*\?\s*["'`]https?:|find\(\s*\(?\w+\)?\s*=>\s*\w+\.signingChainId\s*===|\[\s*\w*[cC]hainId\s*\]\s*\.\s*(rest|ws)/;
    for (const f of files) expect({ f, hit: bad.test(readFileSync(join(src, f), "utf8")) }).toEqual({ f, hit: false });
  });
});
