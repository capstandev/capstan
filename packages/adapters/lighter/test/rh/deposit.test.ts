// R5 (at least 1 USDG, decimals read from the token, approve exactly the deposit amount) and R10 (EVM chain id 4663,
// the human line says Lighter on Robinhood Chain, 466324 in an EVM tx is refused).
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi, getAddress } from "viem";
import { assertEvmChainId, buildDepositTxs, depositInstructions, LIGHTER_RH_DEPOSIT, LIGHTER_RH_DEPOSIT_ABI } from "../../src";

const OWNER = "0x00000000000000000000000000000000000a11ce" as const;
const ctx = { checked: true as const, nowMs: 0, tokenDecimals: 6, env: {} };

describe("rh deposit", () => {
  test("min-and-exact-approve", () => {
    expect(() => buildDepositTxs({ owner: OWNER, amountUsdg: "0.999999" }, ctx)).toThrow(/1 USDG/);
    expect(() => buildDepositTxs({ owner: OWNER, amountUsdg: "1.0000001" }, ctx)).toThrow(/decimal/);
    expect(() => buildDepositTxs({ owner: OWNER, amountUsdg: "5" }, { ...ctx, tokenDecimals: 18 })).toThrow(/decimals/);
    for (const amount of ["1", "1.000001", "250.5", "1000000"]) {
      const t = buildDepositTxs({ owner: OWNER, amountUsdg: amount }, ctx);
      const units = BigInt(Math.round(Number(amount) * 1e6));
      const ap = decodeFunctionData({ abi: erc20Abi, data: t.approve.data });
      expect(ap.functionName).toBe("approve");
      expect(ap.args).toEqual([LIGHTER_RH_DEPOSIT.address, units]); // exact amount, never unlimited
      expect(t.approve.to).toBe(LIGHTER_RH_DEPOSIT.usdg);
      const dep = decodeFunctionData({ abi: LIGHTER_RH_DEPOSIT_ABI, data: t.deposit.data });
      expect(dep.functionName).toBe("deposit");
      expect(dep.args).toEqual([getAddress(OWNER), 3, 0, units]); // to the owner's own account
      expect(t.deposit.data.slice(0, 10)).toBe(LIGHTER_RH_DEPOSIT.depositSelector);
      expect(t.deposit.to).toBe(LIGHTER_RH_DEPOSIT.address);
      expect(t.approve.value).toBe("0");
      expect(t.deposit.value).toBe("0"); // never value-bearing ETH
    }
    expect(LIGHTER_RH_DEPOSIT.minDepositUnits).toBe(1_000_000n);
    // the switch turns builds off and leaves instructions
    expect(() => buildDepositTxs({ owner: OWNER, amountUsdg: "5" }, { ...ctx, env: { LIGHTER_RH_DEPOSIT_BUILDS: "0" } })).toThrow(/off/);
    expect(depositInstructions("5")[0]).toContain(LIGHTER_RH_DEPOSIT.address);
  });

  test("chain-ids-not-confused", () => {
    const t = buildDepositTxs({ owner: OWNER, amountUsdg: "7" }, ctx);
    expect(t.approve.chainId).toBe(4663);
    expect(t.deposit.chainId).toBe(4663);
    expect(t.humanReadable).toContain("Deposit 7 USDG to Lighter on Robinhood Chain (credited to your own Lighter account).");
    expect(() => assertEvmChainId(466324)).toThrow(/signing id/);
    expect(() => assertEvmChainId(1)).toThrow();
    expect(() => assertEvmChainId(4663)).not.toThrow();
    expect(JSON.stringify(t)).not.toContain("466324");
  });
});
