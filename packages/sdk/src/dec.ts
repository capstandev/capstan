// Exact decimal strings for the payload check. Amounts never pass through a float.
export interface D {
  v: bigint;
  s: number; // scale
}

const RE = /^(0|[1-9]\d*)(\.\d+)?$/;

export function isDec(x: unknown): x is string {
  return typeof x === "string" && RE.test(x);
}

export function dec(x: string): D {
  if (!isDec(x)) throw new Error("not a plain decimal string");
  const [i, f = ""] = x.split(".");
  return { v: BigInt(i! + f), s: f.length };
}

function align(a: D, b: D): [bigint, bigint] {
  const s = Math.max(a.s, b.s);
  return [a.v * 10n ** BigInt(s - a.s), b.v * 10n ** BigInt(s - b.s)];
}

export function cmp(a: string, b: string): number {
  const [x, y] = align(dec(a), dec(b));
  return x < y ? -1 : x > y ? 1 : 0;
}

export const eqDec = (a: string, b: string): boolean => isDec(a) && isDec(b) && cmp(a, b) === 0;

/** Integer venue units of a decimal, rounded "down" or "up". */
export function toUnits(x: string, decimals: number, round: "down" | "up"): bigint {
  const d = dec(x);
  if (d.s <= decimals) return d.v * 10n ** BigInt(decimals - d.s);
  const div = 10n ** BigInt(d.s - decimals);
  const q = d.v / div;
  return round === "up" && d.v % div !== 0n ? q + 1n : q;
}

/** x * (10000 + bps) / 10000 (buy bound) or x * (10000 - bps) / 10000 (sell bound), at 18 decimals, as a string. */
export function bound(ref: string, bps: number, side: "buy" | "sell"): string {
  if (!Number.isFinite(bps) || bps < 0) throw new Error("bps must be non-negative");
  const r = dec(ref);
  const scaledBps = BigInt(Math.round(bps * 1e6)); // bps to 6 decimals
  const f = side === "buy" ? 10_000_000_000n + scaledBps : 10_000_000_000n - scaledBps; // 10000 * 1e6
  const num = r.v * f * 10n ** 18n;
  const den = 10n ** BigInt(r.s) * 10_000_000_000n;
  const q = side === "buy" ? num / den + (num % den === 0n ? 0n : 1n) : num / den; // loosest: round away from the ref
  const s = q.toString().padStart(19, "0");
  const out = `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/0+$/, "").replace(/\.$/, "");
  return out === "" ? "0" : out;
}

export function fromUnits(u: bigint | number, decimals: number): string {
  const v = typeof u === "bigint" ? u : BigInt(u);
  if (decimals === 0) return v.toString();
  const s = v.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** a * b for decimal strings (notional upper bounds). */
export function mul(a: string, b: string): string {
  const x = dec(a);
  const y = dec(b);
  return fromUnits(x.v * y.v, x.s + y.s);
}
