// R9 (local part): the partially signed Solana tx is validated before settle: 3 to 7 instructions, a memo, the fee
// payer in no instruction, compute price at most 5 lamports per CU (and Capstan's tighter economics cap).
// The devnet settle lives in test/testnet/svm-devnet.test.ts (skips without SOLANA_DEVNET_PAYER, BACKLOG A6).
import { describe, expect, test } from "bun:test";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { SOLANA_MAX_CU_PRICE_MICROLAMPORTS } from "../src/accepts";
import { COMPUTE_BUDGET_PROGRAM, LIGHTHOUSE_PROGRAM, MEMO_PROGRAM, TOKEN_PROGRAM, validateSvmLayout } from "../src/svm";

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function keypair(label: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`capstan-x402-svm-test:${label}`))); // test-key (public label)
  return createKeyPairSignerFromPrivateKeyBytes(bytes);
}

const limitIx = (cu = 20_000): Instruction => ({ programAddress: address(COMPUTE_BUDGET_PROGRAM), data: cat(new Uint8Array([2]), u32(cu)) });
const priceIx = (micro: bigint): Instruction => ({ programAddress: address(COMPUTE_BUDGET_PROGRAM), data: cat(new Uint8Array([3]), u64(micro)) });
const memoIx = (text = "capstan-0123456789abcdef"): Instruction => ({ programAddress: address(MEMO_PROGRAM), data: new TextEncoder().encode(text) });
const lighthouseIx = (): Instruction => ({ programAddress: address(LIGHTHOUSE_PROGRAM), data: new Uint8Array([1]) });

function transferIx(source: Address, mint: Address, dest: Address, owner: Address): Instruction {
  return {
    programAddress: address(TOKEN_PROGRAM),
    accounts: [
      { address: source, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: dest, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY_SIGNER },
    ],
    data: cat(new Uint8Array([12]), u64(10_000n), new Uint8Array([6])),
  };
}

async function build(ixs: (ctx: { payer: Address; feePayer: Address }) => Instruction[]) {
  const payer = await keypair("payer");
  const feePayer = (await keypair("fee-payer")).address;
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 1000n }, m),
    (m) => appendTransactionMessageInstructions(ixs({ payer: payer.address, feePayer }), m),
  );
  const compiled = compileTransaction(msg);
  const needsPayer = Object.keys(compiled.signatures).includes(payer.address);
  const tx = needsPayer ? await partiallySignTransaction([payer.keyPair], compiled) : compiled;
  return { b64: getBase64EncodedWireTransaction(tx), feePayer };
}

const MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SRC = address("So11111111111111111111111111111111111111112");
const DST = address("SysvarRent111111111111111111111111111111111");

describe("svm layout", () => {
  test("layout-rules", async () => {
    const good = await build(({ payer }) => [limitIx(), priceIx(1n), transferIx(SRC, MINT, DST, payer), memoIx()]);
    const ok = validateSvmLayout(good.b64, { feePayer: good.feePayer });
    expect(ok).toEqual({ ok: true, computeUnitPrice: 1n, computeUnitLimit: 20_000 });
    // up to 7 with Lighthouse
    const seven = await build(({ payer }) => [limitIx(), priceIx(1n), transferIx(SRC, MINT, DST, payer), lighthouseIx(), lighthouseIx(), memoIx("a"), memoIx("b")]);
    expect(validateSvmLayout(seven.b64, { feePayer: seven.feePayer }).ok).toBe(true);
    // 8 instructions
    const eight = await build(({ payer }) => [limitIx(), priceIx(1n), transferIx(SRC, MINT, DST, payer), lighthouseIx(), lighthouseIx(), lighthouseIx(), lighthouseIx(), memoIx()]);
    expect(validateSvmLayout(eight.b64, { feePayer: eight.feePayer })).toMatchObject({ ok: false, reason: expect.stringContaining("outside 3 to 7") });
    // fewer than 3
    const two = await build(() => [limitIx(), priceIx(1n)]);
    expect(validateSvmLayout(two.b64, { feePayer: two.feePayer }).ok).toBe(false);
    // no memo
    const noMemo = await build(({ payer }) => [limitIx(), priceIx(1n), transferIx(SRC, MINT, DST, payer), lighthouseIx()]);
    expect(validateSvmLayout(noMemo.b64, { feePayer: noMemo.feePayer })).toEqual({ ok: false, reason: "a Memo instruction is required" });
    // compute price: 5 lamports per CU passes the layout rule, 5 lamports + 1 microlamport fails
    const atMax = await build(({ payer }) => [limitIx(), priceIx(5_000_000n), transferIx(SRC, MINT, DST, payer), memoIx()]);
    expect(validateSvmLayout(atMax.b64, { feePayer: atMax.feePayer }).ok).toBe(true);
    const over = await build(({ payer }) => [limitIx(), priceIx(5_000_001n), transferIx(SRC, MINT, DST, payer), memoIx()]);
    expect(validateSvmLayout(over.b64, { feePayer: over.feePayer }).ok).toBe(false);
    // and Capstan's economics cap refuses what the layout allows
    expect(validateSvmLayout(atMax.b64, { feePayer: atMax.feePayer, maxCuPriceMicrolamports: SOLANA_MAX_CU_PRICE_MICROLAMPORTS }).ok).toBe(false);
    // fee payer inside an instruction (as the transfer source)
    const drain = await build(({ payer, feePayer }) => [limitIx(), priceIx(1n), transferIx(feePayer, MINT, DST, payer), memoIx()]);
    expect(validateSvmLayout(drain.b64, { feePayer: drain.feePayer })).toEqual({ ok: false, reason: "fee payer appears in an instruction" });
    // wrong sponsor, unknown program, wrong order, garbage
    expect(validateSvmLayout(good.b64, { feePayer: "SysvarC1ock11111111111111111111111111111111" }).ok).toBe(false);
    const unknown = await build(({ payer }) => [limitIx(), priceIx(1n), transferIx(SRC, MINT, DST, payer), { programAddress: address("Stake11111111111111111111111111111111111111"), data: new Uint8Array([0]) }, memoIx()]);
    expect(validateSvmLayout(unknown.b64, { feePayer: unknown.feePayer }).ok).toBe(false);
    const swapped = await build(({ payer }) => [priceIx(1n), limitIx(), transferIx(SRC, MINT, DST, payer), memoIx()]);
    expect(validateSvmLayout(swapped.b64, { feePayer: swapped.feePayer }).ok).toBe(false);
    expect(validateSvmLayout("bm90IGEgdHg=", { feePayer: good.feePayer })).toEqual({ ok: false, reason: "transaction does not decode" });
  });
});
