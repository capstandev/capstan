// HIP-3 test setup: the order setup plus a HIP-3 hook (executable everywhere the wiring allows, equities on in tests).
import type { Hex } from "@capstan/schema";
import { addressOf } from "@capstan/signer-hl";
import { createHip3Gate, createHip3Hook, type Hip3Deps } from "../../src";
import { ctx, key, setup } from "../orders/util";

export const EMPTY_OWNER = addressOf(key("empty-owner")).toLowerCase() as Hex;

export function hip3Setup(override?: (b: Record<string, any>) => unknown, over: Partial<Hip3Deps> = {}, env: Record<string, string> = {}) {
  const s = setup(override);
  const gate = createHip3Gate(env);
  const hook = createHip3Hook({ reader: s.reader, gate, isExecutable: () => true, eqExecutionAllowed: () => true, ...over });
  const deps = { ...s.deps, hip3: hook };
  return { ...s, gate, hook, deps };
}

export const intent = (over: Record<string, unknown> = {}) => ({ marketId: "hyperliquid:xyz:TSLA", side: "buy" as const, size: "0.5", type: "market" as const, tif: "ioc" as const, reduceOnly: false, maxSlippageBps: 50, leverage: 5, ...over });
export { ctx };
