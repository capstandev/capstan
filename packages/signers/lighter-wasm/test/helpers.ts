// Shared test helpers: a deterministic RNG, random order and cancel fields, and the docker-backed native checker.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LighterCancelArgs, LighterChainId, LighterOrderArgs } from "../src/index";

export const PKG = join(import.meta.dir, "..");
export const CHAINS: LighterChainId[] = [304, 466324, 300];
export const ACCOUNT = 12345;
export const KEY_INDEX = 4;
/** A fixed tx expiry (ms) so a build and its hash agree across instances; the WASM never checks it against now. */
export const FIXED_EXPIRED_AT = 1_893_456_000_000;
const FIXED_ORDER_EXPIRY = 1_893_456_000_000 + 86_400_000;

/** mulberry32: small, fast, deterministic. */
export function rng(start: number): (max: number) => number {
  let a = start >>> 0;
  return (max: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

export function randomOrder(r: (m: number) => number, nonce: number): LighterOrderArgs {
  const tif = r(3) as 0 | 1 | 2;
  let behavior = r(4);
  const equality = r(2);
  if (behavior === 3 && equality === 1) behavior = 2;
  return {
    marketIndex: r(200),
    clientOrderIndex: r(1_000_000) + 1,
    baseAmount: r(1_000_000) + 1,
    price: r(10_000_000) + 1,
    isAsk: r(2) === 1,
    orderType: 0,
    timeInForce: tif,
    reduceOnly: r(2) === 1,
    triggerPrice: 0,
    orderExpiry: tif === 0 ? 0 : FIXED_ORDER_EXPIRY,
    integratorAccountIndex: 0,
    integratorTakerFee: 0,
    integratorMakerFee: 0,
    selfTradeBehaviorMode: behavior,
    selfTradeEqualityMode: equality,
    nonce,
    apiKeyIndex: KEY_INDEX,
    accountIndex: ACCOUNT,
    expiredAt: FIXED_EXPIRED_AT,
  };
}

export function randomCancel(r: (m: number) => number, nonce: number): LighterCancelArgs {
  return { marketIndex: r(200), orderIndex: r(1_000_000) + 1, nonce, apiKeyIndex: KEY_INDEX, accountIndex: ACCOUNT, expiredAt: FIXED_EXPIRED_AT };
}

/** Docker tests run when docker answers, unless LIGHTER_WASM_DOCKER=0. */
export function dockerAvailable(): boolean {
  if (process.env.LIGHTER_WASM_DOCKER === "0") return false;
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 15_000 });
  return r.status === 0 && r.stdout.trim().length > 0;
}

export interface ParitySummary {
  vectors: number;
  hash_match: number;
  sig_valid: number;
  cross_checked: number;
  cross_accepted: number;
  bad: number;
  failures: string[];
}

/** Run build/parity.sh on vectors {chain, txType, txInfo, txHash, pubKey}. */
export function runParity(vectors: { chain: number; txType: number; txInfo: string; txHash: string; pubKey: string }[]): ParitySummary {
  const dir = mkdtempSync(join(tmpdir(), "lighter-parity-"));
  const file = join(dir, "vectors.json");
  writeFileSync(file, JSON.stringify(vectors));
  const r = spawnSync("bash", [join(PKG, "build/parity.sh"), file], { encoding: "utf8", timeout: 600_000 });
  if (r.status !== 0) throw new Error(`parity.sh failed (${r.status}): ${r.stderr.slice(-2000)}`);
  const line = r.stdout.trim().split("\n").pop()!;
  return JSON.parse(line) as ParitySummary;
}

export function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}
