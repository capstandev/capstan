// Unsigned USDG deposit to Lighter on Robinhood Chain: an exact ERC-20 approve, then deposit(_to, 3, 0, amount) to the
// pinned contract. The user's own wallet sends both; Capstan never holds or moves funds. The recipient is always the
// owner's own address. Fork-proven (contracts/test/fork/LighterRhDeposit.t.sol, 2026-11-06); the switch
// LIGHTER_RH_DEPOSIT_BUILDS=0 turns builds off and returns instructions only.
import { CapstanError, Dec, type Hex } from "@capstan/schema";
import { encodeFunctionData, erc20Abi, getAddress } from "viem";
import { LIGHTER_RH_DEPOSIT } from "./constants";

export const LIGHTER_RH_DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "_to", type: "address" },
      { name: "_assetIndex", type: "uint16" },
      { name: "_routeType", type: "uint8" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export interface UnsignedEvmTx {
  chainId: number;
  to: Hex;
  data: Hex;
  value: "0";
  from: Hex;
}

export function depositBuildsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LIGHTER_RH_DEPOSIT_BUILDS !== "0";
}

/** An EVM tx must never carry Lighter's L2 signing id as its chain id. */
export function assertEvmChainId(chainId: number): void {
  if (chainId === 466324) throw new CapstanError("INVALID_INPUT", "466324 is Lighter's signing id, not an EVM chain id (Robinhood Chain is 4663)");
  if (chainId !== LIGHTER_RH_DEPOSIT.chainId) throw new CapstanError("INVALID_INPUT", `deposits go to chain ${LIGHTER_RH_DEPOSIT.chainId}, not ${chainId}`);
}

export function depositInstructions(amountUsdg: string): string[] {
  return [
    `Send at least 1 USDG on Robinhood Chain (chain id ${LIGHTER_RH_DEPOSIT.chainId}) to Lighter's deposit contract ${LIGHTER_RH_DEPOSIT.address}:`,
    `approve ${amountUsdg} USDG to that contract, then call deposit(your address, 3, 0, amount).`,
  ];
}

export function buildDepositTxs(
  req: { owner: Hex; amountUsdg: string; accountIndex?: number },
  ctx: { checked: true; nowMs: number; tokenDecimals: number; env?: Record<string, string | undefined> },
): { approve: UnsignedEvmTx; deposit: UnsignedEvmTx; humanReadable: string[] } {
  if (ctx.checked !== true) throw new CapstanError("INVALID_INPUT", "deposit builds need a passed boot check");
  if (!depositBuildsEnabled(ctx.env)) throw new CapstanError("INVALID_INPUT", "deposit builds are off; use the deposit instructions");
  // decimals come from the token itself (read on chain), and must match the pinned value
  if (ctx.tokenDecimals !== LIGHTER_RH_DEPOSIT.usdgDecimals) throw new CapstanError("INVALID_INPUT", `USDG reports ${ctx.tokenDecimals} decimals, expected ${LIGHTER_RH_DEPOSIT.usdgDecimals}`);
  let owner: Hex;
  try {
    owner = getAddress(req.owner) as Hex;
  } catch {
    throw new CapstanError("INVALID_INPUT", "owner must be an address");
  }
  let units: bigint;
  try {
    units = Dec.parse(req.amountUsdg, ctx.tokenDecimals).v;
  } catch {
    throw new CapstanError("INVALID_INPUT", `amount must be a decimal with at most ${ctx.tokenDecimals} places`);
  }
  if (units < LIGHTER_RH_DEPOSIT.minDepositUnits) throw new CapstanError("INVALID_INPUT", "the minimum Lighter-RH deposit is 1 USDG");
  assertEvmChainId(LIGHTER_RH_DEPOSIT.chainId);
  const approve: UnsignedEvmTx = {
    chainId: LIGHTER_RH_DEPOSIT.chainId,
    from: owner,
    to: LIGHTER_RH_DEPOSIT.usdg,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [LIGHTER_RH_DEPOSIT.address, units] }), // exact, never unlimited
    value: "0",
  };
  const deposit: UnsignedEvmTx = {
    chainId: LIGHTER_RH_DEPOSIT.chainId,
    from: owner,
    to: LIGHTER_RH_DEPOSIT.address,
    data: encodeFunctionData({ abi: LIGHTER_RH_DEPOSIT_ABI, functionName: "deposit", args: [owner, LIGHTER_RH_DEPOSIT.usdgAssetIndex, LIGHTER_RH_DEPOSIT.routePerps, units] }),
    value: "0",
  };
  const amount = Dec.toString(Dec.fromBigInt(units, ctx.tokenDecimals));
  return {
    approve,
    deposit,
    humanReadable: [`Allow Lighter's deposit contract to take exactly ${amount} USDG from your wallet.`, `Deposit ${amount} USDG to Lighter on Robinhood Chain (credited to your own Lighter account).`],
  };
}
