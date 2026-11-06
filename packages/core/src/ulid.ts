// Monotonic ULID (Crockford base32, 48-bit ms time + 80-bit randomness). No dependency.
// Within one millisecond the random part increments by one, so ids made in the same ms still sort in call order.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

let lastTime = -1;
let lastRand: number[] = []; // 16 base32 digits

function randomDigits(): number[] {
  const bytes = crypto.getRandomValues(new Uint8Array(RAND_LEN));
  return Array.from(bytes, (b) => b & 31);
}

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function increment(d: number[]): number[] {
  const out = d.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 31) {
      out[i] = out[i]! + 1;
      return out;
    }
    out[i] = 0;
  }
  throw new Error("ulid: random part overflowed within one millisecond");
}

export function ulid(nowMs: number = Date.now()): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIME) throw new RangeError("ulid: time out of range");
  let ms = nowMs;
  if (ms <= lastTime) {
    // same ms (or a clock step back): keep the last time and increment, so order holds
    ms = lastTime;
    lastRand = increment(lastRand);
  } else {
    lastTime = ms;
    lastRand = randomDigits();
  }
  return encodeTime(ms) + lastRand.map((d) => ALPHABET[d]).join("");
}

/** Milliseconds encoded in a ULID. */
export function ulidTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, TIME_LEN)) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new SyntaxError("ulid: bad character");
    t = t * 32 + v;
  }
  return t;
}
