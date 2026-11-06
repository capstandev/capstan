// Receipt verification in the browser (spec 11): the receipts library's verifyFull checks the signature, recomputes
// the leaf, checks the sorted-pair proof and reads the hourly root from the anchor over a JSON-RPC endpoint. The
// server's own /verify answer is never used; only the receipt and its proof are fetched.
import { PINS, mergePins, rpcAnchorReader, verifyFull, type Hex, type Network, type PinsOverride, type Receipt, type VerifyChecks } from "./capstan";

export interface ProofBody {
  hourEpoch: number;
  proof: Hex[];
  root: Hex | null;
  leaf?: Hex;
  anchored?: boolean;
}

export interface VerifyOutcome {
  receipt: Receipt;
  proof: ProofBody;
  valid: boolean;
  checks: VerifyChecks & { hour: boolean };
  signerSource: "pins" | "override" | "none";
}

export interface VerifyDeps {
  apiBase: string;
  network: Network;
  rpcUrl: string;
  fetch?: typeof fetch;
  pinned?: PinsOverride;
  receiptSigners?: Hex[];
  anchorAddress?: Hex | null;
  anchorChainId?: number;
}

export class VerifyInputError extends Error {}

const ID = /^[A-Za-z0-9_-]{1,80}$/;

async function getJson<T>(f: typeof fetch, url: string): Promise<T> {
  const r = await f(url, { headers: { accept: "application/json" } });
  const text = await r.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!r.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message;
    throw new VerifyInputError(msg ? `The API answered: ${msg}` : `The API answered with status ${r.status}.`);
  }
  return body as T;
}

/** Parse what the user pasted: a receipt id, a receipt object, or { receipt, proof }. */
export function parseInput(raw: string): { id: string } | { receipt: Receipt; proof?: ProofBody } {
  const s = raw.trim();
  if (!s) throw new VerifyInputError("Paste a receipt id or the receipt JSON.");
  if (s.startsWith("{")) {
    let j: unknown;
    try {
      j = JSON.parse(s);
    } catch {
      throw new VerifyInputError("That is not valid JSON.");
    }
    const o = j as { receipt?: Receipt; proof?: ProofBody } & Partial<Receipt>;
    if (o.receipt && typeof o.receipt === "object") return { receipt: o.receipt, ...(o.proof ? { proof: o.proof } : {}) };
    if (typeof o.receiptId === "string") return { receipt: o as Receipt };
    throw new VerifyInputError("The JSON has no receiptId.");
  }
  if (!ID.test(s)) throw new VerifyInputError("A receipt id has letters, digits, dashes and underscores only.");
  return { id: s };
}

export async function verifyReceiptInput(raw: string, d: VerifyDeps): Promise<VerifyOutcome> {
  const f = d.fetch ?? fetch;
  const base = d.apiBase.replace(/\/$/, "");
  const parsed = parseInput(raw);
  let receipt: Receipt;
  let proof: ProofBody | undefined;
  if ("id" in parsed) {
    receipt = await getJson<Receipt>(f, `${base}/receipts/${encodeURIComponent(parsed.id)}`);
    if (receipt?.receiptId !== parsed.id) throw new VerifyInputError("The API returned another receipt than the one asked for.");
  } else {
    receipt = parsed.receipt;
    proof = parsed.proof;
  }
  if (!ID.test(String(receipt.receiptId ?? ""))) throw new VerifyInputError("The receipt id is malformed.");
  proof ??= await getJson<ProofBody>(f, `${base}/receipts/${encodeURIComponent(receipt.receiptId)}/proof`);

  const np = mergePins(PINS, d.pinned).networks[d.network];
  const signerSource: VerifyOutcome["signerSource"] = d.receiptSigners?.length ? "override" : np.receiptSigners.length ? "pins" : "none";
  const signers = d.receiptSigners?.length ? d.receiptSigners : np.receiptSigners;
  const anchor = d.anchorAddress !== undefined ? d.anchorAddress : np.anchor.address;
  const reader = anchor ? rpcAnchorReader({ rpcUrl: d.rpcUrl, address: anchor, chainId: d.anchorChainId ?? np.anchor.chainId, fetch: f }) : null;
  const out = await verifyFull(receipt, {
    proof: Array.isArray(proof.proof) ? proof.proof : [],
    root: proof.root ?? null,
    signers,
    ...(proof.leaf ? { claimedLeaf: proof.leaf } : {}),
    ...(reader ? { readRoot: (h: number) => reader.rootOf(h) } : {}),
  });
  // the proof must be for the receipt's own hour
  const hour = Math.floor(Date.parse(receipt.ts) / 3_600_000) === proof.hourEpoch;
  return { receipt, proof, valid: out.valid && hour, checks: { ...out.checks, hour }, signerSource };
}
