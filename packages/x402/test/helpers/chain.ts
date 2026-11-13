// Test helpers: start a throwaway anvil (stopped by PID), compile the Solidity mocks with forge, deploy them, and
// give a fork account a token balance by writing the storage slot balanceOf reads (found with eth_createAccessList).
import type { Hex } from "@capstan/schema";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, keccak256, numberToHex, pad, parseAbi, toHex, type Abi, type Chain, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const FORGE = join(homedir(), ".foundry/bin/forge");
export const ANVIL = join(homedir(), ".foundry/bin/anvil");
export const haveFoundry = existsSync(FORGE) && existsSync(ANVIL);

/** Lane ports (README lane table, base 21800): the acceptance fork is 21845. Tests never use a fixed port: each one
 * starts its own anvil with `--port 0` and reads the port anvil chose (another worktree or agent on this host can hold
 * any fixed port, and a test would then talk to that stranger's anvil). */
export const LANE_PORTS = { fork: 21845 } as const;

/** Budget for anvil to print its port and answer eth_chainId; generous for a loaded host. */
const ANVIL_START_MS = 60_000;

export interface Anvil {
  url: string;
  proc: ChildProcess;
  stop(): Promise<void>;
}

/** Start a throwaway anvil on 127.0.0.1 and a port the OS picks; stopped later by its own handle (never by pattern). */
export async function startAnvil(opts: { forkUrl?: string; chainId?: number } = {}): Promise<Anvil> {
  const args = ["--host", "127.0.0.1", "--port", "0"];
  if (opts.forkUrl) args.push("--fork-url", opts.forkUrl);
  if (opts.chainId) args.push("--chain-id", String(opts.chainId));
  const proc = spawn(ANVIL, args, { stdio: ["ignore", "pipe", "pipe"] });
  const kill = () => {
    if (proc.exitCode === null) proc.kill("SIGTERM");
  };
  // anvil logs every RPC call to stdout: keep reading it for the whole run so a full pipe never blocks it
  let head = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      kill();
      reject(new Error(`anvil did not print its port in ${ANVIL_START_MS} ms: ${head.slice(-400)}`));
    }, ANVIL_START_MS);
    const onData = (b: Buffer) => {
      if (head.length < 64_000) head += b.toString("utf8");
      const m = /Listening on 127\.0\.0\.1:(\d+)/.exec(head);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`anvil exited (${code}) before listening: ${head.slice(-400)}`));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + ANVIL_START_MS;
  for (;;) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(5_000) });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline || proc.exitCode !== null) {
      kill();
      throw new Error(`anvil on ${port} did not answer`);
    }
    await Bun.sleep(100);
  }
  return {
    url,
    proc,
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once("exit", r));
        proc.kill("SIGTERM"); // our own child, by handle (never by pattern)
        await exited;
      }
    },
  };
}

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

/** Compile packages/x402/test/mocks with forge into a temp dir; returns contract name -> artifact. */
export function compileMocks(): Record<string, Artifact> {
  const dir = join(import.meta.dir, "..", "mocks");
  const out = mkdtempSync(join(tmpdir(), "capstan-x402-mocks-"));
  try {
    const build = (offline: boolean) =>
      spawnSync(FORGE, ["build", "--root", dir, "--contracts", ".", "--out", join(out, "out"), "--cache-path", join(out, "cache"), "--use", "0.8.28", ...(offline ? ["--offline"] : [])], { encoding: "utf8", timeout: 60_000 });
    let r = build(true);
    // a fresh host (the CI runner) has no solc yet: forge installs the pinned 0.8.28 once, then every build is offline
    for (let i = 0; i < 2 && r.status !== 0 && /no compiler versions are available|not installed|offline|download/i.test(`${r.stderr}${r.stdout}`); i++) r = build(false);
    if (r.status !== 0) throw new Error(`forge build failed: ${r.error?.message ?? ""} ${r.stderr || r.stdout}`);
    const res: Record<string, Artifact> = {};
    for (const name of ["MockGood3009", "MockNo3009", "MockFacetRemoved", "MockDomainV2"]) {
      const j = JSON.parse(readFileSync(join(out, "out", "DetectMocks.sol", `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
      res[name] = { abi: j.abi, bytecode: j.bytecode.object };
    }
    return res;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** A fresh account derived from a public label (worthless by design; used only on local anvil chains). */
export function labelAccount(label: string) {
  return privateKeyToAccount(keccak256(toHex(`capstan-x402-test:${label}`))); // test-key (public label)
}

export function localChain(id: number, url: string): Chain {
  return { id, name: `local-${id}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } };
}

export async function fund(url: string, address: Hex, wei = 10n ** 20n): Promise<void> {
  const tc = createTestClient({ mode: "anvil", transport: http(url) });
  await tc.setBalance({ address, value: wei });
}

export async function deploy(url: string, chainId: number, art: Artifact, deployerLabel = "deployer"): Promise<Hex> {
  const acct = labelAccount(deployerLabel);
  await fund(url, acct.address);
  const chain = localChain(chainId, url);
  const wc = createWalletClient({ account: acct, chain, transport: http(url) });
  const pc = createPublicClient({ chain, transport: http(url) });
  const hash = await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [] });
  const rc = await pollReceipt(pc, hash);
  if (rc.status !== "success" || !rc.contractAddress) throw new Error("deploy failed");
  return rc.contractAddress;
}

/** Poll the receipt: viem's waitForTransactionReceipt can miss anvil's single block and wait 180 s. */
export async function pollReceipt(pc: { getTransactionReceipt(a: { hash: Hex }): Promise<{ status: string; contractAddress?: Hex | null }> }, hash: Hex, budgetMs = 30_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      return await pc.getTransactionReceipt({ hash });
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`no receipt for ${hash} in ${budgetMs} ms: ${(e as Error).message}`);
    }
    await Bun.sleep(50);
  }
}

const EIP1967_SLOTS = [
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", // not-a-key (EIP-1967 implementation slot)
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", // not-a-key (EIP-1967 admin slot)
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50", // not-a-key (EIP-1967 beacon slot)
];
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** Set `holder`'s token balance on a fork by finding the storage slot balanceOf reads and writing it. */
export async function setTokenBalance(url: string, token: Hex, holder: Hex, amount: bigint): Promise<void> {
  const pc = createPublicClient({ transport: http(url) }) as PublicClient;
  const data = encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [holder] });
  const res = (await pc.request({ method: "eth_createAccessList" as never, params: [{ to: token, data }, "latest"] as never })) as { accessList: { address: Hex; storageKeys: Hex[] }[] };
  const value = pad(numberToHex(amount), { size: 32 });
  for (const entry of res.accessList) {
    for (const key of entry.storageKeys) {
      if (EIP1967_SLOTS.includes(key.toLowerCase())) continue; // never touch proxy slots
      const before = await pc.getStorageAt({ address: entry.address, slot: key });
      await pc.request({ method: "anvil_setStorageAt" as never, params: [entry.address, key, value] as never });
      let bal: bigint | null = null;
      try {
        bal = await pc.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [holder] });
      } catch {
        bal = null; // that slot was routing or proxy state: restore it below
      }
      if (bal === amount) return;
      await pc.request({ method: "anvil_setStorageAt" as never, params: [entry.address, key, before ?? pad("0x0", { size: 32 })] as never });
    }
  }
  throw new Error("could not find the balance slot");
}

export async function balanceOf(url: string, token: Hex, holder: Hex): Promise<bigint> {
  const pc = createPublicClient({ transport: http(url) });
  return pc.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [holder] });
}
