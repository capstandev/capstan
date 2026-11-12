// Solana devnet wallets for make-wallets.sh: an encrypted solana-ed25519 v3 keystore (scrypt + AES-128-CTR, the format
// packages/x402 svmKeystoreSigner reads) per Solana role, the password in a chmod-600 file next to it. The secret is made
// here, encrypted, and zeroed; only the public address is printed and recorded.
// `--payto-ata` (ensurePaytoAta): creates sol-payto's devnet USDC associated token account once, with the idempotent
// create instruction, sol-facilitator paying the rent (about 0.00204 SOL). This is account setup on devnet, not a
// payment to anyone. Without it the facilitator refuses every payment with invalid_exact_svm_recipient_ata_missing.
import { decryptSvmKeystore, encryptSvmKeystore, svmKeystoreSigner } from "@capstan/x402";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { assertSolanaDevnet, rpcCall, type Fetch } from "./guard";
import { keystorePath, passwordPath, paths, readAddresses, recordAddress, WALLETS } from "./wallets";

export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EHFLp4dPoJqgzQ6vF5aD3"] as const;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** Devnet USDC (doctor.ts TOKENS.usdcSolanaDevnet). */
export const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** The associated token account of (owner, mint) under a token program. */
export async function ataAddress(owner: string, mint: string, tokenProgram: string): Promise<Address> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({ programAddress: address(ATA_PROGRAM), seeds: [enc.encode(address(owner)), enc.encode(address(tokenProgram)), enc.encode(address(mint))] });
  return pda;
}

export interface AtaResult {
  owner: string;
  ata: string;
  created: boolean;
  signature: string | null;
}

/**
 * Idempotent: asserts the devnet genesis, reads the mint's token program, and sends CreateIdempotent only when the
 * account is missing. `payer` signs as fee payer and rent payer. Polls getSignatureStatuses (no websocket).
 */
export async function ensureAta(
  o: { owner: string; mint?: string; payer: KeyPairSigner; rpc: string; f?: Fetch; sleep?: (ms: number) => Promise<void> },
): Promise<AtaResult> {
  const f = o.f ?? fetch;
  const mint = o.mint ?? USDC_DEVNET_MINT;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await assertSolanaDevnet(o.rpc, f);
  const info = (a: string) => rpcCall<{ value: { owner: string } | null }>(o.rpc, "getAccountInfo", [a, { encoding: "base64", commitment: "confirmed" }], f);
  const mintInfo = await info(mint);
  const tokenProgram = mintInfo.value?.owner;
  if (!tokenProgram || !(TOKEN_PROGRAMS as readonly string[]).includes(tokenProgram)) throw new Error(`mint ${mint}: not a token mint on this cluster`);
  const ata = await ataAddress(o.owner, mint, tokenProgram);
  if ((await info(ata)).value) return { owner: o.owner, ata, created: false, signature: null };
  const bh = await rpcCall<{ value: { blockhash: string; lastValidBlockHeight: number } }>(o.rpc, "getLatestBlockhash", [{ commitment: "confirmed" }], f);
  const ix = {
    programAddress: address(ATA_PROGRAM),
    accounts: [
      { address: o.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: o.payer },
      { address: ata, role: AccountRole.WRITABLE },
      { address: address(o.owner), role: AccountRole.READONLY },
      { address: address(mint), role: AccountRole.READONLY },
      { address: address(SYSTEM_PROGRAM), role: AccountRole.READONLY },
      { address: address(tokenProgram), role: AccountRole.READONLY },
    ] as const,
    data: new Uint8Array([1]), // CreateIdempotent
  };
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(o.payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.value.blockhash as never, lastValidBlockHeight: BigInt(bh.value.lastValidBlockHeight) }, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const signature = getSignatureFromTransaction(tx);
  await rpcCall<string>(o.rpc, "sendTransaction", [getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" }], f);
  for (let i = 0; i < 60; i++) {
    const st = await rpcCall<{ value: ({ confirmationStatus?: string; err?: unknown } | null)[] }>(o.rpc, "getSignatureStatuses", [[signature]], f);
    const s = st.value[0];
    if (s?.err) throw new Error(`create ATA ${signature} failed: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return { owner: o.owner, ata, created: true, signature };
    await sleep(1000);
  }
  throw new Error(`create ATA ${signature}: not confirmed after 60 s`);
}

/** sol-payto's devnet USDC account, rent paid by sol-facilitator (keystore and password file by path only). */
export async function ensurePaytoAta(env: Record<string, string | undefined> = process.env, f: Fetch = fetch): Promise<AtaResult> {
  const p = paths(env);
  const owner = (await readAddresses(p))["sol-payto"];
  if (!owner) throw new Error("sol-payto not made (run make-wallets.sh)");
  const fac = WALLETS.find((w) => w.role === "sol-facilitator")!;
  const payer = await svmKeystoreSigner(keystorePath(fac, p), passwordPath(fac, p));
  const rpc = env.SOLANA_DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
  return ensureAta({ owner, payer, rpc, f });
}

export async function makeSolanaWallets(env: Record<string, string | undefined> = process.env): Promise<{ role: string; address: string; created: boolean }[]> {
  const p = paths(env);
  mkdirSync(p.solana, { recursive: true, mode: 0o700 });
  const n = env.CAPSTAN_TESTNET_SCRYPT_N ? Number(env.CAPSTAN_TESTNET_SCRYPT_N) : undefined;
  const known = await readAddresses(p);
  const out: { role: string; address: string; created: boolean }[] = [];
  for (const w of WALLETS.filter((x) => x.kind === "solana")) {
    const ks = keystorePath(w, p);
    const pwf = passwordPath(w, p);
    let created = false;
    if (!existsSync(ks)) {
      if (!existsSync(pwf)) {
        writeFileSync(pwf, Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex"), { mode: 0o600 });
        chmodSync(pwf, 0o600);
      }
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const json = await encryptSvmKeystore(secret, readFileSync(pwf, "utf8").trim(), n ? { n } : {});
      secret.fill(0);
      writeFileSync(ks, json, { mode: 0o600 });
      chmodSync(ks, 0o600);
      created = true;
    } else if (!existsSync(pwf)) throw new Error(`${w.role}: keystore exists without its password file`);
    let address = known[w.role];
    if (!address || created) {
      address = (await decryptSvmKeystore(readFileSync(ks, "utf8"), readFileSync(pwf, "utf8").trim())).address;
      await recordAddress(p, w.role, address);
    }
    out.push({ role: w.role, address, created });
  }
  return out;
}

if (import.meta.main && process.argv.includes("--payto-ata")) {
  const r = await ensurePaytoAta();
  console.log(r.created ? `sol-payto USDC account ${r.ata} created (solana devnet), signature ${r.signature}` : `sol-payto USDC account ${r.ata} already there (solana devnet)`);
} else if (import.meta.main) {
  for (const r of await makeSolanaWallets()) console.log(`${r.role} ${r.address} ${r.created ? "created" : "exists"} (solana devnet)`);
}
