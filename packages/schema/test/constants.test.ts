// R18: every constant names the research section that verified it, with a date.
import { describe, expect, test } from "bun:test";
import { ADDRESSES, CHAINS } from "../src/constants/chains";
import { VENUE_FUNDING_FACTS, VENUE_HOSTS } from "../src/constants/venues";

const SOURCE = /^(chain-facts|venue-hyperliquid|venue-lighter|venue-aster|venue-readonly|x402-and-stack)\.md §[0-9A-Za-z.-]+, \d{4}-\d{2}-\d{2}$/;

describe("constants", () => {
  test("sourced", () => {
    const all = { ...CHAINS, ...ADDRESSES, ...VENUE_HOSTS, ...VENUE_FUNDING_FACTS } as Record<string, { source: string }>;
    expect(Object.keys(all).length).toBeGreaterThan(40);
    for (const [name, c] of Object.entries(all)) expect(c.source, name).toMatch(SOURCE);
    // third-party EVM addresses come from chain-facts.md unless they are venue or x402 facts
    for (const [name, a] of Object.entries(ADDRESSES)) {
      if (typeof a.chainId === "number") expect(a.address, name).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  test("key facts", () => {
    expect(CHAINS.rhc.chainId).toBe(4663);
    expect(CHAINS.rhcTestnet.chainId).toBe(46630);
    expect(ADDRESSES.usdgRhc.address).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(ADDRESSES.usdgRhc.decimals).toBe(6);
    expect(ADDRESSES.x402Permit2Proxy.address).toBe("0x402085c248EeA27D92E8b30b2C58ed07f9E20001");
    expect(ADDRESSES.lighterRhDeposit.address).toBe("0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d");
    expect(VENUE_HOSTS.lighterRh.signingChainId).toBe(466324);
    expect(VENUE_HOSTS.lighterMainnetTestnet.signingChainId).toBe(300);
  });
});
