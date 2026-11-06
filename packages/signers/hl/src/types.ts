// Hyperliquid wire types (venue-hyperliquid.md section 6). Key order in these objects is the signed order.
import type { Hex } from "@capstan/schema";

export type HlNetwork = "Mainnet" | "Testnet";
export type HlTif = "Ioc" | "Gtc" | "Alo";

export interface HlOrderWire {
  a: number; // asset id: core index, or 100000 + dexIndex * 10000 + indexInMeta for HIP-3
  b: boolean; // is buy
  p: string; // limit price, formatted (formatPrice)
  s: string; // size, formatted (formatSize)
  r: boolean; // reduce only
  t: { limit: { tif: HlTif } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
  c?: Hex; // client order id, 16 bytes
}

export interface HlBuilder {
  b: Hex; // builder address, lowercase
  f: number; // fee in tenths of a basis point
}

export interface HlOrderAction {
  type: "order";
  orders: HlOrderWire[];
  grouping: "na" | "normalTpsl" | "positionTpsl";
  builder?: HlBuilder;
}

export interface HlCancelAction {
  type: "cancel";
  cancels: { a: number; o: number }[];
}

export interface HlCancelByCloidAction {
  type: "cancelByCloid";
  cancels: { asset: number; cloid: Hex }[];
}

export interface HlScheduleCancelAction {
  type: "scheduleCancel";
  time?: number;
}

/** Leverage update (L1 action). HIP-3 isolated-only markets refuse `isCross: true` (todo 08). */
export interface HlUpdateLeverageAction {
  type: "updateLeverage";
  asset: number;
  isCross: boolean;
  leverage: number;
}

export type HlL1Action = HlOrderAction | HlCancelAction | HlCancelByCloidAction | HlScheduleCancelAction | HlUpdateLeverageAction;

export type HlUserAction =
  | { type: "approveAgent"; hyperliquidChain: HlNetwork; signatureChainId: Hex; agentAddress: Hex; agentName: string; nonce: number }
  | { type: "approveBuilderFee"; hyperliquidChain: HlNetwork; signatureChainId: Hex; maxFeeRate: `${string}%`; builder: Hex; nonce: number }
  | {
      type: "sendAsset";
      hyperliquidChain: HlNetwork;
      signatureChainId: Hex;
      destination: Hex;
      sourceDex: string;
      destinationDex: string;
      token: string;
      amount: string;
      fromSubAccount: string;
      nonce: number;
    }
  | { type: "userSetAbstraction"; hyperliquidChain: HlNetwork; signatureChainId: Hex; user: Hex; abstraction: string; nonce: number };

export interface HlSignature {
  r: Hex;
  s: Hex;
  v: 27 | 28;
}
