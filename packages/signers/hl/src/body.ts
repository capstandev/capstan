// The JSON body posted to /exchange: {action, nonce, signature, vaultAddress, expiresAfter} (python SDK form).
import type { Hex } from "@capstan/schema";
import { lowerAddress } from "./bytes";
import { lowercaseAction } from "./l1";
import { userSignedMessage } from "./user";
import type { HlL1Action, HlUserAction } from "./types";

export interface HlExchangeBody {
  action: Record<string, unknown>;
  nonce: number;
  signature: { r: Hex; s: Hex; v: number };
  vaultAddress: Hex | null;
  expiresAfter: number | null;
}

export function isUserAction(a: HlL1Action | HlUserAction): a is HlUserAction {
  return "hyperliquidChain" in a && "signatureChainId" in a;
}

/** The posted form of a user action: type, signatureChainId, hyperliquidChain and the signed fields. */
export function postedUserAction(a: HlUserAction): Record<string, unknown> {
  const out: Record<string, unknown> = { type: a.type, signatureChainId: a.signatureChainId, ...userSignedMessage(a) };
  // Unnamed agent: the SDK signs agentName "" and then deletes the key from the posted action.
  if (a.type === "approveAgent" && a.agentName === "") delete out.agentName;
  return out;
}

export function postBody(action: HlL1Action | HlUserAction, sig: { r: Hex; s: Hex; v: number }, nonce: number, vault?: Hex, expiresAfter?: number): HlExchangeBody {
  if (isUserAction(action)) {
    if (action.nonce !== nonce) throw new Error("hl-signer: user action nonce must equal the posted nonce");
    if (vault !== undefined || expiresAfter !== undefined) throw new Error("hl-signer: user-signed actions take no vault or expiresAfter");
    return { action: postedUserAction(action), nonce, signature: { r: sig.r, s: sig.s, v: sig.v }, vaultAddress: null, expiresAfter: null };
  }
  return {
    action: lowercaseAction(action) as unknown as Record<string, unknown>,
    nonce,
    signature: { r: sig.r, s: sig.s, v: sig.v },
    vaultAddress: vault === undefined ? null : lowerAddress(vault),
    expiresAfter: expiresAfter ?? null,
  };
}
