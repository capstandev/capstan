// API key index choice. One rule for both configs (DECISIONS #22): never 0-3 (Lighter's own apps), 157 (reserved on
// RH, free on mainnet, skipped anyway) or 255 (the "all keys" sentinel). Usable: 4-156 and 158-254, 250 slots.
import { CapstanError, LIGHTER_RESERVED_KEY_INDEXES } from "@capstan/schema";

export const RESERVED_KEY_INDEXES = LIGHTER_RESERVED_KEY_INDEXES;
export const MIN_KEY_INDEX = 4;
export const MAX_KEY_INDEX = 254;
const RESERVED = new Set<number>(RESERVED_KEY_INDEXES);

export function isUsableKeyIndex(i: number): boolean {
  return Number.isInteger(i) && i >= MIN_KEY_INDEX && i <= MAX_KEY_INDEX && !RESERVED.has(i);
}

/** Lowest free index in 4..156 then 158..254. Throws LIGHTER_KEY_INDEX_EXHAUSTED when all 250 are taken. */
export function pickKeyIndex(used: number[]): number {
  const taken = new Set(used);
  for (let i = MIN_KEY_INDEX; i <= MAX_KEY_INDEX; i++) if (!RESERVED.has(i) && !taken.has(i)) return i;
  throw new CapstanError("LIGHTER_KEY_INDEX_EXHAUSTED");
}

const ZERO_KEY = /^0+$/;

/** Indexes holding a registered key. The venue lists unused slots with an all-zero public key: those are free. */
export function usedKeyIndexes(keys: { apiKeyIndex: number; publicKey: string }[]): number[] {
  return keys.filter((k) => k.publicKey !== "" && !ZERO_KEY.test(k.publicKey.replace(/^0x/i, ""))).map((k) => k.apiKeyIndex);
}
