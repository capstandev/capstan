// Full public verification of one receipt (spec 11): signature, leaf, proof, on-chain root.
// The leaf is ALWAYS recomputed from the receipt: a sorted-pair tree accepts an internal node with a shortened proof,
// so a caller-supplied leaf is never trusted (it is only compared, if given).
import type { Hex, Receipt } from "@capstan/schema";
import { hourEpochOf } from "./chain";
import { receiptLeaf, unsignedBody } from "./hash";
import { type SignerWindow, verifyReceiptSig } from "./sign";
import { verifyProof } from "./tree";

/**
 * onChainRoot: true (posted and equal), false (posted and different), "not_posted" (the current or just-ended hour,
 * whose root may still come: the receipt is pending, not valid), "unanchored" (an older hour with no root: it can never
 * be anchored, so the receipt is invalid), "unchecked" (no chain reader was given: never valid, status "unchecked").
 */
export type VerifyChecks = { signature: boolean; leaf: boolean; proof: boolean; onChainRoot: boolean | "not_posted" | "unanchored" | "unchecked" };
/**
 * "valid" only with the posted root read on chain. "pending": sound, its hour may still be anchored. "unchecked":
 * sound, but no chain reader was given, so nothing ties it to a posted root (a forged receipt looks the same).
 */
export type VerifyStatus = "valid" | "pending" | "unchecked" | "invalid";

export interface VerifyDeps {
  proof: Hex[];
  root: Hex | null;
  readRoot?: (hourEpoch: number) => Promise<Hex | null>;
  /** The anchor's latestHour(). A zero root for an hour at or below it can never be posted (roots only increase). */
  latestHour?: () => Promise<number | null>;
  signers: Array<Hex | SignerWindow>;
  /** A leaf the server claims for this receipt. Compared with the recomputed leaf; never used for the proof. */
  claimedLeaf?: Hex;
  /** Clock for the pending window (default Date.now). */
  nowMs?: number;
  /** How long after an hour ends its root may still be posted (default 2 h). */
  pendingGraceMs?: number;
}

const ZERO = `0x${"0".repeat(64)}`;
const HOUR_MS = 3_600_000;
export const DEFAULT_PENDING_GRACE_MS = 2 * HOUR_MS;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Security r1 (review-r1:6 F1): verification never fails open. A receipt whose hour has no root on chain is "pending"
 * (valid false) while that root may still come, and "invalid" once it cannot: the hour is at or below the anchor's
 * latestHour, or ended more than the grace ago. A forged receipt backdated into an empty past hour is never valid.
 * With no chain reader the root is "unchecked" and the receipt is not valid either (status "unchecked"): a leaked
 * signer key can make a receipt with a matching signature, leaf and one-leaf proof, so only the posted root decides.
 */
export async function verifyFull(r: Receipt, deps: VerifyDeps): Promise<{ valid: boolean; status: VerifyStatus; checks: VerifyChecks }> {
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
      if (chainRoot === null || eq(chainRoot, ZERO)) {
        const now = deps.nowMs ?? Date.now();
        const grace = deps.pendingGraceMs ?? DEFAULT_PENDING_GRACE_MS;
        // a reader that cannot answer latestHour leaves only the time rule (never a reason to pass)
        const latest = deps.latestHour ? await deps.latestHour().catch(() => null) : null;
        const pastLatest = latest !== null && latest > 0 && hour <= latest;
        const tooOld = now - (hour + 1) * HOUR_MS > grace;
        const future = hour * HOUR_MS > now + HOUR_MS; // a ts ahead of the clock is never pending
        onChainRoot = pastLatest || tooOld || future ? "unanchored" : "not_posted";
      } else onChainRoot = deps.root !== null && eq(chainRoot, deps.root);
    }
  }
  const sound = signature && leafOk && proof;
  const valid = sound && onChainRoot === true;
  const status: VerifyStatus = valid ? "valid" : sound && onChainRoot === "not_posted" ? "pending" : sound && onChainRoot === "unchecked" ? "unchecked" : "invalid";
  return { valid, status, checks: { signature, leaf: leafOk, proof, onChainRoot } };
}
