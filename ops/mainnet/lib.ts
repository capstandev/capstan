// Shared helpers for the mainnet launch package (ops/mainnet). The fork dry run writes ONLY to a loopback anvil:
// localRpc() refuses every other URL before a client exists (R4). Read-only checks (live-check, builder-balances)
// take any RPC because they never sign.
import type { Hex } from "@capstan/schema";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, type Chain, type PublicClient } from "viem";

export const ROOT = resolve(import.meta.dir, "../..");

/** The dry run's own ports (lane mainnet): anvil 22545, rpc-cache 22546. Env overrides for tests only. */
export const DRY_RUN_PORTS = {
  anvil: Number(process.env.DRYRUN_ANVIL_PORT ?? 22545),
  cache: Number(process.env.DRYRUN_CACHE_PORT ?? 22546),
} as const;

export const MAINNET_CHAIN_ID = 4663;
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Hex;
export const SAFE_141 = {
  singleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a" as Hex,
  singletonL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762" as Hex,
  factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Hex,
  fallback: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" as Hex,
  proxyCodehash: "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c" as Hex, // not-a-key (SafeProxy 1.4.1 runtime codehash)
  guardSlot: "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as Hex, // not-a-key (keccak of guard_manager.guard.address)
};

/** True only for http://127.0.0.1:<port> or http://localhost:<port> with a port from `ports`. */
export function isDryRunRpc(url: string, ports: readonly number[] = [DRY_RUN_PORTS.anvil, DRY_RUN_PORTS.cache]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return false;
  if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "")) return false;
  return ports.includes(Number(u.port));
}

/** A client for the dry-run anvil; throws for any URL that is not the loopback fork (no client is ever made). */
export function localRpc(url: string, chainId = MAINNET_CHAIN_ID): PublicClient {
  if (!isDryRunRpc(url)) throw new Error(`refuse: ${url} is not the local dry-run anvil or rpc-cache (127.0.0.1:${DRY_RUN_PORTS.anvil} or :${DRY_RUN_PORTS.cache})`);
  return createPublicClient({ chain: chainOf(chainId, url), transport: http(url) }) as PublicClient;
}

export const chainOf = (id: number, url: string): Chain => ({ id, name: `chain-${id}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });

export function sha256File(p: string): string {
  return existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent";
}

/** Parse `--name value` pairs. */
export function args(argv: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) o[a.slice(2)] = "1";
      else {
        o[a.slice(2)] = v;
        i++;
      }
    }
  }
  return o;
}

/** wei -> ETH string with 9 decimals (enough for gas at 0.02 gwei). */
export function eth(wei: bigint, digits = 9): string {
  const neg = wei < 0n;
  const w = neg ? -wei : wei;
  const s = (w * 10n ** BigInt(digits) + 5n * 10n ** 17n) / 10n ** 18n; // round half up
  const int = s / 10n ** BigInt(digits);
  const frac = (s % 10n ** BigInt(digits)).toString().padStart(digits, "0");
  return `${neg ? "-" : ""}${int}.${frac}`;
}

export function fmt(n: bigint | number): string {
  return BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Gas x price x 1.3, rounded up to a whole wei (R2, the funding rule). */
export function withHeadroom(gas: bigint, priceWei: bigint, pct = 130n): bigint {
  return (gas * priceWei * pct + 99n) / 100n;
}
