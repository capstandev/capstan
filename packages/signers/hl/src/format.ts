// Price and size formatting (venue-hyperliquid.md section 3): a perp price has at most 5 significant figures and at
// most 6 - szDecimals decimals; integer prices are always allowed; sizes round DOWN to szDecimals; trailing zeros are
// stripped before signing. Pure decimal-string arithmetic on bigint; no float ever touches a price.

export type PriceRounding = "up" | "down" | "nearest";
export const MAX_SIG_FIGS = 5;
export const PERP_MAX_DECIMALS = 6;

interface Parsed {
  v: bigint; // value * 10^scale, non-negative
  scale: number;
}

function parse(x: string, what: string): Parsed {
  if (typeof x !== "string" || !/^\d+(\.\d+)?$/.test(x)) throw new Error(`hl-signer: ${what} must be a non-negative decimal string, got ${String(x)}`);
  const [i, f = ""] = x.split(".");
  return { v: BigInt(i! + f), scale: f.length };
}

function render(v: bigint, scale: number): string {
  let s = v.toString().padStart(scale + 1, "0");
  if (scale > 0) s = `${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

function roundTo(p: Parsed, decimals: number, mode: PriceRounding): bigint {
  if (p.scale <= decimals) return p.v * 10n ** BigInt(decimals - p.scale);
  const d = 10n ** BigInt(p.scale - decimals);
  const q = p.v / d;
  const r = p.v % d;
  if (r === 0n) return q;
  if (mode === "down") return q;
  if (mode === "up") return q + 1n;
  return r * 2n >= d ? q + 1n : q; // nearest, ties away from zero
}

/** Decimals a price of this size may carry: min(6 - szDecimals, the 5-significant-figure limit). */
export function allowedPriceDecimals(px: string, szDecimals: number): number {
  const maxDec = PERP_MAX_DECIMALS - szDecimals;
  const [i, f = ""] = px.split(".");
  const intPart = i!.replace(/^0+/, "");
  let sigLimit: number;
  if (intPart.length > 0) sigLimit = Math.max(0, MAX_SIG_FIGS - intPart.length);
  else {
    const lead = /^0*/.exec(f)![0].length;
    sigLimit = lead + MAX_SIG_FIGS;
  }
  return Math.max(0, Math.min(maxDec, sigLimit));
}

/**
 * Round a price to what the venue accepts. `round` picks the direction: buys pass "up", sells "down" (a protective
 * limit then moves at most one tick in the permissive direction), default "nearest".
 */
export function formatPrice(px: string, szDecimals: number, round: PriceRounding = "nearest"): string {
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > PERP_MAX_DECIMALS) throw new Error(`hl-signer: szDecimals out of range: ${szDecimals}`);
  const p = parse(px, "price");
  if (p.v === 0n) throw new Error("hl-signer: price must be positive");
  // Integer prices are always allowed, whatever their significant figures.
  if (p.scale === 0 || p.v % 10n ** BigInt(p.scale) === 0n) return (p.v / 10n ** BigInt(p.scale)).toString();
  let dec = allowedPriceDecimals(px, szDecimals);
  let v = roundTo(p, dec, round);
  // Rounding up can add a digit (9.99995 -> 10.0000); re-check the significant-figure limit on the result.
  for (;;) {
    const s = render(v, dec);
    const d2 = allowedPriceDecimals(s, szDecimals);
    const sDec = s.includes(".") ? s.split(".")[1]!.length : 0;
    if (sDec <= d2) {
      if (v === 0n) throw new Error(`hl-signer: price ${px} rounds to zero`);
      return s;
    }
    v = roundTo(parse(s, "price"), d2, round);
    dec = d2;
  }
}

/** Round a size DOWN to szDecimals and strip trailing zeros. Refuses a size that rounds to zero. */
export function formatSize(sz: string, szDecimals: number): string {
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > PERP_MAX_DECIMALS) throw new Error(`hl-signer: szDecimals out of range: ${szDecimals}`);
  const p = parse(sz, "size");
  const v = roundTo(p, szDecimals, "down");
  if (v === 0n) throw new Error(`hl-signer: size ${sz} rounds to zero at ${szDecimals} decimals`);
  return render(v, szDecimals);
}
