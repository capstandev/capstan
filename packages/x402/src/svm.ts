// Solana exact-scheme layout rules, checked before the SDK facilitator sees a payment (defence in depth):
// 3 to 7 instructions; [0] ComputeBudget SetComputeUnitLimit, [1] ComputeBudget SetComputeUnitPrice at most the
// cap, [2] SPL Token or Token-2022 TransferChecked, then only Memo or Lighthouse instructions, with a Memo present;
// the fee payer (the facilitator sponsor) is account 0 and appears in no instruction.
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";

export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
/** x402 layout maximum: 5 lamports per compute unit. */
export const LAYOUT_MAX_CU_PRICE_MICROLAMPORTS = 5_000_000n;

export type SvmLayoutResult = { ok: true; computeUnitPrice: bigint; computeUnitLimit: number } | { ok: false; reason: string };

function u64le(b: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!);
  return v;
}
function u32le(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}

export function validateSvmLayout(transactionBase64: string, opts: { feePayer: string; maxCuPriceMicrolamports?: bigint }): SvmLayoutResult {
  const fail = (reason: string): SvmLayoutResult => ({ ok: false, reason });
  let msg;
  try {
    const wire = getBase64Encoder().encode(transactionBase64);
    const tx = getTransactionDecoder().decode(wire);
    msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch {
    return fail("transaction does not decode");
  }
  if (!("instructions" in msg)) return fail("unsupported transaction message version");
  const accounts = msg.staticAccounts.map(String);
  if (accounts[0] !== opts.feePayer) return fail("fee payer is not the facilitator sponsor");
  const ixs = msg.instructions;
  if (ixs.length < 3 || ixs.length > 7) return fail(`instruction count ${ixs.length} is outside 3 to 7`);
  const prog = (i: number) => accounts[ixs[i]!.programAddressIndex] ?? "";
  const data = (i: number) => (ixs[i]!.data ?? new Uint8Array()) as Uint8Array;
  for (const ix of ixs) for (const a of ix.accountIndices ?? []) if (a === 0) return fail("fee payer appears in an instruction");
  if (prog(0) !== COMPUTE_BUDGET_PROGRAM || data(0)[0] !== 2 || data(0).length !== 5) return fail("instruction 0 must be SetComputeUnitLimit");
  if (prog(1) !== COMPUTE_BUDGET_PROGRAM || data(1)[0] !== 3 || data(1).length !== 9) return fail("instruction 1 must be SetComputeUnitPrice");
  const computeUnitLimit = u32le(data(0), 1);
  const computeUnitPrice = u64le(data(1), 1);
  const cap = opts.maxCuPriceMicrolamports ?? LAYOUT_MAX_CU_PRICE_MICROLAMPORTS;
  if (computeUnitPrice > cap) return fail(`compute unit price ${computeUnitPrice} is above ${cap} microlamports`);
  if (![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(prog(2)) || data(2)[0] !== 12) return fail("instruction 2 must be a token TransferChecked");
  let memo = false;
  for (let i = 3; i < ixs.length; i++) {
    const p = prog(i);
    if (p === MEMO_PROGRAM) memo = true;
    else if (p !== LIGHTHOUSE_PROGRAM) return fail(`instruction ${i} is not a Memo or Lighthouse instruction`);
  }
  if (!memo) return fail("a Memo instruction is required");
  return { ok: true, computeUnitPrice, computeUnitLimit };
}
