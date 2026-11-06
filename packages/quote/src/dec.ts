// Decimal helpers for the quote engine. Prices and sizes are decimal strings; bps are numbers with at most 4 decimals,
// always produced by exact decimal arithmetic and a half-even rounding at the last step.
import { Dec, type Rounding } from "@capstan/schema";

export const S = 18;
export const d = (s: string, r: Rounding = "half_even") => Dec.parse(s, S, r);
export const str = (x: Dec) => Dec.toString(x);
export const ZERO = Dec.parse("0", S);
export const BPS = Dec.parse("10000", 0);

/** A decimal to a bps number with 4 decimals (half-even); -0 becomes 0. */
export function toBps(x: Dec): number {
  const n = Number(Dec.toString(Dec.rescale(x, 4, "half_even")));
  return n === 0 ? 0 : n;
}

/** Exact sum of bps numbers that each carry at most 4 decimals. */
export function sumBps(xs: number[]): number {
  let t = 0n;
  for (const x of xs) t += BigInt(Math.round(x * 10_000));
  const n = Number(t) / 10_000;
  return n === 0 ? 0 : n;
}

/** Decimal places a step such as "0.001" carries. */
export function stepDecimals(step: string): number {
  return Dec.decimalsOf(step);
}

/** A non-negative finite number as a decimal string the parser accepts (no float artefacts for short values). */
export function numStr(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError("not finite");
  return String(n);
}
