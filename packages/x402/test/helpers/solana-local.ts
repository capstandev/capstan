// Local Solana validator for the x402 rail proof (tracker line 78). Starts solana-test-validator on the lane ports
// with the real mainnet USDC mint (read once from a public mainnet RPC with getAccountInfo, never written to) and
// funds local accounts by loading them at genesis (--account), so no faucet and no airdrop is used. When the mainnet
// read fails, a local mint at the same address with the same 6 decimals is loaded instead, and `mintSource` says so.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { ADDRESSES } from "@capstan/schema";
import { NETWORKS } from "../../src/networks";
import { TOKEN_PROGRAM } from "../../src/svm";

// RPC 25540 (+1 websocket), faucet 25542 (holds 0 SOL, never used), gossip 25543, facilitator 25559. The validator
// needs at least 26 dynamic ports, more than the lane block, so they sit in a quiet high block (env overrides it).
export const SOLANA_LANE_PORTS = { rpc: 25540, faucet: 25542, gossip: 25543, facilitator: 25559 } as const;
export const SOLANA_DYNAMIC_PORTS = process.env.SOLANA_DYNAMIC_PORT_RANGE ?? "45540-45579";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const USDC_MINT = ADDRESSES.usdcSolana.address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_ACCOUNT_RENT = 2_039_280;
const MINT_RENT = 1_461_600;

export const solanaValidatorBin: string | null = process.env.SOLANA_TEST_VALIDATOR ?? Bun.which("solana-test-validator");

export type AccountDump = { lamports: number; data: [string, "base64"]; owner: string; executable: boolean; rentEpoch: number; space: number };

export async function ataOf(owner: string, mint: string = USDC_MINT): Promise<Address> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({ programAddress: address(ATA_PROGRAM), seeds: [enc.encode(address(owner)), enc.encode(address(TOKEN_PROGRAM)), enc.encode(address(mint))] });
  return pda;
}

/** SPL Token account (165 bytes): mint, owner, amount, no delegate, initialized, not native, no close authority. */
export function tokenAccount(mint: string, owner: string, amount: bigint): AccountDump {
  const b = new Uint8Array(165);
  const enc = getAddressEncoder();
  b.set(enc.encode(address(mint)), 0);
  b.set(enc.encode(address(owner)), 32);
  new DataView(b.buffer).setBigUint64(64, amount, true);
  b[108] = 1;
  return { lamports: TOKEN_ACCOUNT_RENT, data: [Buffer.from(b).toString("base64"), "base64"], owner: TOKEN_PROGRAM, executable: false, rentEpoch: 0, space: 165 };
}

export function systemAccount(lamports: number): AccountDump {
  return { lamports, data: ["", "base64"], owner: SYSTEM_PROGRAM, executable: false, rentEpoch: 0, space: 0 };
}

/** A mint with no mint authority and 6 decimals: the fallback when mainnet cannot be read. */
export function localMint(decimals = 6, supply = 0n): AccountDump {
  const b = new Uint8Array(82);
  new DataView(b.buffer).setBigUint64(36, supply, true);
  b[44] = decimals;
  b[45] = 1;
  return { lamports: MINT_RENT, data: [Buffer.from(b).toString("base64"), "base64"], owner: TOKEN_PROGRAM, executable: false, rentEpoch: 0, space: 82 };
}

/** Read-only getAccountInfo of the mainnet USDC mint. */
export async function mainnetUsdcMint(rpcUrl = process.env.SOLANA_MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com"): Promise<AccountDump | null> {
  try {
    const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [USDC_MINT, { encoding: "base64" }] }), signal: AbortSignal.timeout(15_000) });
    const v = ((await res.json()) as { result?: { value?: AccountDump | null } }).result?.value;
    if (!v || v.owner !== TOKEN_PROGRAM || v.space !== 82) return null;
    return { ...v, rentEpoch: 0 };
  } catch {
    return null;
  }
}

export function mintDecimals(d: AccountDump): number {
  return Buffer.from(d.data[0], "base64")[44]!;
}

export async function rpcCall<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

export async function tokenBalance(url: string, ata: string): Promise<bigint> {
  const r = await rpcCall<{ value: { amount: string } }>(url, "getTokenAccountBalance", [ata, { commitment: "confirmed" }]);
  return BigInt(r.value.amount);
}

export interface LocalValidator {
  url: string;
  genesisHash: string;
  mintSource: "mainnet-clone" | "local-same-decimals";
  decimals: number;
  stop(): Promise<void>;
}

/** Refuse anything that is not a fresh local ledger: the RPC must be loopback and its genesis neither devnet nor mainnet. */
export function assertLocalGenesis(url: string, genesisHash: string): void {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`not a local RPC: ${url}`);
  for (const n of [NETWORKS.solana, NETWORKS.solanaDevnet]) {
    if (genesisHash.startsWith(n.slice("solana:".length))) throw new Error(`refusing to write: ${url} is ${n}`);
  }
}

export async function startLocalValidator(accounts: Record<string, AccountDump>, opts: { mint?: AccountDump | null } = {}): Promise<LocalValidator> {
  if (!solanaValidatorBin) throw new Error("solana-test-validator not found");
  const dir = mkdtempSync(join(tmpdir(), "capstan-solana-"));
  const mint = opts.mint === undefined ? await mainnetUsdcMint() : opts.mint;
  const all: Record<string, AccountDump> = { [USDC_MINT]: mint ?? localMint(6), ...accounts };
  const args = ["--ledger", join(dir, "ledger"), "--reset", "--quiet", "--bind-address", "127.0.0.1", "--rpc-port", String(SOLANA_LANE_PORTS.rpc), "--faucet-port", String(SOLANA_LANE_PORTS.faucet), "--faucet-sol", "0", "--gossip-port", String(SOLANA_LANE_PORTS.gossip), "--dynamic-port-range", SOLANA_DYNAMIC_PORTS];
  for (const [pubkey, account] of Object.entries(all)) {
    const f = join(dir, `${pubkey}.json`);
    writeFileSync(f, JSON.stringify({ pubkey, account }));
    args.push("--account", pubkey, f);
  }
  const proc: ChildProcess = spawn(solanaValidatorBin, args, { stdio: "ignore", cwd: dir });
  const url = `http://127.0.0.1:${SOLANA_LANE_PORTS.rpc}`;
  const stop = async () => {
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    }
    rmSync(dir, { recursive: true, force: true });
  };
  const deadline = Date.now() + 90_000;
  let genesisHash = "";
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try {
      if ((await rpcCall<string>(url, "getHealth")) === "ok") {
        // wait for a first block so blockhashes are valid
        if ((await rpcCall<number>(url, "getSlot")) > 1) {
          genesisHash = await rpcCall<string>(url, "getGenesisHash");
          break;
        }
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
  }
  if (!genesisHash) {
    await stop();
    throw new Error("solana-test-validator did not start");
  }
  assertLocalGenesis(url, genesisHash);
  return { url, genesisHash, mintSource: mint ? "mainnet-clone" : "local-same-decimals", decimals: mintDecimals(all[USDC_MINT]!), stop };
}
