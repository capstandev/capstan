// Lighter on Robinhood Chain: the deposit contract, its implementation pin and USDG, read from the one address file
// (packages/schema/src/constants/chains.ts), never re-typed here.
import { ADDRESSES, CHAINS, type Hex } from "@capstan/schema";

export const LIGHTER_RH_DEPOSIT = Object.freeze({
  chainId: CHAINS.rhc.chainId, // 4663: the EVM chain. 466324 is Lighter's L2 signing id and never goes in an EVM tx
  address: ADDRESSES.lighterRhDeposit.address as Hex,
  implementationAtPin: ADDRESSES.lighterRhDepositImpl.address as Hex,
  usdg: ADDRESSES.usdgRhc.address as Hex,
  usdgDecimals: ADDRESSES.usdgRhc.decimals,
  /** 1 USDG, the venue minimum per deposit. */
  minDepositUnits: 1_000_000n,
  /** USDG is asset 3 in RH assetDetails; route 0 = perps account. */
  usdgAssetIndex: 3,
  routePerps: 0,
  /** deposit(address _to, uint16 _assetIndex, uint8 _routeType, uint256 _amount): selector 0x8a857083 (Lighter docs). */
  depositSelector: "0x8a857083" as Hex,
});

/** EIP-1967 implementation slot. */
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex; // not-a-key

export const LIGHTER_RH_SIGNING_ID = 466324;
