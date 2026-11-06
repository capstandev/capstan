// Full public verification of one receipt (spec 11): signature, leaf, proof, on-chain root.
// The leaf is ALWAYS recomputed from the receipt: a sorted-pair tree accepts an internal node with a shortened proof,
// so a caller-supplied leaf is never trusted (it is only compared, if given).
import type { Hex, Receipt } from "@capstan/schema";
import { hourEpochOf } from "./chain";
import { receiptLeaf, unsignedBody } from "./hash";
import { type SignerWindow, verifyReceiptSig } from "./sign";
import { verifyProof } from "./tree";

export type VerifyChecks = { signature: boolean; leaf: boolean; proof: boolean; onChainRoot: boolean | "not_posted" | "unchecked" };

export interface VerifyDeps {
  proof: Hex[];
  root: Hex | null;
  readRoot?: (hourEpoch: number) => Promise<Hex | null>;
  signers: Array<Hex | SignerWindow>;
  /** A leaf the server claims for this receipt. Compared with the recomputed leaf; never used for the proof. */
  claimedLeaf?: Hex;
}

const ZERO = `0x${"0".repeat(64)}`;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function verifyFull(r: Receipt, deps: VerifyDeps): Promise<{ valid: boolean; checks: VerifyChecks }> {
  const signature = verifyReceiptSig(r, deps.signers);
  let leaf: Hex | null = null;
  try {
    leaf = receiptLeaf(unsignedBody(r));
  } catch {
    leaf = null;
  }
  const leafOk = leaf !== null && (deps.claimedLeaf === undefined || eq(deps.claimedLeaf, leaf));
  const proof = leaf !== null && deps.root !== null && verifyProof(leaf, deps.proof, deps.root);
  let onChainRoot: VerifyChecks["onChainRoot"] = "unchecked";
  if (deps.readRoot) {
    let hour: number | null = null;
    try {
      hour = hourEpochOf(r.ts);
    } catch {
      hour = null;
    }
    if (hour === null) onChainRoot = false;
    else {
      const chainRoot = await deps.readRoot(hour);
      if (chainRoot === null || eq(chainRoot, ZERO)) onChainRoot = "not_posted";
      else onChainRoot = deps.root !== null && eq(chainRoot, deps.root);
    }
  }
  const valid = signature && leafOk && proof && onChainRoot !== false;
  return { valid, checks: { signature, leaf: leafOk, proof, onChainRoot } };
}
