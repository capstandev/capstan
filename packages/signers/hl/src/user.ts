// User-signed actions (the MAIN wallet signs these): domain HyperliquidSignTransaction/1/int(signatureChainId)/0x0.
// `signatureChainId` only sets the domain chain id; it is never a field of the signed struct (venue-hyperliquid.md 6).
// This module exports no builder for withdraw, usdSend or any other transfer: `sendAsset` is only used to move the
// owner's own collateral between perp dexes, and the onboarding builder (todo 06) pins its destination to the owner.
import type { Hex, TypedDataPayload } from "@capstan/schema";
import { lowerAddress } from "./bytes";
import { hashTypedPayload, type TypedField } from "./eip712";
import { ZERO_ADDRESS } from "./l1";
import type { HlUserAction } from "./types";

export const USER_SIGNED_DOMAIN_NAME = "HyperliquidSignTransaction";

/** Signed field lists, in the order the venue hashes them (python SDK `signing.py`). */
export const USER_SIGNED_TYPES: Record<HlUserAction["type"], { primaryType: string; fields: TypedField[] }> = {
  approveAgent: {
    primaryType: "HyperliquidTransaction:ApproveAgent",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "agentAddress", type: "address" },
      { name: "agentName", type: "string" },
      { name: "nonce", type: "uint64" },
    ],
  },
  approveBuilderFee: {
    primaryType: "HyperliquidTransaction:ApproveBuilderFee",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "maxFeeRate", type: "string" },
      { name: "builder", type: "address" },
      { name: "nonce", type: "uint64" },
    ],
  },
  sendAsset: {
    primaryType: "HyperliquidTransaction:SendAsset",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "sourceDex", type: "string" },
      { name: "destinationDex", type: "string" },
      { name: "token", type: "string" },
      { name: "amount", type: "string" },
      { name: "fromSubAccount", type: "string" },
      { name: "nonce", type: "uint64" },
    ],
  },
  userSetAbstraction: {
    primaryType: "HyperliquidTransaction:UserSetAbstraction",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "user", type: "address" },
      { name: "abstraction", type: "string" },
      { name: "nonce", type: "uint64" },
    ],
  },
};

/** Perps builder-fee ceiling the venue enforces: 0.1%. */
export const MAX_FEE_RATE_PERPS = "0.1%";
/** What Capstan's onboarding asks the main wallet to approve: 0.03% (3 bps). */
export const DEFAULT_MAX_FEE_RATE = "0.03%";
const FEE_RATE_RE = /^\d+(\.\d+)?%$/;

/** Percent string as an integer number of 1e-12 percent units, for exact comparison. */
function pctUnits(rate: string): bigint {
  const [i, f = ""] = rate.slice(0, -1).split(".");
  if (f.length > 12) throw new Error(`hl-signer: maxFeeRate has too many decimals: ${rate}`);
  return BigInt(i!) * 10n ** 12n + BigInt((f + "0".repeat(12)).slice(0, 12));
}

/** maxFeeRate must look like "0.03%" and be at most "0.1%" (perps cap). */
export function assertMaxFeeRate(rate: string): asserts rate is `${string}%` {
  if (typeof rate !== "string" || !FEE_RATE_RE.test(rate)) throw new Error(`hl-signer: maxFeeRate must match /^\\d+(\\.\\d+)?%$/, got ${String(rate)}`);
  if (pctUnits(rate) > pctUnits(MAX_FEE_RATE_PERPS)) throw new Error(`hl-signer: maxFeeRate ${rate} is above the perps cap ${MAX_FEE_RATE_PERPS}`);
}

/** maxFeeRate as tenths of a bp, the unit `maxBuilderFee` reports ("0.03%" = 30). */
export function feeRateToTenthsBp(rate: string): number {
  assertMaxFeeRate(rate);
  const units = pctUnits(rate) * 1000n; // 1% = 1000 tenths of a bp
  if (units % 10n ** 12n !== 0n) throw new Error(`hl-signer: maxFeeRate ${rate} is finer than a tenth of a bp`);
  return Number(units / 10n ** 12n);
}

export function signatureChainIdNumber(signatureChainId: string): number {
  if (typeof signatureChainId !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(signatureChainId)) throw new Error(`hl-signer: signatureChainId must be a hex chain id, got ${String(signatureChainId)}`);
  const n = Number.parseInt(signatureChainId, 16);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("hl-signer: signatureChainId out of range");
  return n;
}

/** The struct message for a user action: only the signed fields, addresses lowercased. */
export function userSignedMessage(a: HlUserAction): Record<string, unknown> {
  const spec = USER_SIGNED_TYPES[a.type];
  if (!spec) throw new Error(`hl-signer: unsupported user action ${String((a as { type?: unknown }).type)}`);
  if (a.hyperliquidChain !== "Mainnet" && a.hyperliquidChain !== "Testnet") throw new Error("hl-signer: hyperliquidChain must be Mainnet or Testnet");
  if (!Number.isSafeInteger(a.nonce) || a.nonce <= 0) throw new Error("hl-signer: nonce must be a positive ms timestamp");
  const src = a as unknown as Record<string, unknown>;
  const msg: Record<string, unknown> = {};
  for (const f of spec.fields) {
    let v = src[f.name];
    if (v === undefined) throw new Error(`hl-signer: ${a.type} is missing ${f.name}`);
    if (f.type === "address") v = lowerAddress(String(v));
    msg[f.name] = v;
  }
  if (a.type === "approveBuilderFee") assertMaxFeeRate(a.maxFeeRate);
  if (a.type === "sendAsset") {
    msg.destination = lowerAddress(a.destination);
    if (a.fromSubAccount !== "") msg.fromSubAccount = lowerAddress(a.fromSubAccount);
  }
  return msg;
}

export function userSignedTypedData(a: HlUserAction): TypedDataPayload {
  const spec = USER_SIGNED_TYPES[a.type];
  const message = userSignedMessage(a);
  return {
    domain: { name: USER_SIGNED_DOMAIN_NAME, version: "1", chainId: signatureChainIdNumber(a.signatureChainId), verifyingContract: ZERO_ADDRESS },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      [spec.primaryType]: spec.fields.map((f) => ({ ...f })),
    },
    primaryType: spec.primaryType,
    message,
  };
}

export function userSignedDigest(a: HlUserAction): Hex {
  return hashTypedPayload(userSignedTypedData(a));
}
