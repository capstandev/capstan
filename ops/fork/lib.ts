// Shared rig for ops/fork/every-tx.ts: the stack's ports and files, fresh in-memory test wallets (never printed,
// never anvil's default accounts), anvil helpers, Safe 1.4.1 transactions signed by fresh owners, forge runs and the
// report rows. Every write goes to the local anvil forks only; assertLocal refuses anything else.
import type { Hex } from "@capstan/schema";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { concat, createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, parseAbi, toHex, type Chain, type PublicClient, type TransactionReceipt } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const ROOT = resolve(import.meta.dir, "../..");
export const STATE = join(import.meta.dir, ".state");
export const PORTS = { api: 22410, ws: 22411, relay: 22412, mcp: 22413, facilitator: 22414, hl: 22420, lighterRh: 22421, lighter: 22422, pg: 22432, anvil: 22445, rpcCache: 22446, base: 22447, web: 22473, redis: 22479 } as const;
export const RHC = `http://127.0.0.1:${PORTS.anvil}`;
export const BASE = `http://127.0.0.1:${PORTS.base}`;
export const API = `http://127.0.0.1:${PORTS.api}/v1`;
export const DATABASE_URL = `postgres://capstan:capstan@127.0.0.1:${PORTS.pg}/capstan`;
export const REDIS_URL = `redis://127.0.0.1:${PORTS.redis}`;
export const FORGE = join(homedir(), ".foundry/bin/forge");
export const CAST = join(homedir(), ".foundry/bin/cast");
export const FORK_FILE_REL = "deployments/local/4663-fork.json";
export const FORK_FILE = join(ROOT, "contracts", FORK_FILE_REL);

export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Hex;
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex;
export const SAFE = {
  singletonL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762" as Hex,
  factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Hex,
  fallback: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" as Hex,
};

export function assertLocal(url: string): void {
  const h = new URL(url).hostname;
  if (h !== "127.0.0.1" && h !== "localhost") throw new Error(`every-tx only writes to the local fork, got ${h}`);
}

export const chainOf = (id: number, url: string): Chain => ({ id, name: `fork-${id}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
export const rhc = createPublicClient({ chain: chainOf(4663, RHC), transport: http(RHC) }) as PublicClient;
export const base = createPublicClient({ chain: chainOf(8453, BASE), transport: http(BASE) }) as PublicClient;

/** A fresh wallet held in memory for this run only. */
export function freshWallet(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

export function walletClient(acct: PrivateKeyAccount, url = RHC, chainId = 4663) {
  assertLocal(url);
  return createWalletClient({ account: acct, chain: chainOf(chainId, url), transport: http(url) });
}

export async function setBalance(addr: Hex, wei = 10n ** 19n, url = RHC): Promise<void> {
  assertLocal(url);
  await createTestClient({ mode: "anvil", transport: http(url) }).setBalance({ address: addr, value: wei });
}

export async function warp(seconds: number, url = RHC): Promise<void> {
  assertLocal(url);
  const tc = createTestClient({ mode: "anvil", transport: http(url) });
  await tc.increaseTime({ seconds });
  await tc.mine({ blocks: 1 });
}

export async function chainTime(pc: PublicClient = rhc): Promise<number> {
  return Number((await pc.getBlock()).timestamp);
}

export async function send(acct: PrivateKeyAccount, to: Hex, data: Hex, url = RHC, chainId = 4663): Promise<TransactionReceipt> {
  const wc = walletClient(acct, url, chainId);
  const pc = url === RHC ? rhc : base;
  const hash = await wc.sendTransaction({ to, data, chain: chainOf(chainId, url) });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`tx ${hash} reverted`);
  return rc;
}

const SAFE_ABI = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address indexed proxy, address singleton)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

export interface ForkSafe {
  address: Hex;
  owners: PrivateKeyAccount[];
  /** Run one call from the Safe with two owner signatures (threshold 2), sent by `sender`. */
  exec(to: Hex, data: Hex, sender: PrivateKeyAccount): Promise<TransactionReceipt>;
}

/** A Safe 1.4.1 (SafeL2 singleton, canonical factory), 2 of 3 fresh owners, made on the fork. */
export async function makeSafe(sender: PrivateKeyAccount): Promise<ForkSafe> {
  const owners = [freshWallet(), freshWallet(), freshWallet()];
  const init = encodeFunctionData({ abi: SAFE_ABI, functionName: "setup", args: [owners.map((o) => o.address), 2n, "0x0000000000000000000000000000000000000000", "0x", SAFE.fallback, "0x0000000000000000000000000000000000000000", 0n, "0x0000000000000000000000000000000000000000"] });
  const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const rc = await send(sender, SAFE.factory, encodeFunctionData({ abi: SAFE_ABI, functionName: "createProxyWithNonce", args: [SAFE.singletonL2, init, salt] }));
  const log = rc.logs.find((l) => l.address.toLowerCase() === SAFE.factory.toLowerCase());
  const address = (`0x${log!.topics[1]!.slice(26)}`) as Hex;
  const sorted = [...owners].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));
  return {
    address,
    owners,
    async exec(to, data, s) {
      const n = await rhc.readContract({ address, abi: SAFE_ABI, functionName: "nonce" });
      const h = await rhc.readContract({ address, abi: SAFE_ABI, functionName: "getTransactionHash", args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", n] });
      const sigs = await Promise.all(sorted.slice(0, 2).map((o) => o.sign({ hash: h })));
      return send(s, address, encodeFunctionData({ abi: SAFE_ABI, functionName: "execTransaction", args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", concat(sigs)] }));
    },
  };
}

/** Run a command; returns stdout, throws with the tail of the output on a non-zero exit. */
export function run(cmd: string[], o: { cwd?: string; env?: Record<string, string> } = {}): string {
  const p = Bun.spawnSync(cmd, { cwd: o.cwd ?? ROOT, env: { PATH: `${homedir()}/.foundry/bin:${homedir()}/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: homedir(), ...(o.env ?? {}) }, stdout: "pipe", stderr: "pipe" });
  const out = `${p.stdout.toString()}${p.stderr.toString()}`;
  if (p.exitCode !== 0) {
    const log = join(STATE, "logs", `failed-${Date.now()}.log`);
    writeFileSync(log, out);
    throw new Error(`${cmd.slice(0, 3).join(" ")} failed (exit ${p.exitCode}, log ${log}): ${out.split("\n").filter((l) => /error|fail|revert/i.test(l)).slice(-6).join(" | ")}`);
  }
  return out;
}

/** A throwaway keystore for this run (random password in a chmod 600 file under ops/fork/.state). */
export function runKeystore(dir: string, name: string): { path: string; passwordFile: string; address: Hex } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const passwordFile = join(dir, `${name}.password`);
  writeFileSync(passwordFile, Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex"), { mode: 0o600 });
  run([CAST, "wallet", "new", dir, name, "--unsafe-password", readFileSync(passwordFile, "utf8")]);
  const address = run([CAST, "wallet", "address", "--keystore", join(dir, name), "--password-file", passwordFile]).trim() as Hex;
  return { path: join(dir, name), passwordFile, address };
}

export function stateAddr(name: string): Hex {
  return readFileSync(join(STATE, "keys", `${name}.addr`), "utf8").trim() as Hex;
}

export interface Row {
  id: string;
  scenario: string;
  ref: string; // tx hash or request id
  gas: string;
  result: "pass" | "fail";
  receipt: string;
  check: string;
  error?: string;
}

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function totalSupply() view returns (uint256)",
]);

export function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

export function exists(p: string): boolean {
  return existsSync(p);
}

/** anvil snapshot / revert: a scenario that moves the fork clock far ahead puts it back, so later runs see real time. */
export async function snapshot(url = RHC): Promise<Hex> {
  assertLocal(url);
  return (await createTestClient({ mode: "anvil", transport: http(url) }).snapshot()) as Hex;
}

export async function revert(id: Hex, url = RHC): Promise<void> {
  assertLocal(url);
  await createTestClient({ mode: "anvil", transport: http(url) }).revert({ id });
}
