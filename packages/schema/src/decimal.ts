// Fixed-point decimals on bigint with an explicit scale. Money, prices and sizes never use `number`.
// A Dec is { v, scale } meaning v / 10^scale. Rounding modes: 'down' rounds toward minus infinity (floor), 'up' toward
// plus infinity (ceil), 'half_even' to the nearest value with ties to even. 'down' never exceeds the exact value and
// 'up' never falls below it, for negative numbers too.

export type Rounding = "down" | "up" | "half_even";

export interface Dec {
  readonly v: bigint;
  readonly scale: number;
}

const DEC_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const MAX_SCALE = 36;

function checkScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) throw new RangeError(`Dec: scale must be an integer 0..${MAX_SCALE}`);
}

const POW10: bigint[] = [];
function pow10(n: number): bigint {
  if (n < 0) throw new RangeError("Dec: negative power");
  let p = POW10[n];
  if (p === undefined) {
    p = 10n ** BigInt(n);
    POW10[n] = p;
  }
  return p;
}

/** Integer division n / d with the given rounding (d != 0). */
export function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  if (d === 0n) throw new RangeError("Dec: division by zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let q = n / d; // truncates toward zero
  const r = n - q * d;
  if (r === 0n) return q;
  if (mode === "down") {
    if (n < 0n) q -= 1n;
    return q;
  }
  if (mode === "up") {
    if (n > 0n) q += 1n;
    return q;
  }
  // half_even on the magnitude
  const twice = (r < 0n ? -r : r) * 2n;
  const awayFromZero = n < 0n ? -1n : 1n;
  if (twice > d) return q + awayFromZero;
  if (twice < d) return q;
  return q % 2n === 0n ? q : q + awayFromZero;
}

function make(v: bigint, scale: number): Dec {
  checkScale(scale);
  return Object.freeze({ v, scale });
}

/** Parse a decimal string ("1.25", "-0.5", "3e-4") at a scale. Throws on extra digits unless a rounding is given. */
function parse(s: string, scale: number, rounding?: Rounding): Dec {
  checkScale(scale);
  if (typeof s !== "string") throw new TypeError("Dec.parse: expected a string");
  const m = DEC_RE.exec(s.trim());
  if (!m || (m[2] === "" && (m[3] === undefined || m[3] === ""))) throw new SyntaxError(`Dec.parse: not a decimal: ${JSON.stringify(s).slice(0, 40)}`);
  const sign = m[1] === "-" ? -1n : 1n;
  let digits = (m[2] ?? "") + (m[3] ?? "");
  let fracLen = (m[3] ?? "").length;
  const exp = m[4] ? Number(m[4]) : 0;
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) throw new RangeError("Dec.parse: exponent out of range");
  fracLen -= exp;
  if (digits === "") digits = "0";
  const n = BigInt(digits);
  // n / 10^fracLen, bring to `scale`
  let v: bigint;
  if (fracLen <= scale) {
    v = n * pow10(scale - fracLen);
  } else {
    const div = pow10(fracLen - scale);
    if (n % div !== 0n && !rounding) throw new RangeError(`Dec.parse: more than ${scale} decimals in ${JSON.stringify(s).slice(0, 40)}`);
    v = divRound(sign * n, div, rounding ?? "down");
    return make(v, scale);
  }
  return make(sign * v, scale);
}

function fromBigInt(v: bigint, scale: number): Dec {
  return make(v, scale);
}

function toString(d: Dec, opts?: { fixed?: boolean }): string {
  const neg = d.v < 0n;
  const abs = neg ? -d.v : d.v;
  let out: string;
  if (d.scale === 0) out = abs.toString();
  else {
    const s = abs.toString().padStart(d.scale + 1, "0");
    const int = s.slice(0, s.length - d.scale);
    let frac = s.slice(s.length - d.scale);
    if (!opts?.fixed) frac = frac.replace(/0+$/, "");
    out = frac ? `${int}.${frac}` : int;
  }
  return neg && abs !== 0n ? `-${out}` : out;
}

function rescale(d: Dec, scale: number, rounding: Rounding = "half_even"): Dec {
  checkScale(scale);
  if (scale === d.scale) return d;
  if (scale > d.scale) return make(d.v * pow10(scale - d.scale), scale);
  return make(divRound(d.v, pow10(d.scale - scale), rounding), scale);
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const s = Math.max(a.scale, b.scale);
  return [rescale(a, s).v, rescale(b, s).v, s];
}

function add(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return make(x + y, s);
}

function sub(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return make(x - y, s);
}

function neg(a: Dec): Dec {
  return make(-a.v, a.scale);
}

function abs(a: Dec): Dec {
  return a.v < 0n ? neg(a) : a;
}

/** a * b, result at `scale` with `rounding`. */
function mul(a: Dec, b: Dec, scale: number, rounding: Rounding = "half_even"): Dec {
  checkScale(scale);
  const raw = a.v * b.v; // at scale a.scale + b.scale
  const rs = a.scale + b.scale;
  if (scale >= rs) return make(raw * pow10(scale - rs), scale);
  return make(divRound(raw, pow10(rs - scale), rounding), scale);
}

/** a / b, result at `scale` with `rounding`. */
function div(a: Dec, b: Dec, scale: number, rounding: Rounding = "half_even"): Dec {
  checkScale(scale);
  if (b.v === 0n) throw new RangeError("Dec: division by zero");
  // a.v/10^as / (b.v/10^bs) = a.v * 10^bs / (b.v * 10^as); times 10^scale
  const e = scale + b.scale - a.scale;
  const num = e >= 0 ? a.v * pow10(e) : a.v;
  const den = e >= 0 ? b.v : b.v * pow10(-e);
  return make(divRound(num, den, rounding), scale);
}

function cmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function eq(a: Dec, b: Dec): boolean {
  return cmp(a, b) === 0;
}

function isZero(a: Dec): boolean {
  return a.v === 0n;
}

/** Round x to a multiple of a positive step. 'down' result <= x, 'up' result >= x, 'half_even' nearest. */
function roundToStep(x: Dec, step: Dec, mode: Rounding): Dec {
  if (step.v <= 0n) throw new RangeError("Dec.roundToStep: step must be positive");
  const [xv, sv, s] = align(x, step);
  const q = divRound(xv, sv, mode);
  return make(q * sv, s);
}

function min(a: Dec, b: Dec): Dec {
  return cmp(a, b) <= 0 ? a : b;
}

function max(a: Dec, b: Dec): Dec {
  return cmp(a, b) >= 0 ? a : b;
}

/** Count the decimals a decimal string carries ("0.001" -> 3). */
function decimalsOf(s: string): number {
  const m = DEC_RE.exec(s.trim());
  if (!m) throw new SyntaxError("Dec.decimalsOf: not a decimal");
  return Math.max(0, (m[3] ?? "").replace(/0+$/, "").length - (m[4] ? Number(m[4]) : 0));
}

export const Dec = {
  parse,
  fromBigInt,
  toString,
  rescale,
  add,
  sub,
  neg,
  abs,
  mul,
  div,
  cmp,
  eq,
  isZero,
  roundToStep,
  min,
  max,
  decimalsOf,
} as const;
