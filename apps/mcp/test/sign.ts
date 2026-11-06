// Local signing for MCP tests, the way a host does it: the Capstan SDK checks the build against the intent and the
// pinned builder, then signs the checked digest with the local key store.
import { checkBuild, hlAssetId, mergePins, PINS, type KeyStore } from "@capstan/sdk";
import { signEnvelope } from "@capstan/sdk/src/sign";
import type { Hex, OrderIntent, SignedEnvelope, UnsignedVenuePayload } from "@capstan/schema";
import { BUILDER } from "../../../packages/adapters/hyperliquid/test/helpers";
import { T0 } from "../../../packages/adapters/hyperliquid/test/orders/util";
import { TSLA } from "./stack";

export const TSLA_SPEC = { venue: "hyperliquid" as const, marketId: TSLA, assetId: hlAssetId(1, 1), szDecimals: 3 };
export const PINNED = mergePins(PINS, { networks: { mainnet: { builders: { hyperliquid: BUILDER, aster: null } } } });

export async function signChecked(intent: OrderIntent, b: UnsignedVenuePayload, k: { keystore: KeyStore; keyRef: string; agentAddress: Hex; owner: Hex }): Promise<SignedEnvelope> {
  const c = checkBuild(intent, b, { venue: b.venue, approvedMax: 3, pins: PINNED, nowMs: T0, network: "mainnet", market: TSLA_SPEC, refPx: "347.65", identity: { owner: k.owner, agentAddress: k.agentAddress } });
  if (!c.ok) throw new Error(`build refused by the local check: ${c.code} ${c.field}`);
  return signEnvelope(b, { keystore: k.keystore, keyRef: k.keyRef, signerRef: k.agentAddress, digest: c.digest });
}

export const tslaShort = (size = "1.000"): OrderIntent => ({ marketId: TSLA, side: "sell", size, type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 });
