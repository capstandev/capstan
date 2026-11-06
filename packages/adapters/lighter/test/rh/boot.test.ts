// R4: bootCheck fails (deposit builds refused) when /info names another contract or the EIP-1967 implementation slot
// differs from the pin; the nightly health job raises an ops alert on a mismatch.
import { afterAll, describe, expect, test } from "bun:test";
import type { Hex } from "@capstan/schema";
import { bootCheck, buildDepositTxs, LIGHTER_CONFIGS, LIGHTER_RH_DEPOSIT, type SlotReader } from "../../src";
import { fakeLighter, json, readerFor } from "../helpers";

const slot = (addr: string): Hex => `0x${"0".repeat(24)}${addr.replace(/^0x/, "").toLowerCase()}` as Hex;
const rpc = (impl: string, chainId = 4663): SlotReader => ({ getStorageAt: async () => slot(impl), getChainId: async () => chainId });
const good = fakeLighter("lighter-466324");
const moved = fakeLighter("lighter-466324", { "GET /info": () => json({ contract_address: "0x1111111111111111111111111111111111111111" }) });
afterAll(() => {
  good.stop();
  moved.stop();
});

describe("rh boot", () => {
  test("pin-mismatch-refuses", async () => {
    const ok = await bootCheck(readerFor(LIGHTER_CONFIGS.rh, good.url), rpc(LIGHTER_RH_DEPOSIT.implementationAtPin));
    expect(ok).toMatchObject({ ok: true, contract: LIGHTER_RH_DEPOSIT.address });
    const badInfo = await bootCheck(readerFor(LIGHTER_CONFIGS.rh, moved.url), rpc(LIGHTER_RH_DEPOSIT.implementationAtPin));
    expect(badInfo.ok).toBe(false);
    expect(badInfo.reason).toContain("GET /info");
    const badImpl = await bootCheck(readerFor(LIGHTER_CONFIGS.rh, good.url), rpc("0x2222222222222222222222222222222222222222"));
    expect(badImpl).toMatchObject({ ok: false, implementation: "0x2222222222222222222222222222222222222222" });
    expect((await bootCheck(readerFor(LIGHTER_CONFIGS.rh, good.url), rpc(LIGHTER_RH_DEPOSIT.implementationAtPin, 1))).reason).toContain("chain id");
    expect((await bootCheck(readerFor(LIGHTER_CONFIGS.rh, good.url), { getStorageAt: async () => { throw new Error("rpc down"); } })).ok).toBe(false); // fail closed
    expect((await bootCheck(readerFor(LIGHTER_CONFIGS.mainnet, good.url), rpc(LIGHTER_RH_DEPOSIT.implementationAtPin))).ok).toBe(false);
    // without a passed check there is no deposit build
    expect(() => buildDepositTxs({ owner: "0x00000000000000000000000000000000000A11CE", amountUsdg: "5" }, { checked: false as true, nowMs: 0, tokenDecimals: 6 })).toThrow(/boot check/);
  });
});
