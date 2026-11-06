// Local anvil helpers for the receipt and anchor tests (ANVIL_URL, chain 31337 only). Contracts are deployed from an
// impersonated, freshly labelled address (no key at all); the poster is the core dev signer, whose key is derived from
// a public label and which refuses every chain but 31337. Never pointed at a real network.
import { devSigner, type ServiceSigner } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, encodeAbiParameters, http, keccak256, toHex, type PublicClient } from "viem";

export const ANVIL_URL = process.env.ANVIL_URL;
const CONTRACTS = join(import.meta.dir, "../../../contracts");

export function anvilClient(url = ANVIL_URL!): PublicClient {
  return createPublicClient({ transport: http(url), pollingInterval: 50 }) as PublicClient;
}

/** A labelled address with no key (impersonated on anvil). */
export const labelAddress = (label: string): Hex => `0x${keccak256(toHex(`capstan-anvil:${label}`)).slice(26)}` as Hex;

export function anchorBytecode(): Hex {
  const art = join(CONTRACTS, "out/CapstanReceiptAnchor.sol/CapstanReceiptAnchor.json");
  if (!existsSync(art)) {
    const forge = existsSync(join(homedir(), ".foundry/bin/forge")) ? join(homedir(), ".foundry/bin/forge") : "forge";
    const r = spawnSync(forge, ["build"], { cwd: CONTRACTS, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`forge build failed: ${r.stderr.slice(0, 400)}`);
  }
  return (JSON.parse(readFileSync(art, "utf8")) as { bytecode: { object: Hex } }).bytecode.object;
}

export async function fund(rpc: PublicClient, addr: Hex, wei = 10n ** 19n): Promise<void> {
  await rpc.request({ method: "anvil_setBalance" as never, params: [addr, toHex(wei)] as never });
}

/** Send a transaction from an impersonated address (anvil only). */
export async function sendAs(rpc: PublicClient, from: Hex, tx: { to?: Hex; data: Hex }): Promise<{ hash: Hex; contractAddress: Hex | null; blockNumber: bigint }> {
  await fund(rpc, from);
  await rpc.request({ method: "anvil_impersonateAccount" as never, params: [from] as never });
  const hash = (await rpc.request({ method: "eth_sendTransaction" as never, params: [{ from, ...tx }] as never })) as Hex;
  await rpc.request({ method: "anvil_stopImpersonatingAccount" as never, params: [from] as never });
  const rc = await rpc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`tx ${hash} reverted`);
  return { hash, contractAddress: (rc.contractAddress as Hex | null) ?? null, blockNumber: rc.blockNumber };
}

/** Deploy CapstanReceiptAnchor(poster) on anvil. */
export async function deployAnchor(rpc: PublicClient, poster: Hex, label: string): Promise<{ address: Hex; block: bigint }> {
  const args = encodeAbiParameters([{ type: "address" }], [poster]).slice(2);
  const r = await sendAs(rpc, labelAddress(`deployer:${label}`), { data: `${anchorBytecode()}${args}` as Hex });
  return { address: r.contractAddress!, block: r.blockNumber };
}

/** A funded poster signer for one test file (dev signer: chain 31337 only). */
export async function posterFor(rpc: PublicClient, label: string): Promise<ServiceSigner> {
  const s = devSigner(31337, `capstan-anvil-poster:${label}`);
  await fund(rpc, s.address);
  return s;
}

/** Hours that are over on anvil's clock for a test that runs "now" at `at`. */
export const hourOf = (d: Date): number => Math.floor(d.getTime() / 3_600_000);

const POST_ROOT_ABI = [
  { type: "function", name: "postRoot", stateMutability: "nonpayable", inputs: [{ type: "uint64" }, { type: "bytes32" }, { type: "uint32" }], outputs: [] },
] as const;

/** Post a root straight from a signer (used to plant roots in tests). */
export async function postRootDirect(rpc: PublicClient, signer: ServiceSigner, anchor: Hex, hour: number, root: Hex, count: number): Promise<Hex> {
  const { encodeFunctionData } = await import("viem");
  const data = encodeFunctionData({ abi: POST_ROOT_ABI, functionName: "postRoot", args: [BigInt(hour), root, count] });
  const nonce = await rpc.getTransactionCount({ address: signer.address, blockTag: "pending" });
  const block = await rpc.getBlock();
  const raw = await signer.signTransaction!({ chainId: 31337, to: anchor, data, nonce, gas: 200_000n, maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + 1n, maxPriorityFeePerGas: 0n });
  const hash = await rpc.sendRawTransaction({ serializedTransaction: raw });
  const rc = await rpc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error("postRoot reverted");
  return hash;
}
