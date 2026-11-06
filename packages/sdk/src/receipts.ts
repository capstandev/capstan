// Independent receipt verification (spec 11). The receipt, its proof and the hourly root are checked here with the
// receipts library (signature, recomputed leaf, sorted-pair proof); the on-chain part is one eth_call to the anchor's
// rootOf(hourEpoch) over a public RPC. No Capstan call is needed once the receipt and proof are in hand.
import type { Hex, Receipt } from "@capstan/schema";
import { verifyFull, type VerifyChecks } from "@capstan/receipts/src/verify";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { toHex } from "./bytes";
import { SdkError } from "./errors";

export type { VerifyChecks };

export interface ReceiptProof {
  hourEpoch: number;
  proof: Hex[];
  root: Hex | null;
}

export interface AnchorReader {
  /** The root posted for an hour, or null when none was posted. */
  rootOf(hourEpoch: number): Promise<Hex | null>;
}

export const ROOT_OF_SELECTOR = toHex(keccak_256(new TextEncoder().encode("rootOf(uint64)")).slice(0, 4));

/** eth_call rootOf(uint64) on a public JSON-RPC endpoint. Checks the chain id before trusting any answer. */
export function rpcAnchorReader(o: { rpcUrl: string; address: Hex; chainId: number; fetch?: typeof fetch }): AnchorReader {
  const f = o.fetch ?? fetch;
  let id = 0;
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    const r = await f(o.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
    if (j.error || j.result === undefined) throw new SdkError("VENUE_ERROR", `RPC ${method} failed`);
    return j.result;
  };
  let chainChecked = false;
  return {
    async rootOf(hourEpoch) {
      if (!Number.isSafeInteger(hourEpoch) || hourEpoch < 0) throw new SdkError("INVALID_INPUT", "bad hour");
      if (!chainChecked) {
        const cid = Number(BigInt(String(await call("eth_chainId", []))));
        if (cid !== o.chainId) throw new SdkError("DEPLOYMENT_MISMATCH", `the RPC serves chain ${cid}, not ${o.chainId}`, { field: "chainId" });
        chainChecked = true;
      }
      const data = `${ROOT_OF_SELECTOR}${BigInt(hourEpoch).toString(16).padStart(64, "0")}`;
      const out = String(await call("eth_call", [{ to: o.address, data }, "latest"]));
      if (!/^0x[0-9a-fA-F]{192}$/.test(out)) throw new SdkError("VENUE_ERROR", "unexpected rootOf answer");
      const root = `0x${out.slice(2, 66)}` as Hex;
      return /^0x0+$/.test(root) ? null : root;
    },
  };
}

/**
 * Verify one receipt from its body and proof. onChainRoot is true (posted and equal), false (posted and different:
 * invalid), "not_posted" (the hour is not anchored yet) or "unchecked" (no anchor reader). Only false fails the receipt.
 */
export async function verifyReceiptOffline(r: Receipt, p: ReceiptProof, deps: { signers: { address: Hex; from?: string; to?: string }[]; anchor?: AnchorReader }): Promise<{ valid: boolean; checks: VerifyChecks }> {
  const out = await verifyFull(r, {
    proof: p.proof,
    root: p.root,
    signers: deps.signers,
    ...(deps.anchor ? { readRoot: (h: number) => deps.anchor!.rootOf(h) } : {}),
  });
  // the hour the proof names must be the receipt's own hour
  const hour = Math.floor(Date.parse(r.ts) / 3_600_000);
  const hourOk = hour === p.hourEpoch;
  return { valid: out.valid && hourOk, checks: hourOk ? out.checks : { ...out.checks, proof: false } };
}
