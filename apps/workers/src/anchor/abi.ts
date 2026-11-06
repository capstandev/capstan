// The anchor contract surface the workers use (contracts/src/CapstanReceiptAnchor.sol).
import { parseAbi, parseAbiItem } from "viem";

export const ANCHOR_ABI = parseAbi([
  "function postRoot(uint64 hourEpoch, bytes32 root, uint32 leafCount)",
  "function poster() view returns (address)",
  "function rootOf(uint64 hourEpoch) view returns (bytes32 root, uint32 leafCount, uint64 postedAt)",
  "function latestHour() view returns (uint64)",
  "function verifyReceipt(uint64 hourEpoch, bytes32 receiptSha256, bytes32[] proof) view returns (bool)",
  "event RootPosted(uint64 indexed hourEpoch, bytes32 root, uint32 leafCount, bytes32 prevRoot)",
]);

export const ROOT_POSTED = parseAbiItem("event RootPosted(uint64 indexed hourEpoch, bytes32 root, uint32 leafCount, bytes32 prevRoot)");

export const ZERO32 = `0x${"0".repeat(64)}` as const;

/** Robinhood Chain mainnet: posting there needs ANCHOR_ARMED=1 and the ANCHOR_ARMED_FILE to exist. */
export const RHC_MAINNET = 4663;
